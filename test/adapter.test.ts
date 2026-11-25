import { afterEach, describe, expect, it, vi } from "vitest";
import { fromOpenAIToolCalls, openAICompatible, toOpenAIMessages } from "../examples/adapters/openai-compatible.js";

afterEach(() => vi.unstubAllGlobals());

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
});
