import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, isTaugraphError, type Node, type TaugraphError, type TraceEvent } from "../src/index.js";
import { CodeNode } from "../src/nodes/index.js";

const schema = z.object({ n: z.number() });
type State = z.infer<typeof schema>;
const single = (node: Node<State>) => createGraph(schema, { start: "a", nodes: { a: node }, endNodes: ["a"] });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function failure(promise: Promise<unknown>): Promise<TaugraphError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (e: unknown) => e,
  );
  if (!isTaugraphError(error)) throw error;
  return error;
}

describe("async onEvent", () => {
  it("stores every event in order, one call at a time, even when calls take different times", async () => {
    let active = 0;
    let overlap = false;
    const stored: number[] = [];
    const onEvent = async (event: TraceEvent) => {
      active++;
      if (active > 1) overlap = true;
      await sleep(event.seq % 2 === 0 ? 15 : 1);
      stored.push(event.seq);
      active--;
    };
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: CodeNode<State>((s, ctx) => {
          for (const i of [1, 2, 3]) ctx.trace.append({ type: "tool_call", output: i });
          return { n: s.n + 1 };
        }),
        b: CodeNode<State>((s) => ({ n: s.n + 1 })),
      },
      edges: [{ from: "a", to: "b" }],
      endNodes: ["b"],
    });
    const { trace } = await graph.run({ n: 0 }, { onEvent });
    expect(stored).toEqual(trace.map((e) => e.seq));
    expect(overlap).toBe(false);
  });

  it("stores a write step's enter before the node runs", async () => {
    const log: string[] = [];
    const place = CodeNode<State>(
      (s) => {
        log.push("node ran");
        return s;
      },
      { effect: "write" },
    );
    await single(place).run(
      { n: 0 },
      {
        onEvent: async (e) => {
          await sleep(10);
          log.push(`stored ${e.type}`);
        },
      },
    );
    expect(log).toEqual(["stored run_start", "stored enter", "node ran", "stored exit", "stored run_end"]);
  });

  it("fails the step when an event the node appended cannot be stored", async () => {
    const node = CodeNode<State>((s, ctx) => {
      ctx.trace.append({ type: "tool_call" });
      return s;
    });
    const onEvent = async (e: TraceEvent) => {
      await sleep(1);
      if (e.type === "tool_call") throw new Error("disk full");
    };
    const error = await failure(single(node).run({ n: 0 }, { onEvent }));
    expect(error.code).toBe("SINK_FAILED");
    expect(error.message).toMatch(/disk full/);
    expect(error.trace?.some((e) => e.type === "exit")).toBe(false);
    expect(error.trace?.at(-1)?.meta).toMatchObject({ status: "failed", error: { code: "SINK_FAILED" } });
  });

  it("does not run a write node whose enter cannot be stored", async () => {
    let ran = 0;
    const place = CodeNode<State>(
      (s) => {
        ran++;
        return s;
      },
      { effect: "write" },
    );
    const onEvent = async (e: TraceEvent) => {
      if (e.type === "enter") throw new Error("disk full");
    };
    const error = await failure(single(place).run({ n: 0 }, { onEvent }));
    expect(error.code).toBe("SINK_FAILED");
    expect(ran).toBe(0);
  });

  it("still hands run_end to the sink when the run fails, and ignores the sink failing then", async () => {
    const types: string[] = [];
    const node = CodeNode<State>(() => {
      throw new Error("boom");
    });
    const onEvent = async (e: TraceEvent) => {
      await sleep(5);
      types.push(e.type);
      if (e.type === "run_end") throw new Error("sink down too");
    };
    const error = await failure(single(node).run({ n: 0 }, { onEvent }));
    expect(error.code).toBe("NODE_FAILED");
    expect(types).toEqual(["run_start", "enter", "error", "run_end"]);
  });

  it("stops at once when the run is aborted, without waiting for the sink", async () => {
    const controller = new AbortController();
    const onEvent = (e: TraceEvent) => (e.type === "enter" ? new Promise<void>(() => {}) : undefined);
    const started = Date.now();
    const pending = single(CodeNode<State>((s) => s)).run({ n: 0 }, { onEvent, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await failure(pending);
    expect(error.code).toBe("ABORTED");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("refuses an async sink in runSync and stops calling it", async () => {
    const types: string[] = [];
    let error: unknown;
    try {
      single(CodeNode<State>((s) => s)).runSync(
        { n: 0 },
        {
          onEvent: async (e) => {
            types.push(e.type);
          },
        },
      );
    } catch (e) {
      error = e;
    }
    expect(isTaugraphError(error) && error.code).toBe("ASYNC_IN_SYNC_RUN");
    expect((error as Error).message).toBe("onEvent returned a Promise; use run() for an async sink");
    await sleep(10);
    expect(types).toEqual(["run_start"]);
  });

  it("works across pause and resume", async () => {
    const graph = createGraph(schema, {
      start: "ask",
      nodes: { ask: (_s: State, ctx) => ({ n: ctx.interrupt<number>("n?") }) },
      endNodes: ["ask"],
    });
    const first: number[] = [];
    const sink = (into: number[]) => async (e: TraceEvent) => {
      await sleep(2);
      into.push(e.seq);
    };
    const paused = await graph.run({ n: 0 }, { onEvent: sink(first) });
    expect(first).toEqual(paused.trace.map((e) => e.seq));
    const second: number[] = [];
    const done = await graph.resume(paused.trace, 5, { onEvent: sink(second) });
    expect(done.state.n).toBe(5);
    expect(second).toEqual(done.trace.slice(paused.trace.length).map((e) => e.seq));
  });
});
