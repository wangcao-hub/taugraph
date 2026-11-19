import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, TaugraphError } from "../src/index.js";
import { CodeNode } from "../src/nodes/index.js";

const schema = z.object({
  count: z.number().int(),
  log: z.array(z.string()).default([]),
});
type State = z.infer<typeof schema>;

const push = (label: string) => (s: State) => ({ ...s, count: s.count + 1, log: [...s.log, label] });

async function failure(promise: Promise<unknown>): Promise<TaugraphError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TaugraphError);
    return error as TaugraphError;
  }
  throw new Error("expected the run to fail");
}

describe("runtime", () => {
  it("runs a sequential graph and returns the final state and path", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: push("a"), b: push("b"), c: push("c") },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      endNodes: ["c"],
    });
    const result = await graph.run({ count: 0 });
    expect(result.state).toEqual({ count: 3, log: ["a", "b", "c"] });
    expect(result.path).toEqual(["a", "b", "c"]);
  });

  it("follows conditional edges, including loops", async () => {
    const graph = createGraph(schema, {
      start: "inc",
      nodes: { inc: push("inc"), done: CodeNode((s) => ({ ...s, log: [...s.log, "done"] })) },
      conditionalEdges: [{ from: "inc", route: (s) => (s.count < 3 ? "inc" : "done"), targets: ["inc", "done"] }],
      endNodes: ["done"],
    });
    const result = await graph.run({ count: 0 });
    expect(result.path).toEqual(["inc", "inc", "inc", "done"]);
    expect(result.state.count).toBe(3);
  });

  it("validates input against the schema and applies defaults", async () => {
    const graph = createGraph(schema, { start: "a", nodes: { a: (s) => s }, endNodes: ["a"] });
    expect((await graph.run({ count: 1 })).state).toEqual({ count: 1, log: [] });

    // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
    const error = await failure(graph.run({ count: "nope" } as any));
    expect(error.code).toBe("INVALID_STATE");
    expect(error.message).toMatch(/Run input failed schema validation/);
    expect(error.message).toMatch(/count/);
  });

  it("rejects node outputs that violate the schema with an explicit error", async () => {
    const graph = createGraph(schema, {
      start: "bad",
      // biome-ignore lint/suspicious/noExplicitAny: invalid output on purpose
      nodes: { bad: (s) => ({ ...s, count: 1.5 }) as any },
      endNodes: ["bad"],
    });
    const error = await failure(graph.run({ count: 0 }));
    expect(error.code).toBe("INVALID_STATE");
    expect(error.nodeId).toBe("bad");
    expect(error.step).toBe(0);
    expect(error.message).toMatch(/Node "bad" \(step 0\) returned invalid state/);
    expect(error.issues?.[0]?.path).toEqual(["count"]);
  });

  it("rejects state that is not plain JSON", async () => {
    const loose = z.object({ when: z.any() });
    const graph = createGraph(loose, {
      start: "a",
      nodes: { a: () => ({ when: new Date() }) },
      endNodes: ["a"],
    });
    const error = await failure(graph.run({ when: 1 }));
    expect(error.code).toBe("INVALID_STATE");
    expect(error.message).toMatch(/when: Date is not a plain object/);
  });

  it("passes deeply frozen state so nodes cannot mutate it in place", async () => {
    const graph = createGraph(schema, {
      start: "mutate",
      nodes: {
        mutate: (s) => {
          s.log.push("oops");
          return s;
        },
      },
      endNodes: ["mutate"],
    });
    const error = await failure(graph.run({ count: 0 }));
    expect(error.code).toBe("NODE_FAILED");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("wraps node exceptions as NODE_FAILED and attaches the trace", async () => {
    const boom = new Error("boom");
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: push("a"),
        b: () => {
          throw boom;
        },
      },
      edges: [{ from: "a", to: "b" }],
      endNodes: ["b"],
    });
    const error = await failure(graph.run({ count: 0 }));
    expect(error.code).toBe("NODE_FAILED");
    expect(error.nodeId).toBe("b");
    expect(error.cause).toBe(boom);
    expect(error.trace?.map((e) => e.type)).toEqual(["run_start", "enter", "exit", "enter", "error", "run_end"]);
    expect(error.trace?.at(-1)?.meta).toMatchObject({ status: "failed", error: { code: "NODE_FAILED", nodeId: "b" } });
  });

  it("rejects routes to unknown or undeclared nodes", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: push("a"), b: push("b"), c: push("c") },
      // biome-ignore lint/suspicious/noExplicitAny: unknown route on purpose
      conditionalEdges: [{ from: "a", route: (s) => (s.count > 5 ? "b" : ("nowhere" as any)) }],
      endNodes: ["b", "c"],
    });
    const error = await failure(graph.run({ count: 0 }));
    expect(error.code).toBe("INVALID_ROUTE");
    expect(error.message).toMatch(/returned "nowhere"/);

    const strict = createGraph(schema, {
      start: "a",
      nodes: { a: push("a"), b: push("b"), c: push("c") },
      conditionalEdges: [{ from: "a", route: () => "c", targets: ["b"] }],
      endNodes: ["b", "c"],
    });
    expect((await failure(strict.run({ count: 0 }))).message).toMatch(/not in its declared targets/);
  });

  it("explains async routers", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: push("a"), b: push("b") },
      // biome-ignore lint/suspicious/noExplicitAny: async router on purpose
      conditionalEdges: [{ from: "a", route: (async () => "b") as any }],
      endNodes: ["b"],
    });
    expect((await failure(graph.run({ count: 0 }))).message).toMatch(/Routers must be synchronous/);
  });

  it("stops unbounded loops with maxSteps", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: push("a"), b: push("b") },
      conditionalEdges: [{ from: "a", route: () => "a" }],
      endNodes: ["b"],
    });
    const error = await failure(graph.run({ count: 0 }, { maxSteps: 5 }));
    expect(error.code).toBe("MAX_STEPS");
    expect(error.trace?.filter((e) => e.type === "exit")).toHaveLength(5);
  });

  it("retries a node up to retry.maxAttempts", async () => {
    let calls = 0;
    const flaky = CodeNode<State>(
      (s) => {
        calls++;
        if (calls < 3) throw new Error(`fail ${calls}`);
        return { ...s, count: calls };
      },
      { retry: { maxAttempts: 3 } },
    );
    const graph = createGraph(schema, { start: "flaky", nodes: { flaky }, endNodes: ["flaky"] });
    const result = await graph.run({ count: 0 });
    expect(result.state.count).toBe(3);
    const errors = result.trace.filter((e) => e.type === "error");
    expect(errors.map((e) => e.meta?.willRetry)).toEqual([true, true]);
    expect(result.trace.filter((e) => e.type === "enter").map((e) => e.meta?.attempt)).toEqual([1, 2, 3]);
  });

  it("gives up after the last attempt", async () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: CodeNode<State>(
          () => {
            throw new Error("always");
          },
          { retry: { maxAttempts: 2 } },
        ),
      },
      endNodes: ["a"],
    });
    const error = await failure(graph.run({ count: 0 }));
    expect(error.trace?.filter((e) => e.type === "error").map((e) => e.meta?.willRetry)).toEqual([true, false]);
  });

  it("aborts a run even when the node ignores the signal", async () => {
    const controller = new AbortController();
    const graph = createGraph(schema, {
      start: "slow",
      nodes: { slow: (s) => new Promise<State>((resolve) => setTimeout(() => resolve(s), 1_000)) },
      endNodes: ["slow"],
    });
    const pending = graph.run({ count: 0 }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user cancelled")), 10);
    const error = await failure(pending);
    expect(error.code).toBe("ABORTED");
    expect(error.trace?.at(-1)?.meta).toMatchObject({ status: "failed" });
  });

  it("does not start when the signal is already aborted", async () => {
    let ran = false;
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s) => {
          ran = true;
          return s;
        },
      },
      endNodes: ["a"],
    });
    const error = await failure(graph.run({ count: 0 }, { signal: AbortSignal.abort() }));
    expect(error.code).toBe("ABORTED");
    expect(ran).toBe(false);
  });
});

describe("runSync", () => {
  it("runs synchronous graphs without Promises", () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: push("a"), b: push("b") },
      edges: [{ from: "a", to: "b" }],
      endNodes: ["b"],
    });
    const result = graph.runSync({ count: 0 });
    expect(result.state).toEqual({ count: 2, log: ["a", "b"] });
  });

  it("fails clearly when a node is async", () => {
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: async (s) => s },
      endNodes: ["a"],
    });
    let error: TaugraphError | undefined;
    try {
      graph.runSync({ count: 0 });
    } catch (e) {
      error = e as TaugraphError;
    }
    expect(error?.code).toBe("ASYNC_IN_SYNC_RUN");
    expect(error?.nodeId).toBe("a");
    expect(error?.message).toMatch(/Use run\(\)/);
  });
});
