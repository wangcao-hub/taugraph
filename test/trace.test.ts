import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertTrace,
  createGraph,
  fromJSONL,
  TaugraphError,
  TRACE_VERSION,
  type TraceEvent,
  toJSONL,
  tracePath,
} from "../src/index.js";

const schema = z.object({ text: z.string() });
type State = z.infer<typeof schema>;

function makeGraph() {
  return createGraph(schema, {
    start: "upper",
    nodes: {
      upper: (s: State, ctx) => {
        ctx.trace.append({ type: "tool_call", input: { tool: "upper", arg: s.text }, output: s.text.toUpperCase() });
        return { text: s.text.toUpperCase() };
      },
      exclaim: (s) => ({ text: `${s.text}!` }),
    },
    edges: [{ from: "upper", to: "exclaim" }],
    endNodes: ["exclaim"],
  });
}

describe("trace", () => {
  it("records a complete, ordered event stream with state snapshots", async () => {
    const { trace, runId } = await makeGraph().run({ text: "hi" }, { runId: "run-1" });
    expect(runId).toBe("run-1");
    expect(trace.map((e) => [e.type, e.nodeId, e.step])).toEqual([
      ["run_start", undefined, undefined],
      ["enter", "upper", 0],
      ["tool_call", "upper", 0],
      ["exit", "upper", 0],
      ["enter", "exclaim", 1],
      ["exit", "exclaim", 1],
      ["run_end", undefined, undefined],
    ]);
    expect(trace.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(trace.every((e) => e.runId === "run-1")).toBe(true);
    expect(trace[0]?.meta).toMatchObject({ format: "taugraph.trace", version: TRACE_VERSION, start: "upper" });
    expect(trace[1]?.input).toEqual({ text: "hi" });
    expect(trace[3]?.output).toEqual({ text: "HI" });
    expect(trace[6]?.output).toEqual({ text: "HI!" });
    expect(trace[6]?.meta).toMatchObject({ status: "completed", steps: 2 });
  });

  it("is immutable", async () => {
    const { trace } = await makeGraph().run({ text: "hi" });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace[1])).toBe(true);
    expect(Object.isFrozen(trace[1]?.input)).toBe(true);
    expect(() => {
      (trace as TraceEvent[]).push(trace[0] as TraceEvent);
    }).toThrow(TypeError);
  });

  it("streams events to onEvent as they are appended", async () => {
    const seen: string[] = [];
    await makeGraph().run({ text: "hi" }, { onEvent: (e) => seen.push(e.type) });
    expect(seen).toEqual(["run_start", "enter", "tool_call", "exit", "enter", "exit", "run_end"]);
  });

  it("round-trips through JSONL", async () => {
    const { trace } = await makeGraph().run({ text: "hi" });
    const text = toJSONL(trace);
    expect(text.trim().split("\n")).toHaveLength(trace.length);
    expect(fromJSONL(text)).toEqual(JSON.parse(JSON.stringify(trace)));
    expect(tracePath(fromJSONL(text))).toEqual(["upper", "exclaim"]);
  });

  it("rejects malformed traces", () => {
    expect(() => assertTrace([])).toThrow(TaugraphError);
    expect(() => assertTrace([{ type: "enter" }])).toThrow(/run_start/);
    expect(() => fromJSONL("{nope")).toThrow(/Line 1/);
    const start = {
      seq: 0,
      runId: "r",
      type: "run_start",
      timestamp: 1,
      meta: { format: "taugraph.trace", version: 99 },
    };
    expect(() => assertTrace([start])).toThrow(/Unsupported trace version 99/);
    const ok = { ...start, meta: { format: "taugraph.trace", version: 1 } };
    expect(() => assertTrace([ok, { seq: 2, runId: "r", type: "enter", timestamp: 1 }])).toThrow(/seq/);
  });
});

describe("ctx.trace.append", () => {
  const run = (append: (ctx: Parameters<Parameters<typeof createGraph>[1]["nodes"][string]>[1]) => void) =>
    createGraph(schema, {
      start: "a",
      nodes: {
        a: (s, ctx) => {
          append(ctx);
          return s;
        },
      },
      endNodes: ["a"],
    }).run({ text: "x" });

  it("rejects kernel event types", async () => {
    const error = await run((ctx) => ctx.trace.append({ type: "exit" })).catch((e: TaugraphError) => e);
    expect((error as TaugraphError).code).toBe("INVALID_EVENT");
    expect((error as TaugraphError).message).toMatch(/reserved for the kernel/);
  });

  it("rejects payloads that are not plain JSON", async () => {
    const error = await run((ctx) => ctx.trace.append({ type: "tool_call", output: new Map() })).catch(
      (e: TaugraphError) => e,
    );
    expect((error as TaugraphError).code).toBe("INVALID_EVENT");
    expect((error as TaugraphError).message).toMatch(/Map is not a plain object/);
  });

  it("copies payloads so later mutation cannot rewrite history", async () => {
    const payload = { items: ["a"] };
    const { trace } = await run((ctx) => {
      ctx.trace.append({ type: "tool_call", output: payload });
      payload.items.push("b");
    });
    expect(trace.find((e) => e.type === "tool_call")?.output).toEqual({ items: ["a"] });
  });

  it("rejects appends after the step has finished", async () => {
    let saved: { trace: { append: (e: { type: string }) => void } } | undefined;
    await run((ctx) => {
      saved = ctx;
    });
    expect(() => saved?.trace.append({ type: "tool_call" })).toThrow(/after its step finished/);
  });
});
