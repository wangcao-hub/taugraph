import type { Node, NodeFn, NodeMeta } from "./types.js";

/**
 * Wraps a node function with metadata (kind, retry policy, effect). This is the only hook
 * plugin node packages need: `CodeNode`, `LLMNode` and friends are built on it.
 */
export function defineNode<S>(fn: NodeFn<S>, meta: NodeMeta = {}): Node<S> {
  if (typeof fn !== "function") throw new TypeError("defineNode: expected a function");
  const retry = meta.retry;
  if (retry !== undefined && !(Number.isInteger(retry.maxAttempts) && retry.maxAttempts >= 1)) {
    throw new TypeError(`defineNode: retry.maxAttempts must be an integer >= 1, got ${String(retry.maxAttempts)}`);
  }
  if (meta.effect !== undefined && meta.effect !== "read" && meta.effect !== "write") {
    throw new TypeError(`defineNode: effect must be "read" or "write", got ${String(meta.effect)}`);
  }
  const node: NodeFn<S> = (state, ctx) => fn(state, ctx);
  return Object.freeze(
    Object.assign(node, {
      ...(meta.kind !== undefined && { kind: meta.kind }),
      ...(meta.effect !== undefined && { effect: meta.effect }),
      ...(retry !== undefined && { retry: Object.freeze({ maxAttempts: retry.maxAttempts }) }),
    }),
  );
}
