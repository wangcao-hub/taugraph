import type { MaybePromise, StandardSchemaV1 } from "../index.js";

/** Chains without introducing a Promise when the value is synchronous, so nodes stay `runSync`-friendly. */
export function andThen<A, B>(value: MaybePromise<A>, fn: (value: A) => MaybePromise<B>): MaybePromise<B> {
  if (value !== null && typeof value === "object" && typeof (value as PromiseLike<A>).then === "function") {
    return Promise.resolve(value).then(fn);
  }
  return fn(value as A);
}

export function issuesMessage(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues.map((issue) => issue.message).join("; ");
}
