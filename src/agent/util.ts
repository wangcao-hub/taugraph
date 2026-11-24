import type { MaybePromise, StandardSchemaV1 } from "../index.js";

export function isThenable<T>(value: MaybePromise<T>): value is PromiseLike<T> {
  return value !== null && typeof value === "object" && typeof (value as PromiseLike<T>).then === "function";
}

/** Chains without introducing a Promise when the value is synchronous, so the agent stays `runSync`-friendly. */
export function andThen<A, B>(value: MaybePromise<A>, fn: (value: A) => MaybePromise<B>): MaybePromise<B> {
  return isThenable(value) ? Promise.resolve(value).then(fn) : fn(value);
}

/** Runs `run` and hands its value to `ok`, or its error (thrown or rejected) to `fail`. Sync in, sync out. */
export function settle<T, R>(
  run: () => MaybePromise<T>,
  ok: (value: T) => MaybePromise<R>,
  fail: (error: unknown) => MaybePromise<R>,
): MaybePromise<R> {
  let value: MaybePromise<T>;
  try {
    value = run();
  } catch (error) {
    return fail(error);
  }
  return isThenable(value) ? Promise.resolve(value).then(ok, fail) : ok(value);
}

/** Schema issues as one line the model can act on: "city: expected string; days: too small". */
export function issuesText(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
