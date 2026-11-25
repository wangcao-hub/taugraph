import * as fs from "node:fs";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, fsyncSync: vi.fn(real.fsyncSync), writeSync: vi.fn(real.writeSync) };
});

const { fileStore } = await import("../src/file/index.js");
const { createGraph, isTaugraphError, runStatus } = await import("../src/index.js");

const schema = z.object({ n: z.number() });
type S = z.infer<typeof schema>;
const graph = createGraph(schema, {
  start: "a",
  nodes: {
    a: (s: S) => ({ n: s.n + 1 }),
    send: Object.assign((s: S) => s, { effect: "write" as const }),
  },
  edges: [{ from: "a", to: "send" }],
  endNodes: ["send"],
});

async function fsyncs(durability?: "writes" | "every" | "none"): Promise<{ count: number; events: number }> {
  const spy = vi.mocked(fs.fsyncSync);
  spy.mockClear();
  const store = fileStore(mkdtempSync(join(tmpdir(), "taugraph-durability-")), durability ? { durability } : {});
  const { trace } = await graph.run({ n: 0 }, { onEvent: store.sink });
  return { count: spy.mock.calls.length, events: trace.length };
}

describe("fileStore durability", () => {
  it("fsyncs the directory once, then around the write step and at the end by default", async () => {
    expect((await fsyncs()).count).toBe(3); // directory, enter of "send", run_end
  });

  it("fsyncs every event, or never", async () => {
    const every = await fsyncs("every");
    expect(every.count).toBe(every.events + 1); // plus the directory
    expect((await fsyncs("none")).count).toBe(0);
  });

  it("releases the run when a write fails, so the same store can resume it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-durability-"));
    const store = fileStore(dir);
    const full = Object.assign(new Error("no space"), { code: "ENOSPC" });
    const error = await graph
      .run(
        { n: 0 },
        {
          runId: "r",
          onEvent: (event) => {
            if (event.seq === 2) {
              vi.mocked(fs.writeSync).mockImplementationOnce(() => {
                throw full;
              });
            }
            store.sink(event);
          },
        },
      )
      .catch((e: unknown) => e);
    expect(isTaugraphError(error) && error.code).toBe("SINK_FAILED");
    expect(existsSync(join(dir, "r.lock"))).toBe(false);
    expect(store.list()).toMatchObject([{ runId: "r", status: "interrupted" }]);
    const trace = store.load("r");
    expect(trace).toHaveLength(2);
    const done = await graph.resume(trace as NonNullable<typeof trace>, undefined, { onEvent: store.sink });
    expect(done.status).toBe("completed");
    expect(runStatus(store.load("r") as NonNullable<typeof trace>)).toBe("completed");
  });
});
