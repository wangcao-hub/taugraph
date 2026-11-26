import { defineNode, type Effect, type MaybePromise, type Node, type RetryPolicy, type RunContext } from "../index.js";

export interface CodeNodeOptions {
  readonly retry?: RetryPolicy;
  /** Declare `"write"` for code that changes the outside world, so replay will not repeat it. */
  readonly effect?: Effect;
  /**
   * Milliseconds an async node may take; then it fails with TIMEOUT and `ctx.signal` aborts. Synchronous code cannot
   * be interrupted.
   */
  readonly timeoutMs?: number;
}

/**
 * Deterministic transformation from state to state. Labelled `kind: "code"` in the trace.
 * `S` is inferred from the graph schema; outside a graph, annotate it: `CodeNode<State>(...)`.
 */
export function CodeNode<S>(
  fn: (state: S, ctx: RunContext) => MaybePromise<NoInfer<S>>,
  options: CodeNodeOptions = {},
): Node<S> {
  return defineNode(fn, { kind: "code", ...options });
}
