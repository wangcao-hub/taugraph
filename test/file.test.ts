import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fileStore } from "../src/file/index.js";
import { createGraph, isTaugraphError, runStatus, type Trace, toJSONL } from "../src/index.js";

const temp = () => mkdtempSync(join(tmpdir(), "taugraph-file-"));
const DEAD_PID = 2147483646;

const schema = z.object({
  n: z.number(),
  sent: z.boolean().default(false),
  answer: z.string().nullable().default(null),
});
type S = z.infer<typeof schema>;
const graph = createGraph(schema, {
  start: "a",
  nodes: {
    a: (s: S) => ({ ...s, n: s.n + 1 }),
    b: (s: S) => ({ ...s, n: s.n + 1 }),
    send: Object.assign((s: S) => ({ ...s, sent: true }), { effect: "write" as const }),
  },
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "send" },
  ],
  endNodes: ["send"],
});
const asking = createGraph(schema, {
  start: "ask",
  nodes: { ask: (s: S, ctx) => ({ ...s, answer: ctx.interrupt<string>("ok?") }) },
  endNodes: ["ask"],
});

/** A file that ends like a crash: the events up to `cut`, then half of the next line, and a dead writer's lock. */
function crashed(dir: string, trace: Trace, cut: number): void {
  const runId = trace[0]?.runId as string;
  const next = toJSONL(trace, { from: cut }).split("\n")[0] as string;
  writeFileSync(join(dir, `${runId}.jsonl`), toJSONL(trace.slice(0, cut)) + next.slice(0, 20));
  writeFileSync(join(dir, `${runId}.lock`), String(DEAD_PID));
}

describe("fileStore", () => {
  it("writes a run as it goes and reads it back", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const result = await graph.run({ n: 0 }, { onEvent: store.sink });
    expect(store.load(result.runId)).toEqual(JSON.parse(JSON.stringify(result.trace)));
    expect(existsSync(join(dir, `${result.runId}.lock`))).toBe(false);
    expect(store.list()).toMatchObject([{ runId: result.runId, status: "completed", events: result.trace.length }]);
    expect(store.load("missing")).toBeUndefined();
  });

  it("continues a run whose last line was torn by a crash", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const cut = trace.findIndex((e) => e.type === "exit" && e.nodeId === "a") + 1;
    crashed(dir, trace, cut);
    const store = fileStore(dir);
    expect(store.list()).toMatchObject([{ runId: trace[0]?.runId, status: "interrupted" }]);
    const loaded = store.load(trace[0]?.runId as string) as Trace;
    expect(loaded).toHaveLength(cut);
    const done = await graph.resume(loaded, undefined, { onEvent: store.sink });
    expect(done.state).toMatchObject({ n: 2, sent: true });
    expect(runStatus(store.load(done.runId) as Trace)).toBe("completed");
    expect(readFileSync(join(dir, `${done.runId}.jsonl`), "utf8").endsWith("\n")).toBe(true);
  });

  it("will not restart a write step that was running when the process died", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const cut = trace.findIndex((e) => e.type === "enter" && e.nodeId === "send") + 1;
    crashed(dir, trace, cut);
    const store = fileStore(dir);
    const error = await graph
      .resume(store.load(trace[0]?.runId as string) as Trace, undefined, { onEvent: store.sink })
      .catch((e: unknown) => e);
    expect(isTaugraphError(error) && error.code).toBe("UNKNOWN_OUTCOME");
  });

  it("pauses, releases the lock, and resumes later", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const paused = await asking.run({ n: 0 }, { onEvent: store.sink });
    expect(existsSync(join(dir, `${paused.runId}.lock`))).toBe(false);
    expect(store.list()).toMatchObject([{ status: "paused" }]);
    const done = await asking.resume(store.load(paused.runId) as Trace, "yes", { onEvent: fileStore(dir).sink });
    expect(done.state.answer).toBe("yes");
    expect(store.list()).toMatchObject([{ status: "completed" }]);
  });

  it("refuses a run another live process is writing, and takes over a dead one's lock", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const runId = trace[0]?.runId as string;
    crashed(dir, trace, 3);
    writeFileSync(join(dir, `${runId}.lock`), String(process.pid));
    const store = fileStore(dir);
    expect(store.list()).toMatchObject([{ status: "running" }]);
    const error = await graph.resume(store.load(runId) as Trace, undefined, { onEvent: store.sink }).catch((e) => e);
    expect(String(error)).toContain(`Run "${runId}" is being written by process ${process.pid}`);
    writeFileSync(join(dir, `${runId}.lock`), String(DEAD_PID));
    const done = await graph.resume(store.load(runId) as Trace, undefined, { onEvent: store.sink });
    expect(done.status).toBe("completed");
  });

  it("refuses gaps, duplicate runs and runIds that are not file names", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const { trace } = await graph.run({ n: 0 }, { onEvent: store.sink });
    const runId = trace[0]?.runId as string;
    expect(() => store.sink(trace[0] as Trace[number])).toThrow(`Run "${runId}" already exists in ${dir}`);
    expect(() => store.sink({ ...(trace[5] as Trace[number]), runId: "fresh" })).toThrow(
      `Run "fresh" has no file in ${dir} to continue`,
    );
    const short = temp();
    crashed(short, trace, 3);
    expect(() => fileStore(short).sink(trace[5] as Trace[number])).toThrow(
      `Run "${runId}" on disk ends at seq 2, but the next event is seq 5`,
    );
    expect(() => store.load("../etc/passwd")).toThrow('Invalid runId "../etc/passwd"');
    await expect(graph.run({ n: 0 }, { runId: "a/b", onEvent: store.sink })).rejects.toThrow(/Invalid runId "a\/b"/);
  });

  it("lists every status, oldest first, and skips files it cannot read", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 15)); // distinct mtimes
    await graph.run({ n: 0 }, { runId: "done-1", onEvent: store.sink });
    await tick();
    await asking.run({ n: 0 }, { runId: "paused-1", onEvent: store.sink });
    await tick();
    const failing = createGraph(schema, {
      start: "a",
      nodes: {
        a: () => {
          throw new Error("boom");
        },
      },
      endNodes: ["a"],
    });
    await failing.run({ n: 0 }, { runId: "failed-1", onEvent: store.sink }).catch(() => undefined);
    await tick();
    const { trace } = await graph.run({ n: 0 }, { runId: "crashed-1" });
    crashed(dir, trace, 3);
    writeFileSync(join(dir, "junk.jsonl"), "not a trace\n");
    expect(store.list().map((r) => [r.runId, r.status])).toEqual([
      ["done-1", "completed"],
      ["paused-1", "paused"],
      ["failed-1", "failed"],
      ["crashed-1", "interrupted"],
    ]);
  });
});
