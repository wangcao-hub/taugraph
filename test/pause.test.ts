import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, fromJSONL, type TaugraphError, type TraceEvent, toJSONL } from "../src/index.js";
import { CodeNode, HumanNode } from "../src/nodes/index.js";

const schema = z.object({
  item: z.string(),
  qty: z.number().int().default(1),
  approved: z.boolean().nullable().default(null),
  log: z.array(z.string()).default([]),
});
type State = z.infer<typeof schema>;

function approvalGraph() {
  let asked = 0;
  const graph = createGraph(schema, {
    start: "prepare",
    nodes: {
      prepare: CodeNode((s) => ({ ...s, log: [...s.log, "prepare"] })),
      approve: (s, ctx) => {
        asked++;
        const ok = ctx.interrupt<boolean>({ question: `Buy ${s.qty} x ${s.item}?` });
        return { ...s, approved: ok, log: [...s.log, `approve:${ok}`] };
      },
      finish: CodeNode((s) => ({ ...s, log: [...s.log, "finish"] })),
    },
    edges: [
      { from: "prepare", to: "approve" },
      { from: "approve", to: "finish" },
    ],
    endNodes: ["finish"],
  });
  return { graph, asked: () => asked };
}

async function failure(promise: Promise<unknown>): Promise<TaugraphError> {
  try {
    await promise;
  } catch (error) {
    return error as TaugraphError;
  }
  throw new Error("expected a failure");
}

describe("pause", () => {
  it("returns a paused result with the pending request", async () => {
    const { graph } = approvalGraph();
    const result = await graph.run({ item: "book" });
    expect(result.status).toBe("paused");
    if (result.status !== "paused") return;
    expect(result.pending).toEqual({ nodeId: "approve", step: 1, request: { question: "Buy 1 x book?" } });
    expect(result.state).toMatchObject({ item: "book", approved: null, log: ["prepare"] });
    expect(result.path).toEqual(["prepare", "approve"]);
    expect(result.trace.map((e) => e.type)).toEqual(["run_start", "enter", "exit", "enter", "pause", "run_end"]);
    expect(result.trace.at(-1)?.meta).toMatchObject({ status: "paused", pending: { nodeId: "approve", step: 1 } });
  });

  it("rejects interrupt requests that are not plain JSON", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s, ctx) => {
          ctx.interrupt(new Map());
          return s;
        },
      },
      endNodes: ["a"],
    });
    expect((await failure(graph.run({ item: "x" }))).code).toBe("INVALID_EVENT");
  });

  it("pauses even when the node swallows the pause signal", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s, ctx) => {
          try {
            ctx.interrupt("ok?");
          } catch {
            // a careless try/catch must not turn a pause into a normal return
          }
          return { ...s, approved: true };
        },
      },
      endNodes: ["a"],
    });
    const result = await graph.run({ item: "x" });
    expect(result.status).toBe("paused");
    expect(result.trace.some((e) => e.type === "exit")).toBe(false);
  });
});

describe("resume", () => {
  it("continues the same run and appends to the same trace", async () => {
    const { graph, asked } = approvalGraph();
    const paused = await graph.run({ item: "book" }, { runId: "run-7" });
    const seen: string[] = [];
    const done = await graph.resume(paused.trace, true, { onEvent: (e) => seen.push(e.type) });

    expect(done.status).toBe("completed");
    expect(done.runId).toBe("run-7");
    expect(done.state).toMatchObject({ approved: true, log: ["prepare", "approve:true", "finish"] });
    expect(done.path).toEqual(["prepare", "approve", "finish"]);
    expect(done.trace.slice(0, paused.trace.length)).toEqual(paused.trace); // append-only
    expect(done.trace.map((e) => e.seq)).toEqual(done.trace.map((_, i) => i));
    expect(seen).toEqual(["resume", "enter", "exit", "enter", "exit", "run_end"]); // only new events
    const resume = done.trace[paused.trace.length] as TraceEvent;
    expect(resume).toMatchObject({
      type: "resume",
      nodeId: "approve",
      step: 1,
      input: true,
      meta: { reason: "paused" },
    });
    expect(asked()).toBe(2); // code before interrupt() runs again on resume
  });

  it("survives a process restart through JSONL", async () => {
    const { graph } = approvalGraph();
    const paused = await graph.run({ item: "book" });
    const done = await graph.resume(fromJSONL(toJSONL(paused.trace)), false);
    expect(done.state.log).toEqual(["prepare", "approve:false", "finish"]);
  });

  it("feeds the n-th interrupt the n-th value", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s, ctx) => {
          const item = ctx.interrupt<string>("item?");
          const qty = ctx.interrupt<number>("qty?");
          return { ...s, item, qty };
        },
      },
      endNodes: ["a"],
    });
    const first = await graph.run({ item: "" });
    const second = await graph.resume(first.trace, "pen");
    expect(second.status === "paused" && second.pending.request).toBe("qty?");
    const done = await graph.resume(second.trace, 3);
    expect(done.state).toMatchObject({ item: "pen", qty: 3 });
  });

  it("gives every visit of a looping node its own answers", async () => {
    const graph = createGraph(schema, {
      start: "ask",
      nodes: {
        ask: HumanNode<State, string>({
          ask: (s) => `round ${s.log.length}`,
          update: (s, word) => ({ ...s, log: [...s.log, word] }),
        }),
        done: (s) => s,
      },
      conditionalEdges: [{ from: "ask", route: (s) => (s.log.at(-1) === "stop" ? "done" : "ask") }],
      endNodes: ["done"],
    });
    let result = await graph.run({ item: "x" });
    for (const word of ["a", "b", "stop"]) result = await graph.resume(result.trace, word);
    expect(result.status).toBe("completed");
    expect(result.state.log).toEqual(["a", "b", "stop"]);
    expect(result.path).toEqual(["ask", "ask", "ask", "done"]);
  });

  it("works synchronously", () => {
    const { graph } = approvalGraph();
    const paused = graph.runSync({ item: "book" });
    expect(graph.resumeSync(paused.trace, true).state.approved).toBe(true);
  });

  it("rejects completed and failed runs without touching the trace", async () => {
    const { graph } = approvalGraph();
    const done = await graph.resume((await graph.run({ item: "b" })).trace, true);
    expect((await failure(graph.resume(done.trace, true))).code).toBe("NOT_RESUMABLE");

    const broken = createGraph(schema, {
      start: "a",
      nodes: {
        a: () => {
          throw new Error("boom");
        },
      },
      endNodes: ["a"],
    });
    const failed = await failure(broken.run({ item: "x" }));
    const error = await failure(broken.resume(failed.trace ?? []));
    expect(error.code).toBe("NOT_RESUMABLE");
    expect(error.message).toMatch(/replay/);
    expect(error.trace).toBeUndefined();
  });

  it("rejects resume values that are not plain JSON", async () => {
    const { graph } = approvalGraph();
    const paused = await graph.run({ item: "b" });
    const error = await failure(graph.resume(paused.trace, new Date()));
    expect(error.code).toBe("INVALID_STATE");
    expect(error.trace).toBeUndefined();
  });
});

describe("HumanNode", () => {
  it("asks again with the validation error when the answer is invalid", async () => {
    const graph = createGraph(schema, {
      start: "qty",
      nodes: {
        qty: HumanNode<State, number>({
          ask: (s, error) => ({ question: `How many ${s.item}?`, ...(error && { error }) }),
          answer: z.number().int().positive(),
          update: (s, qty) => ({ ...s, qty }),
        }),
      },
      endNodes: ["qty"],
    });
    const first = await graph.run({ item: "pens" });
    const retry = await graph.resume(first.trace, -2);
    expect(retry.status).toBe("paused");
    if (retry.status !== "paused") return;
    expect(retry.pending.request).toMatchObject({ question: "How many pens?", error: expect.any(String) });
    const done = await graph.resume(retry.trace, 4);
    expect(done.state.qty).toBe(4);
    expect(done.trace.find((e) => e.type === "enter")?.meta).toMatchObject({ kind: "human" });
  });
});

describe("replay with recorded answers", () => {
  it("reuses human answers when the state matches, in live mode too", async () => {
    const { graph } = approvalGraph();
    const done = await graph.resume((await graph.run({ item: "book" })).trace, true);
    const replayed = await graph.replay(done.trace, { mode: "live" });
    expect(replayed.status).toBe("completed");
    expect(replayed.state).toEqual(done.state);
    expect(replayed.trace.find((e) => e.type === "resume")?.meta).toMatchObject({ reason: "replayed" });
    // a replay is itself replayable
    expect((await graph.replay(replayed.trace, { mode: "live" })).state).toEqual(done.state);
  });

  it("reuses answers when the human node is the start node", async () => {
    const graph = createGraph(schema, {
      start: "ask",
      nodes: {
        ask: (s, ctx) => ({ ...s, approved: ctx.interrupt<boolean>("ok?") }),
        done: (s) => s,
      },
      edges: [{ from: "ask", to: "done" }],
      endNodes: ["done"],
    });
    const done = await graph.resume((await graph.run({ item: "x" })).trace, true);
    const replayed = await graph.replay(done.trace, { mode: "live" });
    expect(replayed.status).toBe("completed");
    expect(replayed.state.approved).toBe(true);
  });

  it("pauses when the state differs from the recording", async () => {
    const { graph } = approvalGraph();
    const done = await graph.resume((await graph.run({ item: "book" })).trace, true);
    const replayed = await graph.replay(done.trace, {
      overrides: { prepare: CodeNode((s) => ({ ...s, qty: 5, log: [...s.log, "prepare"] })) },
    });
    expect(replayed.status).toBe("paused");
    expect(replayed.status === "paused" && replayed.pending.request).toEqual({ question: "Buy 5 x book?" });
  });
});
