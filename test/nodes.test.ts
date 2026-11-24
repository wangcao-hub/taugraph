import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, type TaugraphError } from "../src/index.js";
import { CodeNode, type LLMModel, LLMNode, LLMOutputError, type LLMRequest } from "../src/nodes/index.js";

const schema = z.object({
  question: z.string(),
  answer: z.string().nullable().default(null),
  score: z.number().nullable().default(null),
});

function mockModel(replies: string[]): LLMModel & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    id: "mock:test",
    requests,
    complete(request) {
      requests.push(request);
      return { content: replies.shift() ?? "", model: "mock", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

describe("CodeNode", () => {
  it("labels itself as code in the trace", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: CodeNode((s) => ({ ...s, answer: "x" })) },
      endNodes: ["a"],
    });
    const { trace } = await graph.run({ question: "q" });
    expect(trace.find((e) => e.type === "enter")?.meta).toMatchObject({ kind: "code" });
  });

  it("validates its retry policy", () => {
    expect(() => CodeNode((s) => s, { retry: { maxAttempts: 0 } })).toThrow(/maxAttempts/);
  });
});

describe("LLMNode", () => {
  it("passes tools to the model and hands its tool calls to update", async () => {
    const calls = [{ id: "c1", name: "weather", arguments: { city: "南京" } }];
    const model: LLMModel = { id: "mock:tools", complete: () => ({ content: "", toolCalls: calls }) };
    let seen: unknown;
    const graph = createGraph(schema, {
      start: "ask",
      nodes: {
        ask: LLMNode({
          model,
          prompt: (s) => ({
            messages: [{ role: "user", content: s.question }],
            tools: [{ name: "weather", inputSchema: { type: "object" } }],
            toolChoice: "auto",
          }),
          update: (s, _text, response) => {
            seen = response.toolCalls;
            return s;
          },
        }),
      },
      endNodes: ["ask"],
    });
    const { trace } = await graph.run({ question: "天气" });
    expect(seen).toEqual(calls);
    expect(trace.find((e) => e.type === "llm_call")?.input).toMatchObject({
      tools: [{ name: "weather" }],
      toolChoice: "auto",
    });
  });

  it("turns a string prompt into a user message and records an llm_call event", async () => {
    const model = mockModel(["42"]);
    const graph = createGraph(schema, {
      start: "ask",
      nodes: {
        ask: LLMNode({ model, prompt: (s) => s.question, update: (s, text) => ({ ...s, answer: text }) }),
      },
      endNodes: ["ask"],
    });
    const { state, trace } = await graph.run({ question: "meaning of life?" });
    expect(state.answer).toBe("42");
    expect(model.requests).toEqual([{ messages: [{ role: "user", content: "meaning of life?" }] }]);

    const call = trace.find((e) => e.type === "llm_call");
    expect(call?.nodeId).toBe("ask");
    expect(call?.input).toEqual({ messages: [{ role: "user", content: "meaning of life?" }] });
    expect(call?.output).toMatchObject({ content: "42" });
    expect(call?.meta).toMatchObject({ model: "mock:test" });
    expect(trace.find((e) => e.type === "enter")?.meta).toMatchObject({ kind: "llm" });
  });

  it("works under runSync when the model is synchronous", () => {
    const graph = createGraph(schema, {
      start: "ask",
      nodes: {
        ask: LLMNode({ model: mockModel(["ok"]), prompt: (s) => s.question, update: (s, t) => ({ ...s, answer: t }) }),
      },
      endNodes: ["ask"],
    });
    expect(graph.runSync({ question: "q" }).state.answer).toBe("ok");
  });

  it("parses structured output, including fenced JSON", async () => {
    const graph = createGraph(schema, {
      start: "grade",
      nodes: {
        grade: LLMNode({
          model: mockModel(['Sure!\n```json\n{"score": 0.9, "reason": "good"}\n```']),
          prompt: (s) => ({
            messages: [
              { role: "system", content: "grade" },
              { role: "user", content: s.question },
            ],
          }),
          output: z.object({ score: z.number(), reason: z.string() }),
          update: (s, data) => ({ ...s, score: data.score, answer: data.reason }),
        }),
      },
      endNodes: ["grade"],
    });
    const { state } = await graph.run({ question: "q" });
    expect(state).toMatchObject({ score: 0.9, answer: "good" });
  });

  it("retries when structured output is invalid", async () => {
    const model = mockModel(["not json", '{"score": "high"}', '{"score": 1}']);
    const graph = createGraph(schema, {
      start: "grade",
      nodes: {
        grade: LLMNode({
          model,
          prompt: (s) => s.question,
          output: z.object({ score: z.number() }),
          update: (s, data) => ({ ...s, score: data.score }),
          retry: { maxAttempts: 3 },
        }),
      },
      endNodes: ["grade"],
    });
    const { state, trace } = await graph.run({ question: "q" });
    expect(state.score).toBe(1);
    expect(model.requests).toHaveLength(3);
    expect(trace.filter((e) => e.type === "llm_call")).toHaveLength(3);
    expect(trace.filter((e) => e.type === "error").map((e) => e.meta?.message)).toEqual([
      expect.stringMatching(/not valid JSON/),
      expect.stringMatching(/does not match the schema/),
    ]);
  });

  it("surfaces LLMOutputError as the cause when retries run out", async () => {
    const graph = createGraph(schema, {
      start: "grade",
      nodes: {
        grade: LLMNode({
          model: mockModel(["nope"]),
          prompt: (s) => s.question,
          output: z.object({ score: z.number() }),
          update: (s, data) => ({ ...s, score: data.score }),
        }),
      },
      endNodes: ["grade"],
    });
    const error = (await graph.run({ question: "q" }).catch((e) => e)) as TaugraphError;
    expect(error.code).toBe("NODE_FAILED");
    expect(error.cause).toBeInstanceOf(LLMOutputError);
    expect((error.cause as LLMOutputError).content).toBe("nope");
  });

  it("passes the abort signal to the model", async () => {
    let received: AbortSignal | undefined;
    const model: LLMModel = {
      id: "spy",
      complete(_request, { signal }) {
        received = signal;
        return Promise.resolve({ content: "x" });
      },
    };
    const controller = new AbortController();
    const graph = createGraph(schema, {
      start: "ask",
      nodes: { ask: LLMNode({ model, prompt: (s) => s.question, update: (s, t) => ({ ...s, answer: t }) }) },
      endNodes: ["ask"],
    });
    await graph.run({ question: "q" }, { signal: controller.signal });
    expect(received).toBe(controller.signal);
  });

  it("can be swapped for another model during replay", async () => {
    const graph = createGraph(schema, {
      start: "ask",
      nodes: {
        ask: LLMNode({ model: mockModel(["old"]), prompt: (s) => s.question, update: (s, t) => ({ ...s, answer: t }) }),
      },
      endNodes: ["ask"],
    });
    const original = await graph.run({ question: "q" });
    const replayed = await graph.replay(original.trace, {
      overrides: {
        ask: LLMNode({
          model: { id: "mock:new", complete: () => ({ content: "new" }) },
          prompt: (s) => s.question,
          update: (s, t) => ({ ...s, answer: t }),
        }),
      },
    });
    expect(replayed.state.answer).toBe("new");
    expect(replayed.trace.find((e) => e.type === "llm_call")?.meta).toMatchObject({ model: "mock:new" });
  });
});
