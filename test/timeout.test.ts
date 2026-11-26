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
    expect((signal?.reason as TaugraphError | undefined)?.code).toBe("TIMEOUT");
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
