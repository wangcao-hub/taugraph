import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { retryDelay } from "../src/core/retry.js";
import {
  createGraph,
  isRetryable,
  isTaugraphError,
  type Node,
  type RetryPolicy,
  TaugraphError,
  type TaugraphErrorCode,
} from "../src/index.js";
import { CodeNode } from "../src/nodes/index.js";

const schema = z.object({ n: z.number() });
type State = z.infer<typeof schema>;
const single = (node: Node<State>) => createGraph(schema, { start: "a", nodes: { a: node }, endNodes: ["a"] });

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

function syncFailure(run: () => unknown): TaugraphError {
  try {
    run();
  } catch (error) {
    if (isTaugraphError(error)) return error;
    throw error;
  }
  throw new Error("expected the run to fail");
}

const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const nested = (depth: number, inner: unknown): unknown =>
  depth === 0 ? inner : new Error(`level ${depth}`, { cause: nested(depth - 1, inner) });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isRetryable", () => {
  it("refuses kernel errors that another attempt cannot fix", () => {
    const permanent: TaugraphErrorCode[] = [
      "INVALID_STATE",
      "INVALID_ROUTE",
      "INVALID_EVENT",
      "WRITE_BLOCKED",
      "UNKNOWN_OUTCOME",
      "NOT_RESUMABLE",
      "ABORTED",
      "ASYNC_IN_SYNC_RUN",
      "SINK_FAILED",
    ];
    for (const code of permanent) expect(isRetryable(new TaugraphError(code, "x")), code).toBe(false);
    expect(isRetryable(new TaugraphError("NODE_FAILED", "x"))).toBe(true);
    expect(isRetryable(new TaugraphError("MAX_STEPS", "x"))).toBe(true);
  });

  it("refuses 4xx except 408, 409, 425 and 429, on the error or its cause chain", () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryable(withStatus(status)), String(status)).toBe(false);
    for (const status of [408, 409, 425, 429, 500, 502, 503])
      expect(isRetryable(withStatus(status)), String(status)).toBe(true);
    expect(isRetryable(nested(1, withStatus(404)))).toBe(false);
    expect(isRetryable(nested(5, { status: 400 }))).toBe(false);
    expect(isRetryable(nested(6, { status: 400 }))).toBe(true); // deeper than 5 levels of cause
    expect(isRetryable(Object.assign(new Error("outer"), { status: 503, cause: withStatus(400) }))).toBe(true); // nearest wins
    expect(isRetryable({ status: "400" })).toBe(true); // only numbers count
  });

  it("retries everything else, including errors it knows nothing about", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryable("a string")).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
    expect(isRetryable(null)).toBe(true);
  });
});

describe("retryDelay", () => {
  const policy: RetryPolicy = { maxAttempts: 5 };
  it("backs off exponentially with jitter, up to maxMs", () => {
    expect([1, 2, 3].map((n) => retryDelay(policy, n, new Error("x"), () => 0))).toEqual([500, 1000, 2000]);
    expect(retryDelay(policy, 1, new Error("x"), () => 1)).toBe(250);
    expect(retryDelay(policy, 10, new Error("x"), () => 0)).toBe(30_000);
    const custom: RetryPolicy = { maxAttempts: 5, backoff: { initialMs: 1000, factor: 3, maxMs: 5000, jitter: 0 } };
    expect([1, 2, 3].map((n) => retryDelay(custom, n, new Error("x")))).toEqual([1000, 3000, 5000]);
    expect(retryDelay({ maxAttempts: 5, backoff: false }, 3, new Error("x"))).toBe(0);
  });

  it("waits at least retryAfterMs from the error or its cause chain, beyond maxMs", () => {
    const slowDown = Object.assign(new Error("429"), { retryAfterMs: 60_000 });
    expect(retryDelay(policy, 1, slowDown, () => 0)).toBe(60_000);
    expect(retryDelay(policy, 1, nested(2, { retryAfterMs: 100 }), () => 0)).toBe(500);
    expect(retryDelay({ maxAttempts: 2, backoff: false }, 1, nested(1, { retryAfterMs: 2000 }))).toBe(2000);
    expect(retryDelay(policy, 1, { retryAfterMs: 1e12 }, () => 0)).toBe(2_147_483_647);
  });
});

describe("retries in a run", () => {
  it("waits between attempts, records the wait, and keeps one idempotency key per step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const keys: string[] = [];
    const node = CodeNode<State>(
      (_s, ctx) => {
        keys.push(ctx.meta.idempotencyKey);
        if (keys.length < 3) throw new Error("flaky");
        return { n: keys.length };
      },
      { retry: { maxAttempts: 3 } },
    );
    const pending = single(node).run({ n: 0 }, { runId: "r1" });
    await vi.advanceTimersByTimeAsync(499);
    expect(keys).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(keys).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    const { state, trace } = await pending;
    expect(state.n).toBe(3);
    expect(keys).toEqual(["r1:0", "r1:0", "r1:0"]);
    expect(trace.filter((e) => e.type === "error").map((e) => e.meta?.delayMs)).toEqual([500, 1000]);
  });

  it("waits at least retryAfterMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    const node = CodeNode<State>(
      (s) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("slow down"), { status: 429, retryAfterMs: 5000 });
        return s;
      },
      { retry: { maxAttempts: 2 } },
    );
    const pending = single(node).run({ n: 0 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const { trace } = await pending;
    expect(calls).toBe(2);
    expect(trace.find((e) => e.type === "error")?.meta?.delayMs).toBe(5000);
  });

  it("retries at once with backoff: false", async () => {
    let calls = 0;
    const node = CodeNode<State>(
      (s) => {
        calls++;
        if (calls < 3) throw new Error("flaky");
        return s;
      },
      { retry: { maxAttempts: 3, backoff: false } },
    );
    const { trace } = await single(node).run({ n: 0 });
    expect(trace.filter((e) => e.type === "error").map((e) => e.meta?.delayMs)).toEqual([0, 0]);
  });

  it("stops waiting as soon as the run is aborted", async () => {
    const controller = new AbortController();
    const node = CodeNode<State>(
      () => {
        throw new Error("down");
      },
      { retry: { maxAttempts: 3, backoff: { initialMs: 60_000 } } },
    );
    const started = Date.now();
    const pending = single(node).run({ n: 0 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await failure(pending);
    expect(error.code).toBe("ABORTED");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error.trace?.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("blocks runSync for the wait", () => {
    let calls = 0;
    const node = CodeNode<State>(
      (s) => {
        calls++;
        if (calls === 1) throw new Error("flaky");
        return s;
      },
      { retry: { maxAttempts: 2, backoff: { initialMs: 30, jitter: 0 } } },
    );
    const started = Date.now();
    single(node).runSync({ n: 0 });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(29);
  });

  it("fails runSync where the thread may not block", () => {
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new TypeError("Atomics.wait cannot be called in this context");
    });
    const node = CodeNode<State>(
      () => {
        throw new Error("flaky");
      },
      { retry: { maxAttempts: 2, backoff: { initialMs: 30, jitter: 0 } } },
    );
    const error = syncFailure(() => single(node).runSync({ n: 0 }));
    expect(error.code).toBe("ASYNC_IN_SYNC_RUN");
    expect(error.message).toBe('Node "a" (step 0): runSync() cannot wait 30ms before retrying here; use run()');
    expect(error.nodeId).toBe("a");
  });

  it("gives up at once on a 4xx and on invalid state", async () => {
    let calls = 0;
    const badRequest = CodeNode<State>(
      () => {
        calls++;
        throw withStatus(400);
      },
      { retry: { maxAttempts: 3 } },
    );
    const first = await failure(single(badRequest).run({ n: 0 }));
    expect(calls).toBe(1);
    expect(first.trace?.filter((e) => e.type === "error").map((e) => e.meta?.willRetry)).toEqual([false]);

    let invalid = 0;
    const wrongState = CodeNode<State>(
      () => {
        invalid++;
        return { n: "x" } as never;
      },
      { retry: { maxAttempts: 3 } },
    );
    const second = await failure(single(wrongState).run({ n: 0 }));
    expect(second.code).toBe("INVALID_STATE");
    expect(invalid).toBe(1);
  });

  it("hands retryOn the error the node threw", async () => {
    const thrown = new Error("teapot");
    const seen: unknown[] = [];
    const node = CodeNode<State>(
      () => {
        throw thrown;
      },
      {
        retry: {
          maxAttempts: 3,
          backoff: false,
          retryOn: (error) => {
            seen.push(error);
            return seen.length < 2;
          },
        },
      },
    );
    const error = await failure(single(node).run({ n: 0 }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(thrown);
    expect(error.trace?.filter((e) => e.type === "error").map((e) => e.meta?.willRetry)).toEqual([true, false]);
  });

  it("fails the step without retrying when retryOn throws, after recording the attempt", async () => {
    const policyError = new TypeError("bad policy");
    let calls = 0;
    const node = CodeNode<State>(
      () => {
        calls++;
        throw new Error("original");
      },
      {
        retry: {
          maxAttempts: 3,
          backoff: false,
          retryOn: () => {
            throw policyError;
          },
        },
      },
    );
    const error = await failure(single(node).run({ n: 0 }));
    expect(error.code).toBe("NODE_FAILED");
    expect(error.nodeId).toBe("a");
    expect(error.message).toBe('Node "a" (step 0): retry.retryOn threw: bad policy');
    expect(error.cause).toBe(policyError);
    expect(calls).toBe(1);
    const errors = error.trace?.filter((e) => e.type === "error") ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.meta).toMatchObject({
      code: "NODE_FAILED",
      willRetry: false,
      message: expect.stringContaining("original"),
    });
    expect(errors[0]?.meta).not.toHaveProperty("delayMs");
  });

  it.each(["ABORTED", "ASYNC_IN_SYNC_RUN", "SINK_FAILED"] as const)(
    "never retries %s, even when retryOn says yes",
    async (code) => {
      let calls = 0;
      const node = CodeNode<State>(
        () => {
          calls++;
          throw new TaugraphError(code, "x");
        },
        { retry: { maxAttempts: 3, backoff: false, retryOn: () => true } },
      );
      const error = await failure(single(node).run({ n: 0 }));
      expect(error.code).toBe(code);
      expect(calls).toBe(1);
    },
  );

  it("does not wait when a replay reuses a recorded step", async () => {
    let calls = 0;
    const node = CodeNode<State>(
      (s) => {
        calls++;
        if (calls === 1) throw new Error("flaky");
        return { n: s.n + 1 };
      },
      { retry: { maxAttempts: 2, backoff: { initialMs: 200, jitter: 0 } } },
    );
    const graph = single(node);
    const { trace } = await graph.run({ n: 0 });
    const started = Date.now();
    const replay = await graph.replay(trace);
    expect(Date.now() - started).toBeLessThan(150);
    expect(calls).toBe(2);
    expect(replay.trace.some((e) => e.type === "error")).toBe(false);
  });
});

describe("write nodes and retries", () => {
  it("must declare idempotent to retry", () => {
    expect(() => CodeNode<State>((s) => s, { effect: "write", retry: { maxAttempts: 2 } })).toThrow(
      "defineNode: a write node with retry must set retry.idempotent: true (use ctx.meta.idempotencyKey to make repeats safe)",
    );
    const raw = Object.assign((s: State) => s, { effect: "write" as const, retry: { maxAttempts: 2 } });
    const error = syncFailure(() =>
      createGraph(schema, { start: "place", nodes: { place: raw }, endNodes: ["place"] }),
    );
    expect(error.code).toBe("INVALID_GRAPH");
    expect(error.message).toBe(
      'createGraph: node "place": a write node with retry must set retry.idempotent: true (use ctx.meta.idempotencyKey to make repeats safe)',
    );
  });

  it("retries an idempotent write under the same key", async () => {
    const keys: string[] = [];
    const place = CodeNode<State>(
      (s, ctx) => {
        keys.push(ctx.meta.idempotencyKey);
        if (keys.length === 1) throw new Error("connection reset");
        return { n: s.n + 1 };
      },
      { effect: "write", retry: { maxAttempts: 2, backoff: false, idempotent: true } },
    );
    const { state } = await single(place).run({ n: 0 }, { runId: "order-1" });
    expect(state.n).toBe(1);
    expect(keys).toEqual(["order-1:0", "order-1:0"]);
  });

  it("keeps the key when a crashed step is restarted", async () => {
    const keys: string[] = [];
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: CodeNode<State>((s) => s),
        place: CodeNode<State>(
          (s, ctx) => {
            keys.push(ctx.meta.idempotencyKey);
            return s;
          },
          { effect: "write" },
        ),
      },
      edges: [{ from: "a", to: "place" }],
      endNodes: ["place"],
    });
    const { trace } = await graph.run({ n: 0 }, { runId: "r9" });
    const enter = trace.findIndex((e) => e.type === "enter" && e.nodeId === "place");
    await graph.resume(trace.slice(0, enter + 1), undefined, { allowWrites: true });
    expect(keys).toEqual(["r9:1", "r9:1"]);
  });

  it("never retries a write node that skipped the checks", async () => {
    let calls = 0;
    const place = (_s: State): State => {
      calls++;
      throw new Error("flaky");
    };
    const graph = single(place);
    Object.assign(place, { retry: { maxAttempts: 3, backoff: false }, effect: "write" });
    const error = await failure(graph.run({ n: 0 }));
    expect(calls).toBe(1);
    expect(error.trace?.find((e) => e.type === "error")?.meta?.willRetry).toBe(false);
  });

  it("checks replay overrides", async () => {
    const graph = single(CodeNode<State>((s) => s));
    const { trace } = await graph.run({ n: 0 });
    const override = Object.assign((s: State) => s, { timeoutMs: 0 });
    const error = await failure(graph.replay(trace, { mode: "live", overrides: { a: override } }));
    expect(error.code).toBe("INVALID_GRAPH");
    expect(error.message).toBe('Override for node "a": timeoutMs must be an integer from 1 to 2147483647, got 0');
  });
});

describe("retry policy checks", () => {
  const define = (retry: RetryPolicy) => () => CodeNode<State>((s) => s, { retry });
  it("rejects a bad policy where the node is defined", () => {
    expect(define({ maxAttempts: 2, backoff: { factor: 0.5 } })).toThrow(
      "defineNode: retry.backoff.factor must be a finite number >= 1, got 0.5",
    );
    expect(define({ maxAttempts: 2, backoff: { jitter: 2 } })).toThrow(
      "defineNode: retry.backoff.jitter must be a number from 0 to 1, got 2",
    );
    expect(define({ maxAttempts: 2, backoff: { initialMs: -1 } })).toThrow(
      "defineNode: retry.backoff.initialMs must be a finite number >= 0, got -1",
    );
    expect(define({ maxAttempts: 2, backoff: { maxMs: Number.POSITIVE_INFINITY } })).toThrow(
      "defineNode: retry.backoff.maxMs must be a finite number >= 0, got Infinity",
    );
    expect(define({ maxAttempts: 2, retryOn: "yes" as never })).toThrow(
      "defineNode: retry.retryOn must be a function, got string",
    );
    expect(define(3 as never)).toThrow("defineNode: retry must be an object, got 3");
    expect(define({ maxAttempts: 2, backoff: true as never })).toThrow(
      "defineNode: retry.backoff must be false or an object, got true",
    );
    expect(define({ maxAttempts: 2, idempotent: "yes" as never })).toThrow(
      "defineNode: retry.idempotent must be a boolean, got yes",
    );
  });

  it("checks nodes built without defineNode in createGraph", () => {
    const raw = Object.assign((s: State) => s, { retry: { maxAttempts: 0 } });
    const error = syncFailure(() => createGraph(schema, { start: "a", nodes: { a: raw }, endNodes: ["a"] }));
    expect(error.code).toBe("INVALID_GRAPH");
    expect(error.message).toBe('createGraph: node "a": retry.maxAttempts must be an integer >= 1, got 0');
  });

  it("copies the policy, so changing the object later changes nothing", () => {
    const retry = { maxAttempts: 2, backoff: { initialMs: 0 } };
    const node = CodeNode<State>((s) => s, { retry });
    retry.backoff.initialMs = 99;
    expect(node.retry).toEqual({ maxAttempts: 2, backoff: { initialMs: 0 } });
    expect(Object.isFrozen(node.retry?.backoff)).toBe(true);
  });
});
