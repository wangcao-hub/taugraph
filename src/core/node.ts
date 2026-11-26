import { freezeRetry, MAX_DELAY_MS } from "./retry.js";
import type { Node, NodeFn, NodeMeta } from "./types.js";

const atLeast = (value: unknown, min: number): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= min;

/**
 * What is wrong with a node's retry policy or timeout, or undefined. `defineNode` and `createGraph` both check it, so
 * a node built without `defineNode` cannot slip past.
 */
export function nodeMetaProblem(meta: NodeMeta): string | undefined {
  const { timeoutMs } = meta;
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_DELAY_MS)) {
    return `timeoutMs must be an integer from 1 to ${MAX_DELAY_MS}, got ${String(timeoutMs)}`;
  }
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
      ...(meta.timeoutMs !== undefined && { timeoutMs: meta.timeoutMs }),
    }),
  );
}
