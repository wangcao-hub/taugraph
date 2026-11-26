# Reliability (retries, timeouts, async sinks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retries wait and skip errors that cannot heal, write nodes only retry when declared idempotent, nodes and agent tools can time out, `onEvent` can be async, and `taugraph/openai` throws errors that carry the HTTP status.

**Architecture:** The engine generator gains two internal effects besides node results and validation Promises: `Wait` (sleep before a retry) and `SinkWait` (wait for an async sink). `driveAsync` awaits them (abortable); `driveSync` blocks with `Atomics.wait` for `Wait` and refuses `SinkWait`. Retry decisions live in a new `src/core/retry.ts` (`isRetryable`, `retryDelay`). A per-attempt deadline merges the run signal with a timer signal (`AbortSignal.any`) and races the node's Promise. `TraceLog` chains async sink calls in order and exposes the unfinished chain; the engine waits on it after every kernel event and before a step's `exit`.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), vitest (fake timers only for `setTimeout` / `clearTimeout`), Zod in tests only, biome.

Spec: `docs/superpowers/specs/2026-11-25-reliability-design.md`.

## Global Constraints

- Zero runtime dependencies. `src/core` stays platform-free: no `node:` imports, and no file outside `src/file` contains the words `process` or `Buffer` (an architecture test greps for them, comments included). Plugins (`src/nodes`, `src/agent`, `src/openai`) import only `../index.js`, `../nodes/index.js` (agent, openai) and their own files.
- `tsconfig.core.json` has no Node types; `setTimeout`, `AbortSignal.any`, `Atomics` and `SharedArrayBuffer` come from the `ES2022` and `DOM` libs.
- Retry rules, verbatim:
  - Not retried by `isRetryable`: `TaugraphError` with code `INVALID_STATE`, `INVALID_ROUTE`, `INVALID_EVENT`, `WRITE_BLOCKED`, `UNKNOWN_OUTCOME`, `NOT_RESUMABLE`, `ABORTED`, `ASYNC_IN_SYNC_RUN`, `SINK_FAILED`; any error whose nearest numeric `status` on itself or its `cause` chain (the error plus at most 5 levels of `cause`) is `400 <= status < 500`, except 408, 409, 425, 429. Everything else is retried, including unknown errors.
  - Never retried, whatever `retryOn` says: codes `ABORTED`, `ASYNC_IN_SYNC_RUN`, `SINK_FAILED`; and a `write` node whose `retry.idempotent` is not `true`.
  - Wait before retry number n (n = 1 for the first retry): `min(maxMs, initialMs * factor^(n-1)) * (1 - jitter * Math.random())`, defaults `initialMs 500`, `factor 2`, `maxMs 30000`, `jitter 0.5`; `backoff: false` makes it 0. A numeric `retryAfterMs` on the error or its `cause` chain wins when larger (not capped by `maxMs`). Rounded, capped at 2147483647.
  - `error` event `meta` gets `delayMs` when `willRetry` is true, and `outcome: "unknown"` when a `write` node failed with `TIMEOUT` or `ABORTED`.
  - `ctx.meta.idempotencyKey` is `` `${runId}:${step}` ``.
- Error texts, verbatim:
  - `defineNode: a write node with retry must set retry.idempotent: true (use ctx.meta.idempotencyKey to make repeats safe)`
  - `createGraph: node "<id>": <problem>` (code `INVALID_GRAPH`), where `<problem>` is the `defineNode` text without its `defineNode: ` prefix
  - `runSync() cannot wait <ms>ms before retrying here; use run()` (code `ASYNC_IN_SYNC_RUN`)
  - `Node "<id>" (step <n>) timed out after <ms>ms` (code `TIMEOUT`)
  - `Tool "<name>" timed out after <ms>ms`
  - `onEvent returned a Promise; use run() for an async sink` (code `ASYNC_IN_SYNC_RUN`)
  - `defineNode: timeoutMs must be an integer from 1 to 2147483647, got <x>`
  - `createAgent: timeoutMs must be an integer from 1 to 2147483647, got <x>`
  - `createAgent: tool "<name>" has timeoutMs <x>; use an integer from 1 to 2147483647`
  - `openAICompatible: tokenLimit must be "max_tokens" or "max_completion_tokens", got <x>`
  - `HTTPError.message`: `<url> responded <status>: <first 500 characters of the body>` (unchanged from today)
- Library text and code comments in English. `pnpm check` must pass after every task; `pnpm format` fixes formatting. biome does not format Markdown: keep table rows padded to the same width by hand.
- Work on branch `feat/reliability` (spec committed as `8db3a6f`). Commit after every task.

---

### Task 1: Retry policy, backoff and `isRetryable`

**Files:**

- Create: `src/core/retry.ts`
- Modify: `src/core/types.ts` (`RetryPolicy`, new `RetryBackoff`, `RunContext.meta.idempotencyKey`)
- Modify: `src/core/node.ts` (`defineNode`, new internal `nodeMetaProblem`)
- Modify: `src/core/graph.ts` (`compile` checks each node's retry policy)
- Modify: `src/core/engine.ts` (retry decision, `Wait` effect, both drivers, `idempotencyKey`)
- Modify: `src/index.ts` (export `isRetryable`, type `RetryBackoff`)
- Modify: `test/runtime.test.ts`, `test/nodes.test.ts` (existing retry tests use `backoff: false`)
- Test: `test/retry.test.ts` (new)

**Interfaces:**

- Produces (public): `isRetryable(error: unknown): boolean`; `RetryPolicy { maxAttempts; backoff?: false | RetryBackoff; retryOn?: (error: unknown) => boolean; idempotent?: boolean }`; `RetryBackoff { initialMs?; factor?; maxMs?; jitter? }`; `RunContext.meta.idempotencyKey: string`.
- Produces (internal, `src/core/retry.ts`): `FATAL: ReadonlySet<TaugraphErrorCode>`; `MAX_DELAY_MS = 2_147_483_647`; `retryDelay(policy: RetryPolicy, retry: number, error: unknown, random?: () => number): number`; `freezeRetry(retry: RetryPolicy): RetryPolicy`.
- Produces (internal, `src/core/node.ts`): `nodeMetaProblem(meta: NodeMeta): string | undefined`. Task 2 adds the `timeoutMs` check to it.
- Produces (internal, `src/core/engine.ts`): `class Wait { readonly ms: number }`, yielded by `runStep`, handled by `driveSync` / `driveAsync`. Task 4 adds a second effect next to it.

- [ ] **Step 1: Write the failing tests.** Create `test/retry.test.ts`:

```ts
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
      (s, ctx) => {
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
    expect(error.message).toBe("runSync() cannot wait 30ms before retrying here; use run()");
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

  it("does not wait when a replay reuses a recorded step", async () => {
    let calls = 0;
    const node = CodeNode<State>(
      (s) => {
        calls++;
        if (calls === 1) throw new Error("flaky");
        return { n: s.n + 1 };
      },
      { retry: { maxAttempts: 2, backoff: { initialMs: 50, jitter: 0 } } },
    );
    const graph = single(node);
    const { trace } = await graph.run({ n: 0 });
    const started = Date.now();
    const replay = await graph.replay(trace);
    expect(Date.now() - started).toBeLessThan(40);
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
    const graph = single(CodeNode<State>((s) => s, { effect: "write" }));
    const { trace } = await graph.run({ n: 0 });
    const override = Object.assign(
      (_s: State): State => {
        calls++;
        throw new Error("flaky");
      },
      { effect: "write" as const, retry: { maxAttempts: 3, backoff: false as const } },
    );
    const error = await failure(graph.replay(trace, { mode: "live", allowWrites: true, overrides: { a: override } }));
    expect(calls).toBe(1);
    expect(error.trace?.find((e) => e.type === "error")?.meta?.willRetry).toBe(false);
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
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm exec vitest run test/retry.test.ts`
Expected: FAIL. The import of `../src/core/retry.js` does not resolve, and `isRetryable` is not exported.

- [ ] **Step 3: Extend the types.** In `src/core/types.ts`, replace the `RetryPolicy` interface with:

```ts
export interface RetryBackoff {
  /** Wait before the first retry, in milliseconds. Default 500. */
  readonly initialMs?: number;
  /** Each further retry waits this many times longer. Default 2. */
  readonly factor?: number;
  /** Upper bound for the computed wait. Default 30_000. A longer `retryAfterMs` on the error still wins. */
  readonly maxMs?: number;
  /** Share of each wait taken off at random, 0 to 1. Default 0.5: a wait is 50% to 100% of the computed one. */
  readonly jitter?: number;
}

export interface RetryPolicy {
  /** Total attempts including the first one. Must be an integer >= 1. */
  readonly maxAttempts: number;
  /** Wait between attempts. Default `{ initialMs: 500, factor: 2, maxMs: 30_000, jitter: 0.5 }`; `false` retries at once. */
  readonly backoff?: false | RetryBackoff;
  /** Whether an error is worth another attempt. Gets the error the node threw. Default: `isRetryable`. */
  readonly retryOn?: (error: unknown) => boolean;
  /**
   * Required on `write` nodes with a retry policy: repeating the node is safe, for example because it passes
   * `ctx.meta.idempotencyKey` to an API that deduplicates.
   */
  readonly idempotent?: boolean;
}
```

In `RunContext.meta`, after `recovered`, add:

```ts
    /**
     * `<runId>:<step>`: the same for every attempt of this step, and when a crashed step is restarted. Pass it to an
     * API that deduplicates (an `Idempotency-Key` header, say) so a retried write takes effect once.
     */
    readonly idempotencyKey: string;
```

- [ ] **Step 4: Create `src/core/retry.ts`.**

```ts
import { TaugraphError, type TaugraphErrorCode } from "./errors.js";
import type { RetryPolicy } from "./types.js";

/** Kernel errors that another attempt cannot fix. */
const PERMANENT: ReadonlySet<TaugraphErrorCode> = new Set<TaugraphErrorCode>([
  "INVALID_STATE",
  "INVALID_ROUTE",
  "INVALID_EVENT",
  "WRITE_BLOCKED",
  "UNKNOWN_OUTCOME",
  "NOT_RESUMABLE",
  "ABORTED",
  "ASYNC_IN_SYNC_RUN",
  "SINK_FAILED",
]);

/** Never retried, whatever `retryOn` says: the run itself is stopping. */
export const FATAL: ReadonlySet<TaugraphErrorCode> = new Set<TaugraphErrorCode>([
  "ABORTED",
  "ASYNC_IN_SYNC_RUN",
  "SINK_FAILED",
]);

/** 4xx statuses that mean "later": request timeout, conflict, too early, too many requests. */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/** Levels of `cause` searched below the error itself. */
const CAUSE_DEPTH = 5;

/** The longest wait a timer can take (about 24.8 days); a longer one would fire at once. */
export const MAX_DELAY_MS = 2_147_483_647;

/** The nearest finite number under `key` on the error or its `cause` chain. */
function fromChain(error: unknown, key: "status" | "retryAfterMs"): number | undefined {
  let current = error;
  for (let depth = 0; depth <= CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    const value = (current as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether another attempt may succeed. False for kernel errors that a retry cannot fix (`INVALID_STATE`, `ABORTED`,
 * `SINK_FAILED`, ...) and for HTTP 4xx other than 408, 409, 425 and 429, read from a numeric `status` on the error or
 * its `cause` chain. True for everything else, including errors it knows nothing about.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TaugraphError && PERMANENT.has(error.code)) return false;
  const status = fromChain(error, "status");
  return status === undefined || status < 400 || status >= 500 || RETRYABLE_4XX.has(status);
}

/**
 * Milliseconds to wait before retry number `retry` (1 for the first): exponential backoff with jitter, or the error's
 * `retryAfterMs` when that is longer.
 */
export function retryDelay(
  policy: RetryPolicy,
  retry: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  let delay = 0;
  if (policy.backoff !== false) {
    const backoff = policy.backoff ?? {};
    const initialMs = backoff.initialMs ?? 500;
    const factor = backoff.factor ?? 2;
    const maxMs = backoff.maxMs ?? 30_000;
    const jitter = backoff.jitter ?? 0.5;
    delay = Math.min(maxMs, initialMs * factor ** (retry - 1)) * (1 - jitter * random());
  }
  const after = fromChain(error, "retryAfterMs");
  if (after !== undefined && after > delay) delay = after;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(delay)));
}

/** A frozen copy of a checked policy, so changing the object passed in cannot change the node. */
export function freezeRetry(retry: RetryPolicy): RetryPolicy {
  const { backoff } = retry;
  return Object.freeze({
    maxAttempts: retry.maxAttempts,
    ...(backoff !== undefined && { backoff: backoff === false ? false : Object.freeze({ ...backoff }) }),
    ...(retry.retryOn !== undefined && { retryOn: retry.retryOn }),
    ...(retry.idempotent !== undefined && { idempotent: retry.idempotent }),
  });
}
```

- [ ] **Step 5: Check policies in `defineNode` and `createGraph`.** Replace the body of `src/core/node.ts` with:

```ts
import { freezeRetry } from "./retry.js";
import type { Node, NodeFn, NodeMeta } from "./types.js";

const atLeast = (value: unknown, min: number): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= min;

/**
 * What is wrong with a node's retry policy, or undefined. `defineNode` and `createGraph` both check it, so a node
 * built without `defineNode` cannot slip past.
 */
export function nodeMetaProblem(meta: NodeMeta): string | undefined {
  const retry: unknown = meta.retry;
  if (retry === undefined) return undefined;
  if (typeof retry !== "object" || retry === null) return `retry must be an object, got ${String(retry)}`;
  const { maxAttempts, backoff, retryOn, idempotent } = retry as Record<string, unknown>;
  if (!(Number.isInteger(maxAttempts) && (maxAttempts as number) >= 1)) {
    return `retry.maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`;
  }
  if (backoff !== undefined && backoff !== false) {
    if (typeof backoff !== "object" || backoff === null) {
      return `retry.backoff must be false or an object, got ${String(backoff)}`;
    }
    const { initialMs, factor, maxMs, jitter } = backoff as Record<string, unknown>;
    if (initialMs !== undefined && !atLeast(initialMs, 0)) {
      return `retry.backoff.initialMs must be a finite number >= 0, got ${String(initialMs)}`;
    }
    if (factor !== undefined && !atLeast(factor, 1)) {
      return `retry.backoff.factor must be a finite number >= 1, got ${String(factor)}`;
    }
    if (maxMs !== undefined && !atLeast(maxMs, 0)) {
      return `retry.backoff.maxMs must be a finite number >= 0, got ${String(maxMs)}`;
    }
    if (jitter !== undefined && !(atLeast(jitter, 0) && (jitter as number) <= 1)) {
      return `retry.backoff.jitter must be a number from 0 to 1, got ${String(jitter)}`;
    }
  }
  if (retryOn !== undefined && typeof retryOn !== "function") {
    return `retry.retryOn must be a function, got ${typeof retryOn}`;
  }
  if (idempotent !== undefined && typeof idempotent !== "boolean") {
    return `retry.idempotent must be a boolean, got ${String(idempotent)}`;
  }
  if (meta.effect === "write" && idempotent !== true) {
    return "a write node with retry must set retry.idempotent: true (use ctx.meta.idempotencyKey to make repeats safe)";
  }
  return undefined;
}

/**
 * Wraps a node function with metadata (kind, retry policy, effect). This is the only hook
 * plugin node packages need: `CodeNode`, `LLMNode` and friends are built on it.
 */
export function defineNode<S>(fn: NodeFn<S>, meta: NodeMeta = {}): Node<S> {
  if (typeof fn !== "function") throw new TypeError("defineNode: expected a function");
  if (meta.effect !== undefined && meta.effect !== "read" && meta.effect !== "write") {
    throw new TypeError(`defineNode: effect must be "read" or "write", got ${String(meta.effect)}`);
  }
  const problem = nodeMetaProblem(meta);
  if (problem !== undefined) throw new TypeError(`defineNode: ${problem}`);
  const node: NodeFn<S> = (state, ctx) => fn(state, ctx);
  return Object.freeze(
    Object.assign(node, {
      ...(meta.kind !== undefined && { kind: meta.kind }),
      ...(meta.effect !== undefined && { effect: meta.effect }),
      ...(meta.retry !== undefined && { retry: freezeRetry(meta.retry) }),
    }),
  );
}
```

In `src/core/graph.ts`, add `import { nodeMetaProblem } from "./node.js";` and, in `compile`, replace

```ts
for (const id of ids) {
  if (typeof nodes[id] !== "function") fail(`Node "${id}" is not a function`);
}
```

with

```ts
for (const id of ids) {
  const node = nodes[id];
  if (typeof node !== "function") fail(`Node "${id}" is not a function`);
  const problem = nodeMetaProblem(node as Node<S>);
  if (problem !== undefined) fail(`createGraph: node "${id}": ${problem}`);
}
```

- [ ] **Step 6: Retry decisions and waits in the engine.** In `src/core/engine.ts`:

Add to the imports: `import { FATAL, isRetryable, retryDelay } from "./retry.js";`, and add `RetryPolicy` to the type import from `./types.js`. Delete the `NON_RETRYABLE` constant. After `NEVER_ABORTED`, add:

```ts
/** Yielded to wait before a retry: `run` sleeps, `runSync` blocks the thread. */
class Wait {
  constructor(readonly ms: number) {}
}
```

In `runStep`, replace the whole `catch (thrown) { ... }` block of the attempt loop with:

```ts
    } catch (thrown) {
      const error = asNodeError(thrown, nodeId, step);
      const willRetry = attempt < maxAttempts && shouldRetry(node, error, thrown);
      const delayMs = willRetry && node.retry ? retryDelay(node.retry, attempt, thrown) : 0;
      log.append({
        type: "error",
        nodeId,
        step,
        meta: { attempt, source, code: error.code, message: error.message, willRetry, ...(willRetry && { delayMs }) },
      });
      if (!willRetry) throw error;
      if (delayMs > 0) yield new Wait(delayMs);
    }
```

After `runStep`, add:

```ts
/** `retryOn` (or `isRetryable`) decides, except for a run that is stopping and for writes not declared idempotent. */
function shouldRetry<S>(node: Node<S>, error: TaugraphError, thrown: unknown): boolean {
  const retry: RetryPolicy | undefined = node.retry;
  if (!retry || FATAL.has(error.code)) return false;
  if (node.effect === "write" && retry.idempotent !== true) return false; // createGraph refuses these too
  return (retry.retryOn ?? isRetryable)(thrown);
}
```

In `createContext`, change the `meta` line to:

```ts
    meta: Object.freeze({
      runId: p.runId,
      nodeId,
      step,
      attempt: p.attempt,
      recovered: p.recovered,
      idempotencyKey: `${p.runId}:${step}`,
    }),
```

Replace both drivers and `abortable` (everything after the `// Drivers` banner) with:

```ts
export function driveSync<T>(effects: Effects<T>): T {
  let next = effects.next();
  while (!next.done) {
    const effect = next.value;
    if (effect instanceof Wait) {
      let failure: TaugraphError | undefined;
      try {
        blockFor(effect.ms);
      } catch (error) {
        failure = error as TaugraphError;
      }
      next = failure ? effects.throw(failure) : effects.next(undefined);
    } else if (isThenable(effect)) {
      Promise.resolve(effect).catch(() => {}); // the result is discarded; avoid an unhandled rejection
      next = effects.throw(
        new TaugraphError("ASYNC_IN_SYNC_RUN", "runSync() received a Promise. Use run() for async nodes or schemas."),
      );
    } else {
      next = effects.next(effect);
    }
  }
  return next.value;
}

/** Blocks the thread for `ms`. Throws ASYNC_IN_SYNC_RUN where blocking is not allowed, such as a browser's main thread. */
function blockFor(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (cause) {
    throw new TaugraphError("ASYNC_IN_SYNC_RUN", `runSync() cannot wait ${ms}ms before retrying here; use run()`, {
      cause,
    });
  }
}

export async function driveAsync<T>(effects: Effects<T>, signal?: AbortSignal): Promise<T> {
  let next = effects.next();
  while (!next.done) {
    const effect = next.value;
    let value: unknown;
    try {
      if (effect instanceof Wait) value = await sleep(effect.ms, signal);
      else value = isThenable(effect) ? await abortable(effect, signal) : effect;
    } catch (error) {
      next = effects.throw(error);
      continue;
    }
    next = effects.next(value);
  }
  return next.value;
}

/** Resolves after `ms`, or rejects with ABORTED as soon as the signal fires. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Stops waiting as soon as the signal fires, even if the node ignores the signal. */
function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
```

- [ ] **Step 7: Export.** In `src/index.ts`, after the `defineNode` export, add `export { isRetryable } from "./core/retry.js";`, and add `RetryBackoff,` to the type export list from `./core/types.js` (keep it sorted: before `RetryPolicy`).

- [ ] **Step 8: Keep existing retry tests fast.** In `test/runtime.test.ts`, in "retries a node up to retry.maxAttempts", change `{ retry: { maxAttempts: 3 } }` to `{ retry: { maxAttempts: 3, backoff: false } }` and add after the `willRetry` assertion:

```ts
expect(errors.map((e) => e.meta?.delayMs)).toEqual([0, 0]);
```

In "gives up after the last attempt", change `{ retry: { maxAttempts: 2 } }` to `{ retry: { maxAttempts: 2, backoff: false } }`. In `test/nodes.test.ts`, in "retries when structured output is invalid", change `retry: { maxAttempts: 3 },` to `retry: { maxAttempts: 3, backoff: false },`.

- [ ] **Step 9: Run the tests.**

Run: `pnpm exec vitest run test/retry.test.ts test/runtime.test.ts test/nodes.test.ts test/effects.test.ts`
Expected: PASS.

Run: `pnpm check`
Expected: PASS (typecheck, both tsconfigs; biome; all tests).

- [ ] **Step 10: Commit.**

```bash
git add src/core/retry.ts src/core/types.ts src/core/node.ts src/core/graph.ts src/core/engine.ts src/index.ts test/retry.test.ts test/runtime.test.ts test/nodes.test.ts
git commit -m "feat(core): retry backoff, isRetryable, idempotent writes"
```

---

### Task 2: Node timeouts in the kernel, `CodeNode` and `LLMNode`

**Files:**

- Modify: `src/core/errors.ts` (code `TIMEOUT`)
- Modify: `src/core/types.ts` (`NodeMeta.timeoutMs`)
- Modify: `src/core/node.ts` (`nodeMetaProblem` checks `timeoutMs`; `defineNode` copies it)
- Modify: `src/core/engine.ts` (per-attempt deadline, `outcome: "unknown"`)
- Modify: `src/nodes/code.ts` (`CodeNodeOptions.timeoutMs`)
- Modify: `src/nodes/llm.ts` (`timeoutMs` on `LLMNode` configs)
- Test: `test/timeout.test.ts` (new)

**Interfaces:**

- Consumes: `nodeMetaProblem`, `MAX_DELAY_MS`, `shouldRetry`, the attempt loop of `runStep` from Task 1.
- Produces (public): `TaugraphErrorCode` gains `"TIMEOUT"`; `NodeMeta.timeoutMs?: number`; `CodeNodeOptions.timeoutMs?: number`; `timeoutMs?: number` on `LLMTextNodeConfig` / `LLMStructuredNodeConfig`.
- Produces (internal, `src/core/engine.ts`): `startDeadline(run: AbortSignal, ms: number, error: TaugraphError): Deadline` with `{ signal, race<T>(p: PromiseLike<T>): Promise<T>, dispose(): void }`. Task 3 writes the same helper for the agent (plugins cannot import kernel internals).

- [ ] **Step 1: Write the failing tests.** Create `test/timeout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, isRetryable, isTaugraphError, type Node, TaugraphError } from "../src/index.js";
import { CodeNode, type LLMModel, LLMNode } from "../src/nodes/index.js";

const schema = z.object({ n: z.number() });
type State = z.infer<typeof schema>;
const single = (node: Node<State>) => createGraph(schema, { start: "a", nodes: { a: node }, endNodes: ["a"] });
const hang = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // keep the thread busy
  }
};

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

describe("timeoutMs", () => {
  it("fails a node whose Promise does not settle in time, and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const node = CodeNode<State>(
      (_s, ctx) => {
        signal = ctx.signal;
        return hang();
      },
      { timeoutMs: 20 },
    );
    const error = await failure(single(node).run({ n: 0 }));
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toBe('Node "a" (step 0) timed out after 20ms');
    expect(error).toMatchObject({ nodeId: "a", step: 0 });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(TaugraphError);
    expect((signal?.reason as TaugraphError).code).toBe("TIMEOUT");
    expect(isRetryable(error)).toBe(true);
    const event = error.trace?.find((e) => e.type === "error");
    expect(event?.meta).toMatchObject({ code: "TIMEOUT", willRetry: false });
    expect(event?.meta).not.toHaveProperty("outcome");
  });

  it("retries a timed-out attempt", async () => {
    let calls = 0;
    const node = CodeNode<State>(
      () => {
        calls++;
        return calls === 1 ? hang() : { n: calls };
      },
      { timeoutMs: 20, retry: { maxAttempts: 2, backoff: false } },
    );
    const { state, trace } = await single(node).run({ n: 0 });
    expect(state.n).toBe(2);
    expect(trace.find((e) => e.type === "error")?.meta).toMatchObject({ code: "TIMEOUT", willRetry: true });
  });

  it("marks a write node that timed out or was aborted as outcome unknown", async () => {
    const place = CodeNode<State>(() => hang(), { effect: "write", timeoutMs: 20 });
    const timedOut = await failure(single(place).run({ n: 0 }));
    expect(timedOut.trace?.find((e) => e.type === "error")?.meta).toMatchObject({
      code: "TIMEOUT",
      outcome: "unknown",
      willRetry: false,
    });

    const controller = new AbortController();
    const slow = CodeNode<State>(() => hang(), { effect: "write" });
    const pending = single(slow).run({ n: 0 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const aborted = await failure(pending);
    expect(aborted.code).toBe("ABORTED");
    expect(aborted.trace?.find((e) => e.type === "error")?.meta).toMatchObject({
      code: "ABORTED",
      outcome: "unknown",
    });
  });

  it("retries a timed-out write only when it is idempotent, under the same key", async () => {
    const keys: string[] = [];
    const place = CodeNode<State>(
      (s, ctx) => {
        keys.push(ctx.meta.idempotencyKey);
        return keys.length === 1 ? hang() : s;
      },
      { effect: "write", timeoutMs: 20, retry: { maxAttempts: 2, backoff: false, idempotent: true } },
    );
    await single(place).run({ n: 0 }, { runId: "r1" });
    expect(keys).toEqual(["r1:0", "r1:0"]);
  });

  it("cannot interrupt a synchronous node", async () => {
    const node = CodeNode<State>(
      (s) => {
        busy(30);
        return { n: s.n + 1 };
      },
      { timeoutMs: 5 },
    );
    expect((await single(node).run({ n: 0 })).state.n).toBe(1);
    expect(single(node).runSync({ n: 0 }).state.n).toBe(1);
  });

  it("drops a late result, a late event and a late rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let lateAppend: unknown;
      const node = CodeNode<State>(
        (_s, ctx) =>
          new Promise<State>((_resolve, reject) => {
            setTimeout(() => {
              try {
                ctx.trace.append({ type: "late" });
              } catch (error) {
                lateAppend = error;
              }
              reject(new Error("late"));
            }, 40);
          }),
        { timeoutMs: 10 },
      );
      const error = await failure(single(node).run({ n: 0 }));
      expect(error.code).toBe("TIMEOUT");
      await sleep(80);
      expect(lateAppend).toBeInstanceOf(TaugraphError);
      expect((lateAppend as TaugraphError).code).toBe("INVALID_EVENT");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("limits each LLMNode call and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const model: LLMModel = {
      id: "mock:slow",
      complete: (_request, options) => {
        signal = options.signal;
        return hang();
      },
    };
    const node = LLMNode<State>({ model, prompt: () => "hi", update: (s) => s, timeoutMs: 20 });
    expect(node.timeoutMs).toBe(20);
    const error = await failure(single(node).run({ n: 0 }));
    expect(error.code).toBe("TIMEOUT");
    expect(signal?.aborted).toBe(true);
  });

  it("checks timeoutMs where the node is defined, and in createGraph", () => {
    expect(() => CodeNode<State>((s) => s, { timeoutMs: 0 })).toThrow(
      "defineNode: timeoutMs must be an integer from 1 to 2147483647, got 0",
    );
    expect(() => CodeNode<State>((s) => s, { timeoutMs: 1.5 })).toThrow(
      "defineNode: timeoutMs must be an integer from 1 to 2147483647, got 1.5",
    );
    const raw = Object.assign((s: State) => s, { timeoutMs: -1 });
    let error: unknown;
    try {
      createGraph(schema, { start: "a", nodes: { a: raw }, endNodes: ["a"] });
    } catch (e) {
      error = e;
    }
    expect(isTaugraphError(error) && error.code).toBe("INVALID_GRAPH");
    expect((error as Error).message).toBe(
      'createGraph: node "a": timeoutMs must be an integer from 1 to 2147483647, got -1',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm exec vitest run test/timeout.test.ts`
Expected: FAIL. Typecheck in the editor complains about `timeoutMs`; at run time the first test hangs until vitest's timeout or fails because no `TIMEOUT` happens. (If it hangs, that is the expected failure; stop it.)

- [ ] **Step 3: Error code and types.** In `src/core/errors.ts`, after the `ABORTED` member of `TaugraphErrorCode`, add:

```ts
  /** A node's Promise did not settle within its `timeoutMs`. */
  | "TIMEOUT"
```

In `src/core/types.ts`, add to `NodeMeta` after `effect`:

```ts
  /**
   * Fails the attempt with TIMEOUT when the node's Promise has not settled after this many milliseconds, and aborts
   * `ctx.signal`. An integer from 1 to 2147483647. Synchronous code cannot be interrupted.
   */
  readonly timeoutMs?: number;
```

- [ ] **Step 4: Check and copy `timeoutMs`.** In `src/core/node.ts`, change the import to `import { freezeRetry, MAX_DELAY_MS } from "./retry.js";`, change the doc comment of `nodeMetaProblem` to start with "What is wrong with a node's retry policy or timeout, or undefined.", and insert at the top of its body, before `const retry: unknown = meta.retry;`:

```ts
  const { timeoutMs } = meta;
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_DELAY_MS)) {
    return `timeoutMs must be an integer from 1 to ${MAX_DELAY_MS}, got ${String(timeoutMs)}`;
  }
```

In `defineNode`, add after the `retry` spread:

```ts
      ...(meta.timeoutMs !== undefined && { timeoutMs: meta.timeoutMs }),
```

- [ ] **Step 5: The deadline in the engine.** In `src/core/engine.ts`, add after the `Wait` class:

```ts
/** A time limit for one attempt of a node. */
interface Deadline {
  /** The attempt's `ctx.signal`: aborts with the run, or with the TIMEOUT error when time is up. */
  readonly signal: AbortSignal;
  /** Settles like `promise`, unless time is up first; then it rejects with the TIMEOUT error. */
  race<T>(promise: PromiseLike<T>): Promise<T>;
  /** Clears the timer when the attempt ends. */
  dispose(): void;
}

function startDeadline(run: AbortSignal, ms: number, error: TaugraphError): Deadline {
  const timer = new AbortController();
  let expire: ((reason: unknown) => void) | undefined;
  const handle = setTimeout(() => {
    timer.abort(error);
    expire?.(error);
  }, ms);
  return {
    signal: AbortSignal.any([run, timer.signal]),
    race<T>(promise: PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        expire = reject;
        // A late result or rejection lands here after the race is settled, so it is dropped, never unhandled.
        Promise.resolve(promise).then(resolve, reject);
      });
    },
    dispose: () => clearTimeout(handle),
  };
}
```

In `runStep`'s attempt loop, replace

```ts
    const startedAt = Date.now();
    const control = createContext({ ...p, attempt, values });
    try {
      let output: unknown;
      let failure: { readonly error: unknown } | undefined;
      try {
        output = yield node(state, control.ctx);
      } catch (error) {
        failure = { error };
      } finally {
        control.close();
      }
```

with

```ts
    const startedAt = Date.now();
    const { timeoutMs } = node;
    const deadline =
      timeoutMs === undefined
        ? undefined
        : startDeadline(
            p.signal,
            timeoutMs,
            new TaugraphError("TIMEOUT", `Node "${nodeId}" (step ${step}) timed out after ${timeoutMs}ms`, {
              nodeId,
              step,
            }),
          );
    const control = createContext({ ...p, attempt, values, signal: deadline?.signal ?? p.signal });
    try {
      let output: unknown;
      let failure: { readonly error: unknown } | undefined;
      try {
        const result = node(state, control.ctx);
        output = yield deadline && isThenable(result) ? deadline.race(result) : result;
      } catch (error) {
        failure = { error };
      } finally {
        control.close();
        deadline?.dispose();
      }
```

In the attempt loop's `catch (thrown)` block, replace the `log.append({ type: "error", ... })` call with:

```ts
// A write that timed out or was cut off may have happened anyway.
const unknown = node.effect === "write" && (error.code === "TIMEOUT" || error.code === "ABORTED");
log.append({
  type: "error",
  nodeId,
  step,
  meta: {
    attempt,
    source,
    code: error.code,
    message: error.message,
    willRetry,
    ...(willRetry && { delayMs }),
    ...(unknown && { outcome: "unknown" }),
  },
});
```

If `tsc -p tsconfig.core.json` reports that `AbortSignal.any` does not exist, the DOM lib is older than expected: stop and report it instead of writing a replacement.

- [ ] **Step 6: `CodeNode` and `LLMNode`.** In `src/nodes/code.ts`, add to `CodeNodeOptions` after `effect`:

```ts
  /**
   * Milliseconds an async node may take; then it fails with TIMEOUT and `ctx.signal` aborts. Synchronous code cannot
   * be interrupted.
   */
  readonly timeoutMs?: number;
```

In `src/nodes/llm.ts`, add to `LLMNodeBase` after `retry`:

```ts
  /** Milliseconds each attempt may take; then the request's signal aborts and the attempt fails with TIMEOUT. */
  readonly timeoutMs?: number;
```

and change the metadata argument of `defineNode` in `LLMNode` to:

```ts
    {
      kind: "llm",
      ...(config.retry && { retry: config.retry }),
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
    },
```

- [ ] **Step 7: Run the tests.**

Run: `pnpm exec vitest run test/timeout.test.ts test/retry.test.ts test/runtime.test.ts`
Expected: PASS.

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/core/errors.ts src/core/types.ts src/core/node.ts src/core/engine.ts src/nodes/code.ts src/nodes/llm.ts test/timeout.test.ts
git commit -m "feat(core): node timeouts with TIMEOUT and outcome unknown for writes"
```

---

### Task 3: Agent timeouts for model calls and tools

**Files:**

- Modify: `src/agent/util.ts` (new `deadline` helper)
- Modify: `src/agent/index.ts` (`AgentConfig.timeoutMs`, `Tool.timeoutMs`, checks, `think` metadata, the tool call in `act`)
- Test: `test/agent.test.ts` (new `describe("timeouts")`)

**Interfaces:**

- Consumes: kernel `NodeMeta.timeoutMs` and code `TIMEOUT` (Task 2); `TaugraphError` from `../index.js`.
- Produces (public): `AgentConfig.timeoutMs?: number`, `Tool.timeoutMs?: number`.
- Produces (internal, `src/agent/util.ts`): `deadline(parent: AbortSignal, ms: number, error: Error): Deadline` with `{ signal, error, race<T>(value: PromiseLike<T>): Promise<T>, dispose(): void }`.

- [ ] **Step 1: Write the failing tests.** In `test/agent.test.ts`, add after the `weather` tool definition:

```ts
const hang = () => new Promise<never>(() => {});
const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // keep the thread busy
  }
};
```

and append at the end of the file:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm exec vitest run test/agent.test.ts -t timeouts`
Expected: FAIL (the read tool hangs until vitest's test timeout, and `createAgent` accepts `timeoutMs: 0`).

- [ ] **Step 3: The deadline helper.** Append to `src/agent/util.ts`:

```ts
/** A time limit for one call: `signal` aborts with `error` once `ms` pass, and `race` rejects with it. */
export interface Deadline {
  readonly signal: AbortSignal;
  readonly error: Error;
  race<T>(value: PromiseLike<T>): Promise<T>;
  /** Clears the timer when the call ends. */
  dispose(): void;
}

export function deadline(parent: AbortSignal, ms: number, error: Error): Deadline {
  const timer = new AbortController();
  let expire: ((reason: unknown) => void) | undefined;
  const handle = setTimeout(() => {
    timer.abort(error);
    expire?.(error);
  }, ms);
  return {
    signal: AbortSignal.any([parent, timer.signal]),
    error,
    race<T>(value: PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        expire = reject;
        Promise.resolve(value).then(resolve, reject); // a late rejection is dropped, never unhandled
      });
    },
    dispose: () => clearTimeout(handle),
  };
}
```

- [ ] **Step 4: Config, checks and `think`.** In `src/agent/index.ts`:

Add `TaugraphError,` to the import from `../index.js` (after `type StandardSchemaV1,`), and change the util import to `import { andThen, deadline, isThenable, issuesText, settle } from "./util.js";`.

In `interface Tool`, add after `effect`:

```ts
  /**
   * Milliseconds one run may take; then its `signal` aborts. A read tool that takes longer answers the model with an
   * error and the loop goes on. A write tool fails the run with TIMEOUT, since its effect may or may not have
   * happened. Synchronous tools cannot be interrupted.
   */
  readonly timeoutMs?: number;
```

In `interface AgentConfig`, add after `retry`:

```ts
  /** Milliseconds each model call may take; a slower call fails with TIMEOUT, which `retry` retries. */
  readonly timeoutMs?: number;
```

After the `TOO_MANY` constant, add:

```ts
const MAX_TIMEOUT = 2_147_483_647;
const badTimeout = (ms: unknown): boolean =>
  ms !== undefined && !(Number.isInteger(ms) && (ms as number) >= 1 && (ms as number) <= MAX_TIMEOUT);
```

In `createAgent`, inside the `for (const t of config.tools ?? [])` loop, after the `effect` check, add:

```ts
if (badTimeout(t.timeoutMs)) {
  throw new TypeError(
    `createAgent: tool "${t.name}" has timeoutMs ${String(t.timeoutMs)}; use an integer from 1 to ${MAX_TIMEOUT}`,
  );
}
```

After the `maxRounds` check, add:

```ts
if (badTimeout(config.timeoutMs)) {
  throw new TypeError(
    `createAgent: timeoutMs must be an integer from 1 to ${MAX_TIMEOUT}, got ${String(config.timeoutMs)}`,
  );
}
```

Change the metadata of the `think` node from `{ kind: "llm", ...(config.retry && { retry: config.retry }) }` to:

```ts
    {
      kind: "llm",
      ...(config.retry && { retry: config.retry }),
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
    },
```

- [ ] **Step 5: Time-limited tool calls in `act`.** In the `act` node, replace the `return settle(...)` call that runs the tool (from `return settle(` through its closing `);`) with:

```ts
          const limit =
            t.timeoutMs === undefined
              ? undefined
              : deadline(
                  ctx.signal,
                  t.timeoutMs,
                  new TaugraphError("TIMEOUT", `Tool "${call.name}" timed out after ${t.timeoutMs}ms`),
                );
          return settle(
            () => {
              const signal = limit?.signal ?? ctx.signal;
              const value = t.run(result.value, { call, signal, recovered: ctx.meta.recovered });
              return limit && isThenable(value) ? limit.race(value) : value;
            },
            (value) => {
              limit?.dispose();
              const { content, isError } = resultOf(t, value);
              return record(content, isError, false);
            },
            (error) => {
              limit?.dispose();
              if (ctx.signal.aborted) throw error; // a cancelled run stops; it is not the tool's answer
              if (limit && error === limit.error) {
                if (effect === "write") throw error; // the write may or may not have happened: fail, do not guess
                return record(limit.error.message, true, true);
              }
              return record(String(error instanceof Error ? `Error: ${error.message}` : error), true, true);
            },
          );
```

- [ ] **Step 6: Run the tests.**

Run: `pnpm exec vitest run test/agent.test.ts test/types.test.ts`
Expected: PASS.

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/agent/util.ts src/agent/index.ts test/agent.test.ts
git commit -m "feat(agent): timeoutMs for model calls and tools"
```

---

### Task 4: Async sinks

**Files:**

- Modify: `src/core/trace.ts` (`TraceLog`: chained sink calls, `pending()`, `detach()`)
- Modify: `src/core/types.ts` (`RunOptions.onEvent` type and doc)
- Modify: `src/core/engine.ts` (`SinkWait` effect, `record` / `drain`, every kernel `log.append`, both drivers)
- Test: `test/sink.test.ts` (new)

**Interfaces:**

- Consumes: the drivers and the attempt loop from Tasks 1 and 2.
- Produces (public): `RunOptions.onEvent?: (event: TraceEvent) => MaybePromise<void>`.
- Produces (internal): `TraceLog.pending(): Promise<void> | undefined` (resolves when the sink has stored every event so far, rejects with `SINK_FAILED`); `TraceLog.detach(): void`; in `engine.ts`, `class SinkWait { done: Promise<void>; detach: () => void }`, `function* record(log, draft)`, `function* drain(log)`.

- [ ] **Step 1: Write the failing tests.** Create `test/sink.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm exec vitest run test/sink.test.ts`
Expected: FAIL. Order and "enter before node" fail (the sink is not awaited), and `runSync` does not refuse the async sink.

- [ ] **Step 3: `TraceLog`.** In `src/core/trace.ts`, change the imports to:

```ts
import { TaugraphError } from "./errors.js";
import { applyPatch, diffJson, jsonLengthAtMost, type PatchOp } from "./patch.js";
import type { KernelEventType, MaybePromise, Trace, TraceEvent, TraceEventType } from "./types.js";
import { freezeJson, isThenable, jsonEqual } from "./util.js";
```

Replace the `TraceLog` class (doc comment included) with:

```ts
type Sink = (event: TraceEvent) => MaybePromise<void>;

/**
 * Append-only event log for one run. Payloads must already be frozen JSON
 * (see `freezeJson`); the log only assigns seq / runId / timestamp and freezes the envelope.
 *
 * Every event goes to `onEvent` in order, one call at a time: while an async call is unfinished, later events wait in
 * a chain, and `pending()` gives the engine that chain to wait on. If the sink throws or rejects, `append` throws
 * SINK_FAILED and keeps throwing, so the run cannot take another step unlogged.
 */
export class TraceLog {
  readonly #events: TraceEvent[];
  readonly #runId: string;
  #onEvent: Sink | undefined;
  #sinkError: { readonly cause: unknown } | undefined;
  /** Unfinished calls of an async sink, chained in event order. */
  #tail: Promise<void> | undefined;

  /** `prefix` continues an existing trace (resume); it is not sent to `onEvent` again. */
  constructor(runId: string, onEvent?: Sink, prefix: Trace = []) {
    this.#runId = runId;
    this.#onEvent = onEvent;
    this.#events = prefix.map((event) => freezeJson(event));
  }

  append(draft: EventDraft): TraceEvent {
    const event = this.#push(draft);
    if (this.#sinkError) throw sinkFailed(this.#sinkError.cause);
    this.#emit(event);
    return event;
  }

  /** For the closing `run_end` of a failing run: never throws, skips a sink that already failed. */
  appendFinal(draft: EventDraft): TraceEvent {
    const event = this.#push(draft);
    if (!this.#sinkError) {
      try {
        this.#emit(event);
      } catch {
        // Already failing; the original error is the one to report.
      }
    }
    return event;
  }

  /**
   * Resolves once an async sink has stored every event so far, or rejects with SINK_FAILED. Undefined when no call
   * is unfinished, which is always the case with a synchronous sink.
   */
  pending(): Promise<void> | undefined {
    const tail = this.#tail;
    if (!tail) return undefined;
    return tail.then(() => {
      if (this.#tail === tail) this.#tail = undefined;
    });
  }

  /** Stops calling the sink: `runSync` does this once the sink returned a Promise it cannot wait for. */
  detach(): void {
    this.#onEvent = undefined;
  }

  snapshot(): Trace {
    return Object.freeze(this.#events.slice());
  }

  #push(draft: EventDraft): TraceEvent {
    const event: Record<string, unknown> = {
      seq: this.#events.length,
      runId: this.#runId,
      type: draft.type,
      timestamp: Date.now(),
    };
    if (draft.nodeId !== undefined) event.nodeId = draft.nodeId;
    if (draft.step !== undefined) event.step = draft.step;
    if (draft.input !== undefined) event.input = draft.input;
    if (draft.output !== undefined) event.output = draft.output;
    if (draft.meta !== undefined) event.meta = Object.isFrozen(draft.meta) ? draft.meta : freezeJson(draft.meta);
    const frozen = Object.freeze(event) as unknown as TraceEvent;
    this.#events.push(frozen);
    return frozen;
  }

  #emit(event: TraceEvent): void {
    const sink = this.#onEvent;
    if (!sink) return;
    if (this.#tail) {
      this.#chain(this.#tail.then(() => this.#call(sink, event)));
      return;
    }
    const result = this.#call(sink, event);
    if (isThenable(result)) this.#chain(Promise.resolve(result));
  }

  /** Calls the sink. A synchronous throw marks the log as failed and becomes SINK_FAILED. */
  #call(sink: Sink, event: TraceEvent): unknown {
    try {
      return sink(event);
    } catch (cause) {
      if (!this.#sinkError) this.#sinkError = { cause };
      throw sinkFailed(this.#sinkError.cause);
    }
  }

  #chain(work: Promise<unknown>): void {
    const tail = work.then(
      () => undefined,
      (reason: unknown) => {
        if (!this.#sinkError) this.#sinkError = { cause: reason };
        throw sinkFailed(this.#sinkError.cause);
      },
    );
    tail.catch(() => {}); // the engine sees the failure through pending(); never an unhandled rejection
    this.#tail = tail;
  }
}
```

(`sinkFailed` stays as it is.)

- [ ] **Step 4: `onEvent` may return a Promise.** In `src/core/types.ts`, replace the `onEvent` member of `RunOptions` (doc comment included) with:

```ts
  /**
   * Called for every appended event, in order, before the run continues: use it to write the trace to durable
   * storage. It may return a Promise. `run` then waits for it after each kernel event, so a `write` step's `enter` is
   * stored before the node runs, and waits for the events a node appended before that step's `exit`. Calls never
   * overlap. If it throws or rejects, the run stops with SINK_FAILED. `runSync` takes synchronous sinks only.
   */
  readonly onEvent?: (event: TraceEvent) => MaybePromise<void>;
```

- [ ] **Step 5: Wait for the sink in the engine.** In `src/core/engine.ts`:

Add `type EventDraft,` to the import from `./trace.js` (alphabetical: after `deliveredValues,`).

After the `Wait` class, add:

```ts
/** Yielded to wait for an async `onEvent`: `run` awaits it, `runSync` refuses it and stops calling the sink. */
class SinkWait {
  constructor(
    readonly done: Promise<void>,
    readonly detach: () => void,
  ) {}
}

/** Appends a kernel event and, with an async sink, waits until the sink has stored it. */
function* record(log: TraceLog, draft: EventDraft): Effects<void> {
  log.append(draft);
  yield* drain(log);
}

/** Waits until an async sink has stored every event so far. Nothing to wait for with a synchronous sink. */
function* drain(log: TraceLog): Effects<void> {
  const done = log.pending();
  if (done) yield new SinkWait(done, () => log.detach());
}
```

Turn every kernel event into `yield* record(log, <same draft>)`. These are all `log.append(...)` calls in `engine.ts` except the one inside `createContext` (plugin events stay `log.append`):

1. `execute`: the paused `run_end` and the completed `run_end`.
2. `beginRun`: `run_start`.
3. `beginResume`: both `resume` events.
4. `runStep`: the `enter` and `exit` of a recorded step; the `resume` events of replayed answers inside `for (const value of values)`; and, in the attempt loop, `enter`, `pause`, `exit` and `error`.

For example, `log.append({ type: "enter", nodeId, step, input: state, meta });` becomes `yield* record(log, { type: "enter", nodeId, step, input: state, meta });`.

In the attempt loop, directly after the inner `try { ... } catch (error) { ... } finally { ... }` block that calls the node, add:

```ts
      yield* drain(log); // events the node appended are stored before its step ends
```

In `execute`'s `catch (thrown)` block, directly after the `log.appendFinal({ ... });` call, add:

```ts
    if (error.code !== "ABORTED") {
      try {
        yield* drain(log); // the sink still gets run_end, but a failure now would hide the first one
      } catch {
        // Already failing; the original error is the one to report.
      }
    }
```

In `driveSync`, add a branch after the `Wait` branch:

```ts
    } else if (effect instanceof SinkWait) {
      effect.done.catch(() => {}); // the sink finishes on its own; avoid an unhandled rejection
      effect.detach();
      next = effects.throw(
        new TaugraphError("ASYNC_IN_SYNC_RUN", "onEvent returned a Promise; use run() for an async sink"),
      );
```

In `driveAsync`, change the effect dispatch to:

```ts
if (effect instanceof Wait) value = await sleep(effect.ms, signal);
else if (effect instanceof SinkWait) value = await abortable(effect.done, signal);
else value = isThenable(effect) ? await abortable(effect, signal) : effect;
```

- [ ] **Step 6: Run the tests.**

Run: `pnpm exec vitest run test/sink.test.ts test/effects.test.ts test/trace.test.ts test/file.test.ts test/file-durability.test.ts test/pause.test.ts`
Expected: PASS. Synchronous sinks behave as before (`pending()` is always undefined for them).

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/core/trace.ts src/core/types.ts src/core/engine.ts test/sink.test.ts
git commit -m "feat(core): async onEvent sinks, awaited in order"
```

---

### Task 5: `HTTPError` and `tokenLimit` in `taugraph/openai`

**Files:**

- Modify: `src/openai/index.ts`
- Test: `test/openai.test.ts`

**Interfaces:**

- Consumes: `isRetryable` and the retry wait (Task 1), which read `status` and `retryAfterMs`.
- Produces (public, `taugraph/openai`): `class HTTPError extends Error { readonly name: "HTTPError"; readonly status: number; readonly url: string; readonly retryAfterMs: number | undefined }`; `OpenAICompatibleOptions.tokenLimit?: "max_tokens" | "max_completion_tokens"`.

- [ ] **Step 1: Write the failing tests.** In `test/openai.test.ts`, change the imports to:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGraph, isRetryable } from "../src/index.js";
import { LLMNode } from "../src/nodes/index.js";
import { fromOpenAIToolCalls, HTTPError, openAICompatible, toOpenAIMessages } from "../src/openai/index.js";
```

change the `afterEach` line to:

```ts
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
```

and append at the end of the file:

```ts
/** A response without streams, so it settles in microtasks (fake timers do not have to wait for I/O). */
const reply = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body),
  }) as unknown as Response;
const okBody = JSON.stringify({ choices: [{ message: { content: "hi" } }] });

describe("HTTP errors", () => {
  const signal = new AbortController().signal;
  const failing = (response: Response) =>
    openAICompatible({ baseURL: "http://x/v1", model: "m", fetch: async () => response })
      .complete({ messages: [] }, { signal })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

  it("throws HTTPError with the status, the URL, Retry-After and the start of the body", async () => {
    const error = await failing(reply(429, "x".repeat(600), { "retry-after": "3" }));
    expect(error).toBeInstanceOf(HTTPError);
    expect(error).toMatchObject({
      name: "HTTPError",
      status: 429,
      url: "http://x/v1/chat/completions",
      retryAfterMs: 3000,
      message: `http://x/v1/chat/completions responded 429: ${"x".repeat(500)}`,
    });
    expect(isRetryable(error)).toBe(true);
  });

  it("reads Retry-After as an HTTP date, and leaves it out when missing or unreadable", async () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    const dated = (await failing(reply(503, "busy", { "retry-after": date }))) as HTTPError;
    expect(dated.retryAfterMs).toBeGreaterThan(8000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(10_000);
    const missing = (await failing(reply(400, "bad"))) as HTTPError;
    expect(missing.retryAfterMs).toBeUndefined();
    expect(isRetryable(missing)).toBe(false);
    const unreadable = (await failing(reply(503, "busy", { "retry-after": "soon" }))) as HTTPError;
    expect(unreadable.retryAfterMs).toBeUndefined();
  });

  it("lets LLMNode give up on a 400 at once and retry a 429 after Retry-After", async () => {
    const schema = z.object({ q: z.string(), a: z.string() });
    let fetches = 0;
    const graphWith = (first: Response) => {
      fetches = 0;
      const model = openAICompatible({
        baseURL: "http://x/v1",
        model: "m",
        fetch: async () => {
          fetches += 1;
          return fetches === 1 ? first : reply(200, okBody);
        },
      });
      return createGraph(schema, {
        start: "ask",
        nodes: {
          ask: LLMNode({
            model,
            prompt: (s) => s.q,
            update: (s, text) => ({ ...s, a: text }),
            retry: { maxAttempts: 3 },
          }),
        },
        endNodes: ["ask"],
      });
    };

    const error = await graphWith(reply(400, "bad request"))
      .run({ q: "hi", a: "" })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(HTTPError);
    expect(fetches).toBe(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = graphWith(reply(429, "slow down", { "retry-after": "3" })).run({ q: "hi", a: "" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const { state, trace } = await pending;
    expect(fetches).toBe(2);
    expect(state.a).toBe("hi");
    expect(trace.find((e) => e.type === "error")?.meta).toMatchObject({ willRetry: true, delayMs: 3000 });
  });
});

describe("tokenLimit", () => {
  it("puts maxTokens in the field it names", async () => {
    const bodies: Record<string, unknown>[] = [];
    const capture = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(200, okBody);
    };
    const signal = new AbortController().signal;
    const request = { messages: [{ role: "user" as const, content: "q" }], maxTokens: 50 };
    const reasoning = openAICompatible({
      baseURL: "http://x/v1",
      model: "o3",
      tokenLimit: "max_completion_tokens",
      fetch: capture,
    });
    await reasoning.complete(request, { signal });
    await openAICompatible({ baseURL: "http://x/v1", model: "m", fetch: capture }).complete(request, { signal });
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 50 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
    expect(bodies[1]).toMatchObject({ max_tokens: 50 });
    expect(bodies[1]).not.toHaveProperty("max_completion_tokens");
  });

  it("refuses other values", () => {
    expect(() => openAICompatible({ baseURL: "http://x/v1", model: "m", tokenLimit: "max" as never })).toThrow(
      'openAICompatible: tokenLimit must be "max_tokens" or "max_completion_tokens", got max',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm exec vitest run test/openai.test.ts`
Expected: FAIL. `HTTPError` is not exported; `tokenLimit` is ignored.

- [ ] **Step 3: Implement.** In `src/openai/index.ts`:

Add to `OpenAICompatibleOptions`, after `sendReasoning`:

```ts
  /**
   * The request field that carries `maxTokens`. Default `"max_tokens"`; OpenAI's reasoning models (o-series, GPT-5)
   * want `"max_completion_tokens"`.
   */
  readonly tokenLimit?: "max_tokens" | "max_completion_tokens" | undefined;
```

After the `OpenAIToolCall` interface, add:

```ts
/** A response outside 200-299. `status` and `retryAfterMs` let `isRetryable` and the retry wait act on it. */
export class HTTPError extends Error {
  override readonly name = "HTTPError";
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    /** From `Retry-After`, given in seconds or as an HTTP date; undefined when missing or unreadable. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
  }
}

/** `Retry-After` in milliseconds: a number of seconds, or an HTTP date (0 once it has passed). */
function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
```

In `openAICompatible`, after `const id = ...;`, add:

```ts
const tokenLimit = options.tokenLimit ?? "max_tokens";
if (tokenLimit !== "max_tokens" && tokenLimit !== "max_completion_tokens") {
  throw new TypeError(
    `openAICompatible: tokenLimit must be "max_tokens" or "max_completion_tokens", got ${String(options.tokenLimit)}`,
  );
}
```

In the request body, replace `max_tokens: request.maxTokens,` with `[tokenLimit]: request.maxTokens,`.

Replace

```ts
if (!response.ok) {
  throw new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 500)}`);
}
```

with

```ts
if (!response.ok) {
  const text = await response.text().catch(() => "");
  throw new HTTPError(
    `${url} responded ${response.status}: ${text.slice(0, 500)}`,
    response.status,
    url,
    retryAfter(response.headers.get("retry-after")),
  );
}
```

Also change the `fetch` option's doc comment to "Used instead of the global `fetch`, e.g. for a proxy or tests." (retries now belong to the node's `retry`).

- [ ] **Step 4: Run the tests.**

Run: `pnpm exec vitest run test/openai.test.ts`
Expected: PASS.

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/openai/index.ts test/openai.test.ts
git commit -m "feat(openai): HTTPError with status and Retry-After, tokenLimit option"
```

---

### Task 6: Documentation and CHANGELOG

**Files:**

- Modify: `README.md`, `README.zh-CN.md`
- Modify: `docs/design.md`, `docs/trace-format.md`
- Modify: `CHANGELOG.md` (the existing `## [0.4.0]` section; the date is updated at release time, not here)

**Interfaces:**

- Consumes: every public name from Tasks 1 to 5: `RetryPolicy.backoff` / `retryOn` / `idempotent`, `isRetryable`, `ctx.meta.idempotencyKey`, `timeoutMs` (nodes, `LLMNode`, `createAgent`, tools), `TIMEOUT`, `error.meta.delayMs` / `outcome`, async `onEvent`, `HTTPError`, `tokenLimit`.
- Produces: documentation only.

Markdown tables must keep every row the same width. In `README.zh-CN.md`, a CJK character counts as two columns. The rows below are already padded; paste them as they are.

- [ ] **Step 1: `README.md`.** Make these replacements (old text, then new text).

In "What's new in the design", point 3:

```
A write that was running when the process died becomes `UNKNOWN_OUTCOME`, never a silent retry.
```

```
A write that was running when the process died becomes `UNKNOWN_OUTCOME`, never a silent retry, and a failed write is retried only when it is declared idempotent.
```

In "Node":

```
  meta: { runId: string; nodeId: string; step: number; attempt: number; recovered: boolean };
```

```
  meta: { runId: string; nodeId: string; step: number; attempt: number; recovered: boolean; idempotencyKey: string };
```

In "Trace", the last paragraph:

```
`run(input, { onEvent })` hands every event to your sink before the run continues. If the sink throws, the run stops with `SINK_FAILED`, so no step runs without being logged. Full spec: [docs/trace-format.md](./docs/trace-format.md).
```

```
`run(input, { onEvent })` hands every event to your sink before the run continues. The sink may return a Promise: `run` waits for it after every kernel event, so a `write` step's `enter` is stored before the node runs, and the events a node appends are stored before its step ends. Calls never overlap. If the sink throws or rejects, the run stops with `SINK_FAILED`, so no step runs without being logged. `runSync` takes synchronous sinks only. Full spec: [docs/trace-format.md](./docs/trace-format.md).
```

Replace the body of "Errors and retries" (the one paragraph under the heading) with:

````
Every failure is a `TaugraphError` with a `code` (`INVALID_GRAPH`, `INVALID_STATE`, `INVALID_ROUTE`, `NODE_FAILED`, `MAX_STEPS`, `ABORTED`, `TIMEOUT`, `ASYNC_IN_SYNC_RUN`, `INVALID_TRACE`, `INVALID_EVENT`, `WRITE_BLOCKED`, `UNKNOWN_OUTCOME`, `NOT_RESUMABLE`, `SINK_FAILED`), plus `nodeId`, `step`, schema `issues`, the original `cause`, and the `trace` up to the failure.

```ts
CodeNode(fetchPrices, { retry: { maxAttempts: 4 }, timeoutMs: 10_000 });
```

- **What is retried.** By default `isRetryable(error)` decides. Kernel errors that another attempt cannot fix (`INVALID_STATE`, `ABORTED`, `SINK_FAILED`, ...) are not retried, and neither are HTTP 4xx errors other than 408, 409, 425 and 429, read from a numeric `status` on the error or its `cause` chain. Everything else is retried, including errors it knows nothing about. Pass `retryOn(error)` to decide yourself; it gets the error the node threw.
- **How long it waits.** Exponential backoff: 500 ms, twice as long each time, at most 30 s, minus up to half at random (`backoff: { initialMs, factor, maxMs, jitter }`, or `false` to retry at once). A `retryAfterMs` on the error, which `taugraph/openai` reads from `Retry-After`, makes it wait at least that long. `run` waits with a timer and stops at once when aborted; `runSync` blocks the thread, and fails with `ASYNC_IN_SYNC_RUN` where it may not (a browser's main thread). Each failed attempt is an `error` event with `willRetry` and `delayMs`.
- **Write nodes.** A `write` node with `retry` must set `idempotent: true`, or `defineNode` throws: a repeated order is a second order. `ctx.meta.idempotencyKey` (`<runId>:<step>`) is the same for every attempt of a step and after a crash; pass it to the API (as an `Idempotency-Key` header, say) so repeats are safe.
- **Timeouts.** `timeoutMs` on a node fails the attempt with `TIMEOUT` when its Promise has not settled in time, and aborts `ctx.signal`. `TIMEOUT` is retried like other errors. Synchronous code cannot be interrupted. When a `write` node stops on a timeout or an abort, its `error` event says `outcome: "unknown"`: the effect may or may not have happened.
````

In "Agent", after the bullet that starts with "- `maxRounds` (default 8)", add:

```
- `timeoutMs` on `createAgent` limits each model call (`TIMEOUT`, which `retry` retries). `timeoutMs` on a tool limits each run of it: a read tool that takes longer answers the model with an error and the loop goes on; a write tool fails the run with `TIMEOUT`, because its effect is unknown.
```

In "OpenAI-compatible models", replace the `fetch` row of the options table with these two rows:

```
| `tokenLimit`      | `"max_completion_tokens"` for OpenAI's reasoning models; default `"max_tokens"`                      |
| `fetch`           | Used instead of the global `fetch`, e.g. for a proxy or tests                                        |
```

and after the paragraph that starts with "The model's `id` is `openai-compatible:<model>`", add a paragraph:

```
A response outside 2xx throws `HTTPError` with `status`, `url` and `retryAfterMs` (read from `Retry-After`), so an `LLMNode` with `retry` retries 429 and 5xx, waiting at least as long as `Retry-After` asks, and gives up on other 4xx at once.
```

- [ ] **Step 2: `README.zh-CN.md`.** The same changes in Chinese.

"设计上的创新" point 3:

```
进程崩溃时正在执行的写操作会变成 `UNKNOWN_OUTCOME`，不会被悄悄重试。
```

```
进程崩溃时正在执行的写操作会变成 `UNKNOWN_OUTCOME`，不会被悄悄重试；失败的写操作只有声明了幂等才会重试。
```

"Node": the same `meta` line change as in Step 1 (the line is identical in both files).

"Trace", the last paragraph:

```
`run(input, { onEvent })` 会在运行继续之前把每个事件交给你的 sink。sink 抛错时运行以 `SINK_FAILED` 停止，保证没有哪一步是在没写日志的情况下执行的。完整格式见 [docs/trace-format.md](./docs/trace-format.md)。
```

```
`run(input, { onEvent })` 会在运行继续之前把每个事件交给你的 sink。sink 可以返回 Promise：`run` 在每个内核事件之后等它完成，所以写操作步骤的 `enter` 在节点执行前就已存好，节点追加的事件在这一步结束前存好。两次调用不会重叠。sink 抛错或 reject 时运行以 `SINK_FAILED` 停止，保证没有哪一步是在没写日志的情况下执行的。`runSync` 只接受同步的 sink。完整格式见 [docs/trace-format.md](./docs/trace-format.md)。
```

Replace the body of "错误与重试" with:

````
所有失败都是 `TaugraphError`，带 `code`（`INVALID_GRAPH`、`INVALID_STATE`、`INVALID_ROUTE`、`NODE_FAILED`、`MAX_STEPS`、`ABORTED`、`TIMEOUT`、`ASYNC_IN_SYNC_RUN`、`INVALID_TRACE`、`INVALID_EVENT`、`WRITE_BLOCKED`、`UNKNOWN_OUTCOME`、`NOT_RESUMABLE`、`SINK_FAILED`），以及 `nodeId`、`step`、schema `issues`、原始 `cause`，还有截至失败时的 `trace`。

```ts
CodeNode(fetchPrices, { retry: { maxAttempts: 4 }, timeoutMs: 10_000 });
```

- **哪些错误会重试。** 默认由 `isRetryable(error)` 判断。重试也修不好的内核错误（`INVALID_STATE`、`ABORTED`、`SINK_FAILED` 等）不重试；HTTP 4xx 也不重试，但 408、409、425、429 除外，状态码取自错误本身或它的 `cause` 链上的数字 `status`。其他错误都重试，包括它不认识的错误。想自己判断就传 `retryOn(error)`，它收到的是节点抛出的原始错误。
- **等多久。** 指数退避：先等 500 毫秒，之后每次翻倍，最多 30 秒，再随机减去最多一半（`backoff: { initialMs, factor, maxMs, jitter }`，设为 `false` 则立即重试）。错误上带 `retryAfterMs` 时至少等这么久，`taugraph/openai` 会从 `Retry-After` 读出它。`run` 用定时器等待，运行被中止时立即停止；`runSync` 会阻塞线程，在不允许阻塞的地方（浏览器主线程）报 `ASYNC_IN_SYNC_RUN`。每次失败都记为一条 `error` 事件，带 `willRetry` 和 `delayMs`。
- **写操作节点。** `write` 节点配了 `retry` 就必须写 `idempotent: true`，否则 `defineNode` 报错：重复下单就是第二笔订单。`ctx.meta.idempotencyKey`（`<runId>:<step>`）在同一步的每次尝试里都相同，崩溃后恢复时也相同；把它传给外部接口（比如作为 `Idempotency-Key` 请求头），重复执行就是安全的。
- **超时。** 节点上的 `timeoutMs` 让 Promise 没有按时完成的这次尝试以 `TIMEOUT` 失败，并中止 `ctx.signal`。`TIMEOUT` 和其他错误一样会重试。同步代码无法被打断。`write` 节点因超时或中止停下时，它的 `error` 事件带 `outcome: "unknown"`：副作用可能发生了，也可能没有。
````

In "Agent（`taugraph/agent`）", after the bullet that starts with "- `maxRounds`（默认 8）", add:

```
- `createAgent` 的 `timeoutMs` 限制每次模型调用（超时报 `TIMEOUT`，`retry` 会重试）。工具的 `timeoutMs` 限制它的每次执行：只读工具超时，把错误结果交回模型，循环继续；写操作工具超时，运行以 `TIMEOUT` 失败，因为副作用是否发生无从知道。
```

In "OpenAI 兼容模型", replace the `fetch` row with:

```
| `tokenLimit`      | OpenAI 的推理模型要用 `"max_completion_tokens"`；默认 `"max_tokens"`                            |
| `fetch`           | 代替全局的 `fetch`，用于代理或测试                                                              |
```

and after the paragraph that starts with "模型的 `id` 是 `openai-compatible:<model>`", add:

```
响应不是 2xx 时抛 `HTTPError`，带 `status`、`url` 和 `retryAfterMs`（从 `Retry-After` 读出），所以配了 `retry` 的 `LLMNode` 会重试 429 和 5xx，等待时间不短于 `Retry-After` 的要求，遇到其他 4xx 立即放弃。
```

- [ ] **Step 3: `docs/design.md`.** In "The log is written ahead", replace the last sentence

```
The sink is synchronous to keep `runSync` possible; buffer in the sink if your storage is asynchronous and you accept the weaker guarantee.
```

with

```
The sink may be asynchronous, so the guarantee also holds for a database or an object store: `run` waits for it after every kernel event, and waits for the events a node appended before writing the step's `exit`. Calls run one at a time, in order, because a sink that stored event 5 while event 4 was still in flight could leave a gap that `resume` cannot read past. Events from `ctx.trace.append` are queued instead of awaited one by one, since `append` is synchronous; a failure among them fails the step they belong to. `runSync` refuses an async sink rather than quietly weakening the guarantee.
```

After the section "Replay never repeats a write", insert:

```
## Retries are decided by status, and declared for writes

A retry runs the node again, so for a `write` node it repeats the effect: a second order, a second email. The kernel cannot know whether an API deduplicates, so a write node with `retry` must say `idempotent: true`, and `ctx.meta.idempotencyKey` (`<runId>:<step>`, the same for every attempt and after a crash) gives it a key to deduplicate on. Failing in `defineNode` catches the mistake where it is written instead of in production.

Which errors to retry is read from data, not from error classes: a numeric `status` on the error or its `cause` chain. HTTP clients and SDKs all put the status somewhere like that, while their error classes have nothing in common and the kernel cannot import them. A 4xx means the request itself is wrong, except 408, 409, 425 and 429, which mean "later". Unknown errors are retried, because most of them are network failures. Waits back off exponentially with jitter, so clients that failed together do not all come back at the same moment, and a `retryAfterMs` from the server wins because the server knows its own load. `runSync` blocks with `Atomics.wait`, so a retry policy means the same in both drivers.

## Timeouts stop the wait and abort the signal

A node's `timeoutMs` does two things at once. The kernel stops waiting for the node's Promise, which bounds the run even when the node ignores its signal, and it aborts `ctx.signal`, which lets a well-behaved node cancel its request. JavaScript cannot interrupt synchronous code, so the limit only covers Promises. A write that timed out may still complete on the other side, so its `error` event says `outcome: "unknown"` and the run fails rather than guessing. The agent applies the same rule to tools: a read tool's timeout is one more error result for the model, a write tool's timeout stops the run.
```

- [ ] **Step 4: `docs/trace-format.md`.** In the "Kernel events" table, replace the `error` row with:

```
| `error`     | `nodeId`, `step`. `meta`: `attempt`, `source`, `code`, `message`, `willRetry`, `delayMs` (the wait before the next attempt, when `willRetry`), and `outcome: "unknown"` when a `write` node stopped on `TIMEOUT` or `ABORTED`.                                                                       |
```

- [ ] **Step 5: `CHANGELOG.md`.** In the `## [0.4.0]` section:

Replace the summary paragraph

```
Traces grow linearly instead of with the square of the run, in memory and in JSONL (format version 2), and `taugraph/file` stores them as crash-safe files that a restarted process can continue.
```

with

```
Traces grow linearly instead of with the square of the run, in memory and in JSONL (format version 2), and `taugraph/file` stores them as crash-safe files that a restarted process can continue. Retries now wait and skip errors that cannot heal, nodes and tools can time out, and `onEvent` can be async.
```

Under `### Changed`, insert after the first bullet (the trace format version 2 one):

```
- **Breaking:** retries wait between attempts: exponential backoff from 500 ms, doubling up to 30 s, minus up to half at random, or at least the error's `retryAfterMs`. Pass `backoff: false` for the old immediate retries. `runSync` blocks the thread for the wait, and fails with `ASYNC_IN_SYNC_RUN` where it may not block.
- **Breaking:** errors that another attempt cannot fix are no longer retried: HTTP 4xx other than 408, 409, 425 and 429 (a numeric `status` on the error or its `cause` chain), and the codes `INVALID_STATE`, `INVALID_ROUTE`, `WRITE_BLOCKED`, `UNKNOWN_OUTCOME` and `NOT_RESUMABLE`. A node that returns invalid state now fails at once; pass `retryOn` to keep retrying it.
- **Breaking:** a `write` node with `retry` must set `retry.idempotent: true`. Otherwise `defineNode` throws a `TypeError`, and `createGraph` an `INVALID_GRAPH` error for nodes built without `defineNode`.
```

At the end of `### Changed`, add:

```
- `taugraph/openai` throws `HTTPError` (with `status`, `url` and `retryAfterMs`) instead of a plain `Error` for responses outside 2xx. The message is unchanged.
```

At the end of `### Added`, add:

```
- Retry policy: `backoff`, `retryOn` and `idempotent` on `RetryPolicy`; `isRetryable(error)`, the default rule; `ctx.meta.idempotencyKey` (`<runId>:<step>`); `delayMs` in `error` events.
- Timeouts: `timeoutMs` on nodes (`defineNode`, `CodeNode`, `LLMNode`), on `createAgent` for each model call, and on agent tools. An attempt that times out fails with the new code `TIMEOUT`, which is retryable, and its `ctx.signal` aborts. A `write` node that stopped on a timeout or an abort has `outcome: "unknown"` in its `error` event. A read tool that times out answers the model with an error; a write tool fails the run.
- Async sinks: `onEvent` may return a Promise. `run` awaits it after each kernel event and awaits the events a node appended before the step's `exit`; calls never overlap; a rejection stops the run with `SINK_FAILED`. `runSync` refuses an async sink with `ASYNC_IN_SYNC_RUN`.
- `taugraph/openai`: `tokenLimit: "max_completion_tokens"` for OpenAI's reasoning models.
```

- [ ] **Step 6: Check the tables and the text.**

Run:

```bash
node -e '
const fs = require("node:fs");
const width = (s) => [...s].reduce((n, c) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0);
for (const file of ["README.md", "README.zh-CN.md", "docs/trace-format.md"]) {
  let table = [];
  for (const line of [...fs.readFileSync(file, "utf8").split("\n"), ""]) {
    if (line.startsWith("|")) { table.push(line); continue; }
    if (table.length && new Set(table.map(width)).size > 1) console.log(file, "uneven table:", table[0].slice(0, 40));
    table = [];
  }
}'
grep -n "idempotencyKey\|tokenLimit\|HTTPError\|TIMEOUT" README.md README.zh-CN.md docs/design.md docs/trace-format.md CHANGELOG.md | wc -l
```

Expected: no "uneven table" lines; the count is above 15.

Run: `pnpm check`
Expected: PASS (biome does not touch Markdown, so this only guards against accidental edits elsewhere).

- [ ] **Step 7: Commit.**

```bash
git add README.md README.zh-CN.md docs/design.md docs/trace-format.md CHANGELOG.md
git commit -m "docs: retries, timeouts and async sinks"
```

---

### Task 7: Final verification

**Files:** none changed, unless a check fails.

**Interfaces:** none.

- [ ] **Step 1: Kernel checks.**

Run: `pnpm check && pnpm build`
Expected: PASS; `dist/` is rebuilt.

- [ ] **Step 2: Examples.**

Run: `pnpm example:quickstart && pnpm example:checkout && pnpm example:rag && pnpm example:agent`
Expected: all four finish without errors; the agent example prints `replay equal: true`.

- [ ] **Step 3: Sibling packages against a local pack.**

```bash
rm -rf /tmp/tg-pack && mkdir -p /tmp/tg-pack && pnpm pack --pack-destination /tmp/tg-pack
for repo in taugraph-mcp taugraph-pi; do
  (cd ../$repo && git checkout feat/trace-v2 && rm -rf node_modules/.pnpm/taugraph@file* \
    && pnpm add /tmp/tg-pack/taugraph-0.4.0.tgz && pnpm check; rc=$?; \
    git checkout package.json pnpm-lock.yaml; exit $rc)
done
```

Expected: `pnpm check` passes in both siblings; `git status --short` in each sibling shows no changes to `package.json` or `pnpm-lock.yaml` afterwards.

- [ ] **Step 4: Spec coverage.** Read `docs/superpowers/specs/2026-11-25-reliability-design.md` sections 2 to 7 and confirm each bullet has code and a test, or a doc change, on this branch (`git diff 8db3a6f --stat`). Report anything missing instead of fixing it silently.
