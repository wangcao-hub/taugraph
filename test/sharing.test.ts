import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentState } from "../src/agent/index.js";
import { createAgent, tool } from "../src/agent/index.js";
import { freezeJson } from "../src/core/util.js";
import {
  createGraph,
  fromJSONL,
  type StandardSchemaV1,
  TaugraphError,
  type Trace,
  type TraceEvent,
  toJSONL,
} from "../src/index.js";

const enters = (trace: readonly TraceEvent[], nodeId: string) =>
  trace.filter((e) => e.type === "enter" && e.nodeId === nodeId).map((e) => e.input);

describe("structural sharing", () => {
  it("keeps unchanged parts of the state as the same objects from step to step", () => {
    const schema = z.object({ items: z.array(z.object({ n: z.number() })) });
    const add = (s: z.infer<typeof schema>) => ({ items: [...s.items, { n: s.items.length }] });
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: add, b: add, c: add },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      endNodes: ["c"],
    });
    const { trace } = graph.runSync({ items: [{ n: 0 }] });
    const inputs = trace.filter((e) => e.type === "enter").map((e) => e.input as { items: { n: number }[] });
    // Zod returns fresh objects; the kernel still shares the parts that did not change.
    expect(inputs[2]?.items[0]).toBe(inputs[1]?.items[0]);
    expect(inputs[2]?.items[1]).toBe(inputs[1]?.items[1]);
    expect(Object.isFrozen(inputs[2]?.items[1])).toBe(true);
  });

  it("shares unchanged parts of the state in a recorded replay", async () => {
    const schema = z.object({ items: z.array(z.object({ n: z.number() })) });
    const add = (s: z.infer<typeof schema>) => ({ items: [...s.items, { n: s.items.length }] });
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: add, b: add, c: add },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      endNodes: ["c"],
    });
    const { trace } = await graph.replay(graph.runSync({ items: [{ n: 0 }] }).trace);
    const enters = trace.filter((e) => e.type === "enter");
    expect(enters.map((e) => e.meta?.source)).toEqual(["recorded", "recorded", "recorded"]);
    const inputs = enters.map((e) => e.input as { items: { n: number }[] });
    expect(inputs[2]?.items[0]).toBe(inputs[1]?.items[0]);
    expect(inputs[2]?.items[1]).toBe(inputs[1]?.items[1]);
  });

  it("keeps the key order a node returns, in memory and through JSONL", () => {
    type State = { readonly a: number; readonly b: number; readonly c: number };
    const passThrough: StandardSchemaV1<State, State> = {
      "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as State }) },
    };
    const graph = createGraph(passThrough, {
      start: "reorder",
      nodes: { reorder: (s) => ({ b: s.b, c: s.c, a: s.a }), next: (s) => s },
      edges: [{ from: "reorder", to: "next" }],
      endNodes: ["next"],
    });
    const { trace } = graph.runSync({ a: 1, b: 2, c: 3 });
    const keys = (t: Trace) => Object.keys(t.find((e) => e.type === "enter" && e.nodeId === "next")?.input as object);
    expect(keys(trace)).toEqual(["b", "c", "a"]);
    expect(keys(fromJSONL(toJSONL(trace)))).toEqual(["b", "c", "a"]);
  });

  it("shares conversation messages across agent steps and model calls", () => {
    const replies = [
      { content: "", toolCalls: [{ id: "c1", name: "read", arguments: {} }] },
      { content: "", toolCalls: [{ id: "c2", name: "read", arguments: {} }] },
      { content: "done" },
    ];
    const model = { id: "mock", complete: () => replies.shift() ?? { content: "done" } };
    const read = tool({ name: "read", run: () => "x".repeat(100) });
    const { trace } = createAgent({ model, tools: [read] }).runSync({ messages: [{ role: "user", content: "go" }] });
    const thinks = enters(trace, "think") as AgentState[];
    expect(thinks[2]?.messages[0]).toBe(thinks[1]?.messages[0]);
    expect(thinks[2]?.messages[2]).toBe(thinks[1]?.messages[2]);
    const calls = trace.filter((e) => e.type === "llm_call").map((e) => e.input as { messages: unknown[] });
    expect(calls[1]?.messages[0]).toBe(thinks[1]?.messages[0]);
  });

  it("still copies values it did not freeze itself", async () => {
    const schema = z.object({ text: z.string() });
    const payload = Object.freeze({ list: [1, 2] });
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s: z.infer<typeof schema>, ctx) => {
          ctx.trace.append({ type: "custom.event", input: payload });
          return s;
        },
      },
      endNodes: ["a"],
    });
    const { trace } = await graph.run({ text: "x" });
    const event = trace.find((e) => e.type === "custom.event");
    expect(event?.input).toEqual({ list: [1, 2] });
    expect(event?.input).not.toBe(payload);
    const list = (event?.input as { list?: number[] } | undefined)?.list;
    expect(list).not.toBe(payload.list);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("rejects a hole in an array even when the array has the same length as before", async () => {
    const schema = z.object({ a: z.array(z.number()) });
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s: z.infer<typeof schema>) => {
          const a = [...s.a];
          delete a[1];
          return { a };
        },
      },
      endNodes: ["a"],
    });
    const error = await graph.run({ a: [1, 2, 3] }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TaugraphError);
    expect((error as TaugraphError).code).toBe("INVALID_STATE");
    expect((error as TaugraphError).message).toMatch(/a\[1\]: hole in array/);
  });

  it("keeps a __proto__ key as an own property instead of setting the prototype", () => {
    const result = freezeJson(JSON.parse('{"__proto__":{"admin":true},"x":1}') as object);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect((result as { admin?: unknown }).admin).toBeUndefined();
    expect(JSON.stringify(result)).toContain('"__proto__":{"admin":true}');
  });
});
