import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT_DEFAULTS, type AgentState, agentStateSchema, createAgent, tool } from "../src/agent/index.js";
import { isTaugraphError, type Trace } from "../src/index.js";
import type { LLMModel, LLMRequest, LLMResponse } from "../src/nodes/index.js";

function scripted(replies: LLMResponse[]): LLMModel & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    id: "mock:agent",
    requests,
    complete(request) {
      requests.push(request);
      return replies.shift() ?? { content: "done" };
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });
const ask = (text: string) => ({ messages: [{ role: "user" as const, content: text }] });

const weather = tool({
  name: "weather",
  description: "Weather for a city",
  input: z.object({ city: z.string() }),
  run: ({ city }) => `${city}: 晴，-2~5°C`,
});

const hang = () => new Promise<never>(() => {});
const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // keep the thread busy
  }
};

describe("createAgent", () => {
  it("answers without tools in one round", async () => {
    const model = scripted([{ content: "你好" }]);
    const agent = createAgent({ model, tools: [weather], system: "be brief" });
    const { state, trace, path } = await agent.run(ask("hi"));
    expect(state).toMatchObject({ final: "你好", stop: "done", rounds: 1, pending: [] });
    expect(path).toEqual(["think", "finish"]);
    expect(model.requests[0]?.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(model.requests[0]?.tools).toEqual([
      {
        name: "weather",
        description: "Weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(trace.filter((e) => e.type === "llm_call")).toHaveLength(1);
  });

  it("runs a read tool, records it, and hands the result back to the model", async () => {
    const model = scripted([
      { content: "", toolCalls: [call("c1", "weather", { city: "南京" })] },
      { content: "南京晴" },
    ]);
    const { state, trace, path } = await createAgent({ model, tools: [weather] }).run(ask("南京天气"));
    expect(path).toEqual(["think", "act", "think", "finish"]);
    expect(state.final).toBe("南京晴");
    expect(state.messages).toEqual([
      { role: "user", content: "南京天气" },
      { role: "assistant", content: "", toolCalls: [call("c1", "weather", { city: "南京" })], model: "mock:agent" },
      { role: "tool", toolCallId: "c1", content: "南京: 晴，-2~5°C" },
      { role: "assistant", content: "南京晴", model: "mock:agent" },
    ]);
    const event = trace.find((e) => e.type === "tool_call");
    expect(event).toMatchObject({
      nodeId: "act",
      input: { id: "c1", name: "weather", arguments: { city: "南京" } },
      output: { content: "南京: 晴，-2~5°C", isError: false },
      meta: { effect: "read" },
    });
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: "tool", toolCallId: "c1", content: "南京: 晴，-2~5°C" });
  });

  it("prefers a given JSON Schema, and falls back to an open object", () => {
    const model = scripted([]);
    const given = tool({
      name: "a",
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      run: () => "",
    });
    const bare = tool({ name: "b", run: () => "" });
    const agent = createAgent({ model, tools: [given, bare] });
    agent.runSync(ask("x"));
    expect(model.requests[0]?.tools?.map((t) => t.inputSchema)).toEqual([
      { type: "object", properties: { x: { type: "number" } } },
      { type: "object" },
    ]);
  });

  it("turns bad arguments, unknown tools, unreadable arguments and errors into results the model sees", async () => {
    let ran = 0;
    const boom = tool({
      name: "boom",
      run: () => {
        ran++;
        throw new Error("disk full");
      },
    });
    const counted = tool({
      ...weather,
      run: (args, ctx) => {
        ran++;
        return weather.run(args, ctx);
      },
    });
    const model = scripted([
      {
        content: "",
        toolCalls: [
          call("c1", "weather", { town: "南京" }),
          call("c2", "nope"),
          { id: "c3", name: "weather", arguments: {}, parseError: "arguments are not valid JSON" },
          call("c4", "boom"),
        ],
      },
      { content: "抱歉" },
    ]);
    const { state, trace } = await createAgent({ model, tools: [counted, boom] }).run(ask("x"));
    const results = state.messages.filter((m) => m.role === "tool");
    expect(results.map((m) => [m.content, m.isError])).toEqual([
      [expect.stringMatching(/^Invalid arguments: city: /), true],
      ['No tool named "nope"', true],
      ["Invalid arguments: arguments are not valid JSON", true],
      ["Error: disk full", true],
    ]);
    expect(ran).toBe(1); // only boom ran
    expect(trace.filter((e) => e.type === "tool_call").map((e) => e.meta)).toMatchObject([
      { effect: "read", error: true },
    ]);
  });

  it("runs write tools in a write step, so a replay never repeats them", async () => {
    const done: string[] = [];
    const addTodo = tool({
      name: "add_todo",
      effect: "write",
      input: z.object({ text: z.string() }),
      run: ({ text }) => {
        done.push(text);
        return "added";
      },
    });
    const reply = (): LLMResponse[] => [
      { content: "", toolCalls: [call("c1", "add_todo", { text: "交周报" })] },
      { content: "好了" },
    ];
    const { trace, path } = await createAgent({ model: scripted(reply()), tools: [addTodo] }).run(ask("记一下"));
    expect(path).toEqual(["think", "act_write", "think", "finish"]);
    expect(trace.find((e) => e.type === "enter" && e.nodeId === "act_write")?.meta).toMatchObject({ effect: "write" });

    const again = createAgent({ model: scripted(reply()), tools: [addTodo] });
    await expect(again.replay(trace, { mode: "live" })).rejects.toMatchObject({ code: "WRITE_BLOCKED" });
    await again.replay(trace, { mode: "recorded" }); // same inputs: recorded outputs are reused
    expect(done).toEqual(["交周报"]);
    await createAgent({ model: scripted(reply()), tools: [addTodo] }).replay(trace, {
      mode: "live",
      allowWrites: true,
    });
    expect(done).toEqual(["交周报", "交周报"]);
  });

  it("pauses for approval when asked to, and runs or refuses on the answer", async () => {
    const done: string[] = [];
    const send = tool({
      name: "send",
      effect: "write",
      run: () => {
        done.push("sent");
        return "sent";
      },
    });
    const make = () =>
      createAgent({
        model: scripted([{ content: "", toolCalls: [call("c1", "send", { to: "boss" })] }, { content: "ok" }]),
        tools: [send],
        approve: (_call, t) => (t.effect === "write" ? "ask" : "run"),
      });
    const agent = make();
    const paused = await agent.run(ask("发出去"));
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") return;
    expect(paused.pending).toMatchObject({
      nodeId: "act_write",
      request: { type: "tool_approval", call: call("c1", "send", { to: "boss" }), effect: "write" },
    });
    const approved = await agent.resume(paused.trace, true);
    expect(approved.status).toBe("completed");
    expect(done).toEqual(["sent"]);

    const other = make();
    const again = await other.run(ask("发出去"));
    const refused = await other.resume(again.trace, { approved: false, reason: "not now" });
    expect(done).toEqual(["sent"]);
    expect(refused.state.messages.find((m) => m.role === "tool")).toMatchObject({
      content: "The user did not allow this call: not now",
      isError: true,
    });

    const denied = await createAgent({
      model: scripted([{ content: "", toolCalls: [call("c1", "send")] }, { content: "ok" }]),
      tools: [send],
      approve: () => "deny",
    }).run(ask("x"));
    expect(denied.status).toBe("completed");
    expect(done).toEqual(["sent"]);
  });

  it("stops after maxRounds without calling the model again", async () => {
    const loop = (): LLMResponse => ({
      content: "再查一次",
      toolCalls: [call(`c${Math.random()}`, "weather", { city: "南京" })],
    });
    const model = scripted([loop(), loop(), loop()]);
    const { state } = await createAgent({ model, tools: [weather], maxRounds: 2 }).run(ask("x"));
    expect(model.requests).toHaveLength(2);
    expect(state).toMatchObject({ stop: "max_rounds", rounds: 2, final: "再查一次" });
  });

  it("answers at most 32 calls from one reply and tells the model about the rest", async () => {
    const calls = Array.from({ length: 34 }, (_, i) => call(`c${i}`, "weather", { city: "南京" }));
    const { state } = await createAgent({ model: scripted([{ content: "", toolCalls: calls }]), tools: [weather] }).run(
      ask("x"),
    );
    const results = state.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(34);
    expect(results.filter((m) => m.isError).map((m) => m.toolCallId)).toEqual(["c32", "c33"]);
    expect(results.map((m) => m.toolCallId)).toEqual(calls.map((c) => c.id)); // the refused ones come last
    expect(AGENT_DEFAULTS.maxCallsPerReply).toBe(32);
  });

  it("will not restart a write that was running when the trace ended", async () => {
    const send = tool({ name: "send", effect: "write", run: () => "sent" });
    const agent = createAgent({ model: scripted([{ content: "", toolCalls: [call("c1", "send")] }]), tools: [send] });
    const { trace } = await agent.run(ask("x"));
    const cut: Trace = trace.slice(0, trace.findIndex((e) => e.type === "enter" && e.nodeId === "act_write") + 1);
    const error = await agent.resume(cut).catch((e: unknown) => e);
    expect(isTaugraphError(error) && error.code).toBe("UNKNOWN_OUTCOME");
  });

  it("runs synchronously with a synchronous model and tools", () => {
    const model = scripted([
      { content: "", toolCalls: [call("c1", "weather", { city: "上海" })] },
      { content: "上海晴" },
    ]);
    expect(createAgent({ model, tools: [weather] }).runSync(ask("x")).state.final).toBe("上海晴");
  });

  it("continues calls it was given before asking the model", async () => {
    const model = scripted([{ content: "好" }]);
    const { path } = await createAgent({ model, tools: [weather] }).run({
      messages: [{ role: "assistant", content: "", toolCalls: [call("c1", "weather", { city: "南京" })] }],
      pending: [call("c1", "weather", { city: "南京" })],
    });
    expect(path).toEqual(["think", "act", "think", "finish"]);
    expect(model.requests).toHaveLength(1);
  });

  it("refuses tool names providers do not accept, and two tools with one name", () => {
    const model = scripted([]);
    expect(() => createAgent({ model, tools: [tool({ name: "has space", run: () => "" })] })).toThrow(/tool name/);
    expect(() => createAgent({ model, tools: [weather, weather] })).toThrow(/two tools are named "weather"/);
    expect(() => createAgent({ model, maxRounds: 0 })).toThrow(/maxRounds/);
  });

  it("passes images to the model and lets tools return them", async () => {
    const screenshot = tool({
      name: "screenshot",
      run: () => ({
        content: [
          { type: "text", text: "the page" },
          { type: "image", url: "media:shot1" },
        ],
      }),
    });
    const model = scripted([{ content: "", toolCalls: [call("c1", "screenshot")] }, { content: "a login form" }]);
    const photo = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const question = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "what is on the page?" }, photo],
    };
    const { state, trace } = await createAgent({ model, tools: [screenshot] }).run({ messages: [question] });
    expect(model.requests[0]?.messages[0]).toEqual(question);
    const result = {
      role: "tool",
      toolCallId: "c1",
      content: [
        { type: "text", text: "the page" },
        { type: "image", url: "media:shot1" },
      ],
    };
    expect(state.messages[2]).toEqual(result);
    expect(model.requests[1]?.messages.at(-1)).toEqual(result);
    expect(trace.find((e) => e.type === "tool_call")?.output).toEqual({ content: result.content, isError: false });
  });

  it("fails the run when a tool returns content it cannot pass on", async () => {
    const broken = tool({ name: "broken", run: () => ({ content: [{ type: "image" }] }) as never });
    const model = scripted([{ content: "", toolCalls: [call("c1", "broken")] }]);
    await expect(createAgent({ model, tools: [broken] }).run(ask("x"))).rejects.toThrow(
      /Tool "broken" returned bad content: content\.0\.url: expected a string \(or data and mimeType\)/,
    );
    const odd = tool({ name: "odd", run: () => 42 as never });
    await expect(
      createAgent({ model: scripted([{ content: "", toolCalls: [call("c1", "odd")] }]), tools: [odd] }).run(ask("x")),
    ).rejects.toThrow(/Tool "odd" returned neither a string nor \{ content: string \| ContentPart\[\] \}/);
  });

  it("asks for the reasoning level and keeps what the model thought, with signatures, for the next round", async () => {
    const thought = [{ text: "need the weather first", signature: "sig-1" }];
    const signed = { ...call("c1", "weather", { city: "南京" }), signature: "ts-1" };
    const model = scripted([
      { content: "", reasoning: thought, toolCalls: [signed] },
      { content: "南京晴", reasoning: [] },
    ]);
    const { state } = await createAgent({ model, tools: [weather], reasoning: "high" }).run(ask("南京天气"));
    expect(model.requests.map((r) => r.reasoning)).toEqual(["high", "high"]);
    const first = { role: "assistant", content: "", toolCalls: [signed], reasoning: thought, model: "mock:agent" };
    expect(state.messages[1]).toEqual(first);
    expect(model.requests[1]?.messages[1]).toEqual(first);
    expect(state.messages[3]).toEqual({ role: "assistant", content: "南京晴", model: "mock:agent" });
    const plain = scripted([{ content: "hi" }]);
    await createAgent({ model: plain }).run(ask("x"));
    expect(plain.requests[0]).not.toHaveProperty("reasoning");
  });

  it("records which model wrote each message, so a replay with another model can leave old signatures out", async () => {
    const a = scripted([
      {
        content: "",
        reasoning: [{ text: "t", signature: "sig-a" }],
        toolCalls: [call("c1", "weather", { city: "南京" })],
      },
      { content: "晴" },
    ]);
    const { trace } = await createAgent({ model: a, tools: [weather] }).run(ask("南京天气"));
    const b = { ...scripted([{ content: "雨" }]), id: "mock:other" };
    const rainy = (s: AgentState): AgentState => ({
      ...s,
      messages: [...s.messages, { role: "tool", toolCallId: "c1", content: "南京: 雨" }],
      pending: [],
    });
    const replayed = await createAgent({ model: b, tools: [weather] }).replay(trace, { overrides: { act: rainy } });
    expect(b.requests[0]?.messages[1]).toMatchObject({
      role: "assistant",
      model: "mock:agent",
      reasoning: [{ text: "t", signature: "sig-a" }],
    });
    expect(replayed.state.messages.at(-1)).toEqual({ role: "assistant", content: "雨", model: "mock:other" });
  });
});

describe("agentStateSchema", () => {
  it("fills defaults and rejects malformed messages with a path", () => {
    const ok = agentStateSchema["~standard"].validate({ messages: [{ role: "user", content: "hi" }] });
    expect(ok).toEqual({
      value: { messages: [{ role: "user", content: "hi" }], pending: [], rounds: 0, final: null, stop: null },
    });
    const bad = agentStateSchema["~standard"].validate({
      messages: [
        { role: "tool", content: "x" },
        { role: "robot", content: "y" },
      ],
      rounds: -1,
    });
    expect("issues" in bad && bad.issues?.map((i) => [i.path, i.message])).toEqual([
      [["messages", 0, "toolCallId"], "expected a string"],
      [["messages", 1, "role"], 'expected "system", "user", "assistant" or "tool"'],
      [["rounds"], "expected a non-negative integer"],
    ]);
  });

  it("accepts images in user and tool messages only, and points at a bad part", () => {
    const image = { type: "image", url: "media:a" };
    const ok = agentStateSchema["~standard"].validate({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, image] },
        { role: "tool", toolCallId: "c1", content: [image] },
      ],
    });
    expect("value" in ok).toBe(true);
    const bad = agentStateSchema["~standard"].validate({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }, { type: "image" }, { type: "image", data: "x" }, { type: "audio" }],
        },
        { role: "assistant", content: [{ type: "text", text: "no" }] },
        { role: "user", content: 1 },
      ],
    });
    expect("issues" in bad && bad.issues?.map((i) => [i.path, i.message])).toEqual([
      [["messages", 0, "content", 1, "url"], "expected a string (or data and mimeType)"],
      [["messages", 0, "content", 2, "mimeType"], "expected a string"],
      [["messages", 0, "content", 3, "type"], 'expected "text" or "image"'],
      [["messages", 1, "content"], "expected a string"],
      [["messages", 2, "content"], "expected a string or an array of content parts"],
    ]);
  });

  it("checks reasoning, the writing model and signatures", () => {
    const bad = agentStateSchema["~standard"].validate({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "t", arguments: {}, signature: 3 }],
          model: 1,
          reasoning: [{ text: 1 }, { text: "", signature: 2, redacted: "yes" }, null],
        },
        { role: "assistant", content: "", reasoning: "thought" },
      ],
      pending: [{ id: "c1", name: "t", arguments: {}, signature: false }],
    });
    expect("issues" in bad && bad.issues?.map((i) => [i.path, i.message])).toEqual([
      [["messages", 0, "toolCalls", 0, "signature"], "expected a string"],
      [["messages", 0, "model"], "expected a string"],
      [["messages", 0, "reasoning", 0, "text"], "expected a string"],
      [["messages", 0, "reasoning", 1, "signature"], "expected a string"],
      [["messages", 0, "reasoning", 1, "redacted"], "expected a boolean"],
      [["messages", 0, "reasoning", 2], "expected a reasoning part object"],
      [["messages", 1, "reasoning"], "expected an array"],
      [["pending", 0, "signature"], "expected a string"],
    ]);
  });
});

describe("timeouts", () => {
  it("answers the model with an error when a read tool takes too long", async () => {
    let signal: AbortSignal | undefined;
    const slow = tool({
      name: "slow",
      timeoutMs: 20,
      run: (_args, ctx) => {
        signal = ctx.signal;
        return hang();
      },
    });
    const model = scripted([{ content: "", toolCalls: [call("c1", "slow")] }, { content: "sorry" }]);
    const { state, trace } = await createAgent({ model, tools: [slow] }).run(ask("go"));
    expect(state.final).toBe("sorry");
    expect(state.messages[2]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: 'Tool "slow" timed out after 20ms',
      isError: true,
    });
    expect(trace.find((e) => e.type === "tool_call")?.meta).toMatchObject({ error: true });
    expect(signal?.aborted).toBe(true);
  });

  it("fails the run when a write tool takes too long, since the write may have happened", async () => {
    const pay = tool({ name: "pay", effect: "write", timeoutMs: 20, run: () => hang() });
    const model = scripted([{ content: "", toolCalls: [call("c1", "pay")] }]);
    const error = await createAgent({ model, tools: [pay] })
      .run(ask("pay"))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isTaugraphError(error) && error.code).toBe("TIMEOUT");
    if (!isTaugraphError(error)) return;
    expect(error.message).toBe('Node "act_write" (step 1): Tool "pay" timed out after 20ms');
    expect(error.trace?.find((e) => e.type === "error")).toMatchObject({
      nodeId: "act_write",
      meta: { code: "TIMEOUT", outcome: "unknown", willRetry: false },
    });
    expect(error.trace?.some((e) => e.type === "tool_call")).toBe(false);
    expect(model.requests).toHaveLength(1);
  });

  it("stops a timed tool at once when the run is aborted", async () => {
    let signal: AbortSignal | undefined;
    const stuck = tool({
      name: "stuck",
      timeoutMs: 60_000,
      run: (_args, ctx) => {
        signal = ctx.signal;
        return hang();
      },
    });
    const model = scripted([{ content: "", toolCalls: [call("c1", "stuck")] }]);
    const controller = new AbortController();
    const started = Date.now();
    const pending = createAgent({ model, tools: [stuck] }).run(ask("go"), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isTaugraphError(error) && error.code).toBe("ABORTED");
    expect(Date.now() - started).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
  });

  it("limits each model call", async () => {
    const model: LLMModel = { id: "mock:slow", complete: () => hang() };
    const error = await createAgent({ model, timeoutMs: 20 })
      .run(ask("hi"))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isTaugraphError(error) && error.code).toBe("TIMEOUT");
    expect((error as Error).message).toBe('Node "think" (step 0) timed out after 20ms');
  });

  it("cannot interrupt a synchronous tool", () => {
    const quick = tool({
      name: "quick",
      timeoutMs: 1,
      run: () => {
        busy(10);
        return "done";
      },
    });
    const model = scripted([{ content: "", toolCalls: [call("c1", "quick")] }, { content: "ok" }]);
    const { state } = createAgent({ model, tools: [quick] }).runSync(ask("go"));
    expect(state.messages[2]).toMatchObject({ role: "tool", content: "done" });
  });

  it("refuses timeouts that are not whole milliseconds", () => {
    expect(() => createAgent({ model: scripted([]), timeoutMs: 0 })).toThrow(
      "createAgent: timeoutMs must be an integer from 1 to 2147483647, got 0",
    );
    const odd = tool({ name: "odd", timeoutMs: 1.5, run: () => "" });
    expect(() => createAgent({ model: scripted([]), tools: [odd] })).toThrow(
      'createAgent: tool "odd" has timeoutMs 1.5; use an integer from 1 to 2147483647',
    );
  });
});

describe("lastRound", () => {
  it("keeps the tools on the last round with toolChoice none and takes its words as the answer", async () => {
    const model = scripted([
      { content: "", toolCalls: [call("c1", "weather", { city: "南京" })] },
      { content: "南京晴", toolCalls: [call("c2", "weather", { city: "上海" })] },
    ]);
    const agent = createAgent({ model, tools: [weather], toolChoice: "auto", maxRounds: 2, lastRound: "answer" });
    const { state, path, trace } = await agent.run(ask("天气"));
    expect(model.requests[0]).toMatchObject({
      toolChoice: "auto",
      tools: [expect.objectContaining({ name: "weather" })],
    });
    expect(model.requests[1]).toMatchObject({
      toolChoice: "none",
      tools: [expect.objectContaining({ name: "weather" })],
    });
    const note = { role: "user", content: AGENT_DEFAULTS.lastRoundNote };
    expect(model.requests[1]?.messages.at(-1)).toEqual(note);
    expect(model.requests[0]?.messages).not.toContainEqual(note);
    expect(state.messages).not.toContainEqual(note);
    expect(path).toEqual(["think", "act", "think", "finish"]);
    expect(state).toMatchObject({ final: "南京晴", stop: "done", rounds: 2, pending: [] });
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "南京晴", model: "mock:agent" });
    const llmCalls = trace.filter((e) => e.type === "llm_call");
    expect(llmCalls).toHaveLength(2);
    expect((llmCalls.at(-1)?.input as LLMRequest | undefined)?.messages.at(-1)).toEqual(note);
    expect(trace.filter((e) => e.type === "tool_call")).toHaveLength(1);
  });

  it("answers in words when maxRounds allows one call", async () => {
    const model = scripted([{ content: "好" }]);
    const agent = createAgent({ model, tools: [weather], toolChoice: "required", maxRounds: 1, lastRound: "answer" });
    const { state } = await agent.run(ask("hi"));
    expect(model.requests[0]).toMatchObject({
      toolChoice: "none",
      tools: [expect.objectContaining({ name: "weather" })],
    });
    expect(model.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "hi" });
    expect(state).toMatchObject({ final: "好", stop: "done" });
  });

  it("uses the lastRoundNote it is given", async () => {
    const model = scripted([{ content: "", toolCalls: [call("c1", "weather", { city: "南京" })] }, { content: "好" }]);
    const lastRoundNote = "工具用完了，直接回答。";
    const agent = createAgent({ model, tools: [weather], maxRounds: 2, lastRound: "answer", lastRoundNote });
    await agent.run(ask("hi"));
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: lastRoundNote });
  });

  it("refuses an empty lastRoundNote", () => {
    const make = () => createAgent({ model: scripted([]), lastRoundNote: "  " });
    expect(make).toThrow(TypeError);
    expect(make).toThrow("createAgent: lastRoundNote must be a non-empty string");
  });

  it("sends neither tools nor toolChoice on the last round when there are no tools", async () => {
    const model = scripted([{ content: "好" }]);
    const { state } = await createAgent({ model, maxRounds: 1, lastRound: "answer" }).run(ask("hi"));
    expect(model.requests[0]).not.toHaveProperty("tools");
    expect(model.requests[0]).not.toHaveProperty("toolChoice");
    expect(model.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "hi" });
    expect(state).toMatchObject({ final: "好", stop: "done" });
  });

  it("keeps the tools on every round by default", async () => {
    const script = (): LLMResponse[] => [
      { content: "", toolCalls: [call("c1", "weather", { city: "南京" })] },
      { content: "", toolCalls: [call("c2", "weather", { city: "上海" })] },
    ];
    const runWith = async (lastRound?: "tools") => {
      const model = scripted(script());
      const agent = createAgent({ model, tools: [weather], maxRounds: 2, ...(lastRound && { lastRound }) });
      const { state } = await agent.run(ask("天气"));
      return { requests: model.requests, state };
    };
    const unset = await runWith();
    const tools = await runWith("tools");
    expect(unset.requests[1]?.tools).toHaveLength(1);
    expect(unset.requests.flatMap((r) => r.messages)).not.toContainEqual({
      role: "user",
      content: AGENT_DEFAULTS.lastRoundNote,
    });
    expect(unset.state.stop).toBe("max_rounds");
    expect(tools.requests).toEqual(unset.requests);
    expect(tools.state).toEqual(unset.state);
  });

  it("refuses other values", () => {
    const make = () => createAgent({ model: scripted([]), lastRound: "none" as never });
    expect(make).toThrow(TypeError);
    expect(make).toThrow('createAgent: lastRound must be "tools" or "answer", got none');
  });

  it("decides the last round from the state, so a resumed run gets it right", async () => {
    const model = scripted([
      { content: "", toolCalls: [call("c1", "weather", { city: "南京" })] },
      { content: "南京晴" },
    ]);
    const agent = createAgent({ model, tools: [weather], maxRounds: 2, lastRound: "answer", approve: () => "ask" });
    const paused = await agent.run(ask("天气"));
    expect(paused.status).toBe("paused");
    const resumed = await agent.resume(paused.trace, true);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.tools).toHaveLength(1);
    expect(model.requests[1]?.tools).toHaveLength(1);
    expect(model.requests[1]?.toolChoice).toBe("none");
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: AGENT_DEFAULTS.lastRoundNote });
    expect(resumed.status).toBe("completed");
    expect(resumed.state).toMatchObject({ final: "南京晴", stop: "done", rounds: 2 });
  });
});
