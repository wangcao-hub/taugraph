import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, fsyncSync: vi.fn(real.fsyncSync) };
});

const { fileStore } = await import("../src/file/index.js");
const { createGraph } = await import("../src/index.js");

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
});
