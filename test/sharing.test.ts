import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentState } from "../src/agent/index.js";
import { createAgent, tool } from "../src/agent/index.js";
import { createGraph, type TraceEvent } from "../src/index.js";

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
  });
});
