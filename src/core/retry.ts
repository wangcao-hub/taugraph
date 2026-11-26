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
