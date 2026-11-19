import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, type TaugraphError, type Trace } from "../src/index.js";
import { CodeNode } from "../src/nodes/index.js";

const schema = z.object({
  item: z.string(),
  price: z.number().nullable().default(null),
  orderId: z.string().nullable().default(null),
});
type State = z.infer<typeof schema>;

function shop() {
  const calls = { quote: 0, place: 0 };
  const recoveredFlags: boolean[] = [];
  const graph = createGraph(schema, {
    start: "quote",
    nodes: {
      quote: CodeNode((s) => {
        calls.quote++;
        return { ...s, price: 10 };
      }),
      place: CodeNode(
        (s, ctx) => {
          calls.place++;
          recoveredFlags.push(ctx.meta.recovered);
          return { ...s, orderId: `order-${calls.place}` };
        },
        { effect: "write" },
      ),
    },
    edges: [{ from: "quote", to: "place" }],
    endNodes: ["place"],
  });
  return { graph, calls, recoveredFlags };
}

async function failure(promise: Promise<unknown>): Promise<TaugraphError> {
  try {
    await promise;
  } catch (error) {
    return error as TaugraphError;
  }
  throw new Error("expected a failure");
}

/** Simulates a crash: the trace as it was on disk right after event `seq`. */
const cutAfter = (trace: Trace, predicate: (e: Trace[number]) => boolean): Trace =>
  trace.slice(0, trace.findIndex(predicate) + 1);

describe("effect: write", () => {
  it("is recorded on enter events", async () => {
    const { graph } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const enters = trace.filter((e) => e.type === "enter");
    expect(enters.map((e) => e.meta?.effect)).toEqual([undefined, "write"]);
  });

  it("is reused from the recording when the replay matches", async () => {
    const { graph, calls } = shop();
    const original = await graph.run({ item: "pen" });
    const replayed = await graph.replay(original.trace);
    expect(replayed.state.orderId).toBe("order-1");
    expect(calls.place).toBe(1);
  });

  it("is blocked when a replay would run it live", async () => {
    const { graph, calls } = shop();
    const original = await graph.run({ item: "pen" });
    const diverged = graph.replay(original.trace, {
      overrides: { quote: CodeNode<State>((s) => ({ ...s, price: 12 })) },
    });
    const error = await failure(diverged);
    expect(error.code).toBe("WRITE_BLOCKED");
    expect(error.nodeId).toBe("place");
    expect(error.message).toMatch(/allowWrites/);
    expect((await failure(graph.replay(original.trace, { mode: "live" }))).code).toBe("WRITE_BLOCKED");
    expect(calls.place).toBe(1);
  });

  it("runs live in a replay only with allowWrites or an override", async () => {
    const { graph, calls } = shop();
    const original = await graph.run({ item: "pen" });
    const mocked = await graph.replay(original.trace, {
      mode: "live",
      overrides: { place: CodeNode<State>((s) => ({ ...s, orderId: "mock" })) },
    });
    expect(mocked.state.orderId).toBe("mock");
    expect(calls.place).toBe(1);
    const real = await graph.replay(original.trace, { mode: "live", allowWrites: true });
    expect(real.state.orderId).toBe("order-2");
  });

  it("rejects unknown effect values", () => {
    // biome-ignore lint/suspicious/noExplicitAny: invalid value on purpose
    expect(() => CodeNode((s) => s, { effect: "delete" as any })).toThrow(/effect/);
  });
});

describe("resume after a crash", () => {
  it("continues after the last finished step", async () => {
    const { graph, calls } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const crashed = cutAfter(trace, (e) => e.type === "exit" && e.nodeId === "quote");
    const recovered = await graph.resume(crashed);
    expect(recovered.status).toBe("completed");
    expect(recovered.runId).toBe(trace[0]?.runId);
    expect(recovered.path).toEqual(["quote", "place"]);
    expect(calls).toEqual({ quote: 1, place: 2 });
    expect(recovered.trace[crashed.length]).toMatchObject({ type: "resume", meta: { reason: "recovered" } });
  });

  it("refuses to restart a write node whose outcome is unknown", async () => {
    const { graph, calls, recoveredFlags } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const crashed = cutAfter(trace, (e) => e.type === "enter" && e.nodeId === "place");
    const error = await failure(graph.resume(crashed));
    expect(error.code).toBe("UNKNOWN_OUTCOME");
    expect(error.nodeId).toBe("place");
    expect(error.trace).toBeUndefined();
    expect(calls.place).toBe(1);

    const recovered = await graph.resume(crashed, undefined, { allowWrites: true });
    expect(recovered.state.orderId).toBe("order-2");
    expect(recoveredFlags).toEqual([false, true]);
    expect(recovered.trace.filter((e) => e.type === "enter").at(-1)?.meta).toMatchObject({ recovered: true });
  });

  it("restarts an unfinished read node without asking", async () => {
    const { graph, calls } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const recovered = await graph.resume(cutAfter(trace, (e) => e.type === "enter" && e.nodeId === "quote"));
    expect(recovered.status).toBe("completed");
    expect(calls.quote).toBe(2);
  });

  it("starts from the beginning when only run_start was written", async () => {
    const { graph } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const recovered = await graph.resume(trace.slice(0, 1));
    expect(recovered.path).toEqual(["quote", "place"]);
  });

  it("only closes the run when the end node already finished", async () => {
    const { graph, calls } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const recovered = await graph.resume(trace.slice(0, -1));
    expect(recovered.state.orderId).toBe("order-1");
    expect(calls).toEqual({ quote: 1, place: 1 });
  });

  it("reuses a value that was delivered just before the crash", async () => {
    const graph = createGraph(schema, {
      start: "ask",
      nodes: { ask: (s, ctx) => ({ ...s, item: ctx.interrupt<string>("which item?") }) },
      endNodes: ["ask"],
    });
    const paused = await graph.run({ item: "" });
    const { trace } = await graph.resume(paused.trace, "lamp");
    const crashed = cutAfter(trace, (e) => e.type === "resume");
    const recovered = await graph.resume(crashed);
    expect(recovered.state.item).toBe("lamp");
  });

  it("rejects a value when the run is not paused", async () => {
    const { graph } = shop();
    const { trace } = await graph.run({ item: "pen" });
    const error = await failure(graph.resume(trace.slice(0, 2), "yes"));
    expect(error.code).toBe("NOT_RESUMABLE");
  });
});

describe("onEvent is a write-ahead sink", () => {
  it("stops the run before the next step when the sink fails", async () => {
    const { graph, calls } = shop();
    const sunk: string[] = [];
    const error = await failure(
      graph.run(
        { item: "pen" },
        {
          onEvent: (e) => {
            if (e.type === "exit") throw new Error("disk full");
            sunk.push(e.type);
          },
        },
      ),
    );
    expect(error.code).toBe("SINK_FAILED");
    expect(error.message).toMatch(/disk full/);
    expect(calls).toEqual({ quote: 1, place: 0 });
    expect(sunk).toEqual(["run_start", "enter"]);
    expect(error.trace?.at(-1)?.meta).toMatchObject({ status: "failed", error: { code: "SINK_FAILED" } });
  });

  it("is not retried and cannot be swallowed by a node", async () => {
    let attempts = 0;
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: CodeNode<State>(
          (s, ctx) => {
            attempts++;
            try {
              ctx.trace.append({ type: "tool_call" });
            } catch {
              // ignoring a logging failure must not let the run continue
            }
            return s;
          },
          { retry: { maxAttempts: 3 } },
        ),
      },
      endNodes: ["a"],
    });
    const onEvent = (e: { type: string }) => {
      if (e.type === "tool_call") throw new Error("sink down");
    };
    const error = await failure(graph.run({ item: "x" }, { onEvent }));
    expect(error.code).toBe("SINK_FAILED");
    expect(attempts).toBe(1);
  });
});
