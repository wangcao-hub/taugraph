import { defineNode, type MaybePromise, type Node, type RetryPolicy, type RunContext } from "../index.js";

export interface CodeNodeOptions {
  readonly retry?: RetryPolicy;
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
