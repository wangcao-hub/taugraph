import { defineNode, type MaybePromise, type Node, type StandardSchemaV1 } from "../index.js";
import { andThen, issuesMessage } from "./util.js";

export interface HumanNodeConfig<S, T> {
  /**
   * Builds what the human sees. Returned as `pending.request` by the paused run.
   * `error` is set when the previous answer failed the `answer` schema, so you can ask again.
   */
  readonly ask: (state: S, error?: string) => unknown;
  /** Validates the value passed to `graph.resume`. An invalid value pauses again with `error` set. */
  readonly answer?: StandardSchemaV1<unknown, T>;
  readonly update: (state: S, answer: T) => NoInfer<S>;
}

/**
 * Pauses the run until a human (or any outside system) answers through `graph.resume(trace, value)`.
 * Built only on `ctx.interrupt`; the kernel knows nothing about humans.
 */
export function HumanNode<S, T = unknown>(config: HumanNodeConfig<S, T>): Node<S> {
  return defineNode<S>(
    (state, ctx) => {
      const ask = (error?: string): MaybePromise<S> => {
        const value = ctx.interrupt<unknown>(config.ask(state, error));
        if (!config.answer) return config.update(state, value as T);
        return andThen(config.answer["~standard"].validate(value), (result) =>
          result.issues ? ask(issuesMessage(result.issues)) : config.update(state, result.value),
        );
      };
      return ask();
    },
    { kind: "human" },
  );
}
