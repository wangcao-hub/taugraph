import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGraph, isRetryable } from "../src/index.js";
import { LLMNode } from "../src/nodes/index.js";
import { fromOpenAIToolCalls, HTTPError, openAICompatible, toOpenAIMessages } from "../src/openai/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI-compatible adapter", () => {
  const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  const pngURL = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };
  const fn = (id: string, name: string) => ({ id, type: "function", function: { name, arguments: "{}" } });

  it("sends tools, tool choice, tool calls and tool results in OpenAI's shape", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        model: "m",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "weather", arguments: '{"city":"上海"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    });
    const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
    const response = await model.complete(
      {
        messages: [
          { role: "user", content: "天气" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "weather", arguments: { city: "南京" } }] },
          { role: "tool", toolCallId: "c1", content: "晴" },
        ],
        tools: [{ name: "weather", description: "Weather", inputSchema: { type: "object" } }],
        toolChoice: { name: "weather" },
      },
      { signal: new AbortController().signal },
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object" } } },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "weather" } });
    expect(body.messages).toEqual([
      { role: "user", content: "天气" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"南京"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "晴" },
    ]);
    expect(response).toMatchObject({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c2", name: "weather", arguments: { city: "上海" } }],
    });
  });

  it("marks arguments it cannot read instead of guessing", () => {
    expect(
      fromOpenAIToolCalls([
        { id: "a", function: { name: "t", arguments: "{not json" } },
        { id: "b", function: { name: "t", arguments: "[1]" } },
        { function: { name: "t", arguments: "" } },
      ]),
    ).toEqual([
      { id: "a", name: "t", arguments: {}, parseError: "arguments are not valid JSON" },
      { id: "b", name: "t", arguments: {}, parseError: "arguments are not a JSON object" },
      { id: "call_1_2", name: "t", arguments: {} },
    ]);
    expect(toOpenAIMessages([{ role: "system", content: "s" }])).toEqual([{ role: "system", content: "s" }]);
  });

  it("sends images in user messages, and moves images from tool results into a user message after them", () => {
    expect(
      toOpenAIMessages([
        { role: "user", content: [{ type: "text", text: "比较" }, png, { type: "image", url: "https://x/a.jpg" }] },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "shot", arguments: {} },
            { id: "c2", name: "shot", arguments: {} },
            { id: "c3", name: "t", arguments: {} },
          ],
        },
        { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "页面" }, png] },
        { role: "tool", toolCallId: "c2", content: [png] },
        { role: "tool", toolCallId: "c3", content: "ok" },
        { role: "assistant", content: "好" },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "比较" }, pngURL, { type: "image_url", image_url: { url: "https://x/a.jpg" } }],
      },
      { role: "assistant", content: null, tool_calls: [fn("c1", "shot"), fn("c2", "shot"), fn("c3", "t")] },
      { role: "tool", tool_call_id: "c1", content: "页面" },
      { role: "tool", tool_call_id: "c2", content: "(image)" },
      { role: "tool", tool_call_id: "c3", content: "ok" },
      {
        role: "user",
        content: [
          { type: "text", text: "Images from tool call c1:" },
          pngURL,
          { type: "text", text: "Images from tool call c2:" },
          pngURL,
        ],
      },
      { role: "assistant", content: "好" },
    ]);
  });

  it("reads image references with resolveImage when it sends a request", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "猫" } }] });
    });
    const asked: string[] = [];
    const model = openAICompatible({
      baseURL: "http://x/v1",
      model: "m",
      resolveImage: (url) => {
        asked.push(url);
        return { type: "image", data: "QUJD", mimeType: "image/jpeg" };
      },
    });
    const signal = new AbortController().signal;
    const content = [
      { type: "image" as const, url: "media:a" },
      { type: "image" as const, url: "https://x/b.png" },
    ];
    await model.complete({ messages: [{ role: "user", content }] }, { signal });
    expect(asked).toEqual(["media:a"]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
          { type: "image_url", image_url: { url: "https://x/b.png" } },
        ],
      },
    ]);
    const plain = openAICompatible({ baseURL: "http://x/v1", model: "m" });
    await expect(plain.complete({ messages: [{ role: "user", content }] }, { signal })).rejects.toThrow(
      'Image "media:a" needs resolveImage to be read',
    );
    expect(() => toOpenAIMessages([{ role: "user", content }])).toThrow(
      'Image "media:a" cannot be sent as a URL; make resolveImage return { data, mimeType } or an http(s) URL',
    );
    const toURL = openAICompatible({
      baseURL: "http://x/v1",
      model: "m",
      resolveImage: () => ({ type: "image", url: "media:b" }),
    });
    await expect(toURL.complete({ messages: [{ role: "user", content }] }, { signal })).rejects.toThrow(
      'Image "media:b" cannot be sent as a URL; make resolveImage return { data, mimeType } or an http(s) URL',
    );
  });

  it("numbers missing call ids by round and tells the model which results are errors", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        choices: [{ message: { content: null, tool_calls: [{ function: { name: "t", arguments: "{}" } }] } }],
      }),
    );
    const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
    const response = await model.complete(
      {
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_1_0", name: "t", arguments: {} }] },
          { role: "tool", toolCallId: "call_1_0", content: "boom", isError: true },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(response.toolCalls?.[0]?.id).toBe("call_2_0");
    expect(
      toOpenAIMessages([
        { role: "tool", toolCallId: "a", content: "boom", isError: true },
        { role: "tool", toolCallId: "b", content: "Error: boom", isError: true },
      ]),
    ).toEqual([
      { role: "tool", tool_call_id: "a", content: "Error: boom" },
      { role: "tool", tool_call_id: "b", content: "Error: boom" },
    ]);
  });

  it("asks for a reasoning level, reads what the model thought, and sends its own reasoning back", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        choices: [{ message: { content: "好", reasoning_content: "先想想" } }],
        usage: { prompt_tokens: 1, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 7 } },
      });
    });
    const signal = new AbortController().signal;
    const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
    const mine = {
      role: "assistant" as const,
      content: "a",
      model: "openai-compatible:m",
      reasoning: [{ text: "one" }, { text: "", signature: "x", redacted: true }, { text: "two" }],
    };
    const theirs = { role: "assistant" as const, content: "b", model: "other", reasoning: [{ text: "secret" }] };
    const unknown = { role: "assistant" as const, content: "c", reasoning: [{ text: "?" }] };
    const response = await model.complete(
      { messages: [{ role: "user", content: "q" }, mine, theirs, unknown], reasoning: "off" },
      { signal },
    );
    expect(bodies[0]?.reasoning_effort).toBe("none");
    expect(bodies[0]?.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_content: "one\ntwo" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
    ]);
    expect(response.reasoning).toEqual([{ text: "先想想" }]);
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 9, reasoningTokens: 7 });
    await model.complete({ messages: [{ role: "user", content: "q" }], reasoning: "high" }, { signal });
    expect(bodies[1]?.reasoning_effort).toBe("high");
    await model.complete({ messages: [{ role: "user", content: "q" }] }, { signal });
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
    expect(
      toOpenAIMessages(
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "t", arguments: {} }],
            reasoning: [{ text: "r" }],
            model: "me",
          },
        ],
        "me",
      ),
    ).toEqual([{ role: "assistant", content: null, tool_calls: [fn("c1", "t")], reasoning_content: "r" }]);
  });

  it("takes reasoning parameters for providers with their own switch, and reads the reasoning field", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "好", reasoning: "thinking" } }] });
    });
    const signal = new AbortController().signal;
    const model = openAICompatible({
      baseURL: "http://x/v1",
      model: "m",
      reasoningParams: (level) =>
        level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" } },
    });
    const response = await model.complete({ messages: [{ role: "user", content: "q" }], reasoning: "off" }, { signal });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(response.reasoning).toEqual([{ text: "thinking" }]);
    await model.complete(
      { messages: [{ role: "user", content: "q" }], reasoning: "off", extra: { thinking: { type: "enabled" } } },
      { signal },
    );
    expect(body.thinking).toEqual({ type: "enabled" }); // extra wins
  });

  it("keeps its own reasoning to itself when sendReasoning is false", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "好" } }] });
    });
    const model = openAICompatible({ baseURL: "http://x/v1", model: "m", sendReasoning: false });
    const mine = { role: "assistant" as const, content: "a", model: "openai-compatible:m", reasoning: [{ text: "r" }] };
    await model.complete(
      { messages: [{ role: "user", content: "q" }, mine] },
      { signal: new AbortController().signal },
    );
    expect(body.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("leaves reasoningTokens out when the provider does not count them", async () => {
    const replies = [
      { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: null } },
      { prompt_tokens: 1, completion_tokens: 2 },
    ];
    for (const usage of replies) {
      vi.stubGlobal("fetch", async () => Response.json({ choices: [{ message: { content: "好" } }], usage }));
      const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
      const response = await model.complete(
        { messages: [{ role: "user", content: "q" }] },
        { signal: new AbortController().signal },
      );
      expect(response.usage).toStrictEqual({ inputTokens: 1, outputTokens: 2 });
    }
  });

  it("uses the fetch it is given instead of the global one", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("global fetch used");
    });
    const urls: string[] = [];
    const model = openAICompatible({
      baseURL: "http://x/v1/",
      model: "m",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });
    const response = await model.complete(
      { messages: [{ role: "user", content: "q" }] },
      { signal: new AbortController().signal },
    );
    expect(response.content).toBe("ok");
    expect(urls).toEqual(["http://x/v1/chat/completions"]);
  });
});

/** A response without streams, so it settles in microtasks (fake timers do not have to wait for I/O). */
const reply = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body),
  }) as unknown as Response;
const okBody = JSON.stringify({ choices: [{ message: { content: "hi" } }] });

describe("HTTP errors", () => {
  const signal = new AbortController().signal;
  const failing = (response: Response) =>
    Promise.resolve(
      openAICompatible({ baseURL: "http://x/v1", model: "m", fetch: async () => response }).complete(
        { messages: [] },
        { signal },
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

  it("throws HTTPError with the status, the URL, Retry-After and the start of the body", async () => {
    const error = await failing(reply(429, "x".repeat(600), { "retry-after": "3" }));
    expect(error).toBeInstanceOf(HTTPError);
    expect(error).toMatchObject({
      name: "HTTPError",
      status: 429,
      url: "http://x/v1/chat/completions",
      retryAfterMs: 3000,
      message: `http://x/v1/chat/completions responded 429: ${"x".repeat(500)}`,
    });
    expect(isRetryable(error)).toBe(true);
  });

  it("reads Retry-After as an HTTP date, and leaves it out when missing or unreadable", async () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    const dated = (await failing(reply(503, "busy", { "retry-after": date }))) as HTTPError;
    expect(dated.retryAfterMs).toBeGreaterThan(8000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(10_000);
    const missing = (await failing(reply(400, "bad"))) as HTTPError;
    expect(missing.retryAfterMs).toBeUndefined();
    expect(isRetryable(missing)).toBe(false);
    const unreadable = (await failing(reply(503, "busy", { "retry-after": "soon" }))) as HTTPError;
    expect(unreadable.retryAfterMs).toBeUndefined();
  });

  it("lets LLMNode give up on a 400 at once and retry a 429 after Retry-After", async () => {
    const schema = z.object({ q: z.string(), a: z.string() });
    let fetches = 0;
    const graphWith = (first: Response) => {
      fetches = 0;
      const model = openAICompatible({
        baseURL: "http://x/v1",
        model: "m",
        fetch: async () => {
          fetches += 1;
          return fetches === 1 ? first : reply(200, okBody);
        },
      });
      return createGraph(schema, {
        start: "ask",
        nodes: {
          ask: LLMNode({
            model,
            prompt: (s) => s.q,
            update: (s, text) => ({ ...s, a: text }),
            retry: { maxAttempts: 3 },
          }),
        },
        endNodes: ["ask"],
      });
    };

    const error = await graphWith(reply(400, "bad request"))
      .run({ q: "hi", a: "" })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(HTTPError);
    expect(fetches).toBe(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = graphWith(reply(429, "slow down", { "retry-after": "3" })).run({ q: "hi", a: "" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const { state, trace } = await pending;
    expect(fetches).toBe(2);
    expect(state.a).toBe("hi");
    expect(trace.find((e) => e.type === "error")?.meta).toMatchObject({ willRetry: true, delayMs: 3000 });
  });
});

describe("tokenLimit", () => {
  it("puts maxTokens in the field it names", async () => {
    const bodies: Record<string, unknown>[] = [];
    const capture = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(200, okBody);
    };
    const signal = new AbortController().signal;
    const request = { messages: [{ role: "user" as const, content: "q" }], maxTokens: 50 };
    const reasoning = openAICompatible({
      baseURL: "http://x/v1",
      model: "o3",
      tokenLimit: "max_completion_tokens",
      fetch: capture,
    });
    await reasoning.complete(request, { signal });
    await openAICompatible({ baseURL: "http://x/v1", model: "m", fetch: capture }).complete(request, { signal });
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 50 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
    expect(bodies[1]).toMatchObject({ max_tokens: 50 });
    expect(bodies[1]).not.toHaveProperty("max_completion_tokens");
  });

  it("refuses other values", () => {
    expect(() => openAICompatible({ baseURL: "http://x/v1", model: "m", tokenLimit: "max" as never })).toThrow(
      'openAICompatible: tokenLimit must be "max_tokens" or "max_completion_tokens", got max',
    );
  });
});
