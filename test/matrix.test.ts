// Pause / resume / replay / crash recovery across graph shapes, so a fix for one shape
// (e.g. a human node at the start) cannot silently break another.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, diffTraces, fromJSONL, type Trace, toJSONL } from "../src/index.js";
import { CodeNode, HumanNode } from "../src/nodes/index.js";

const schema = z.object({
  n: z.number().default(0),
  a: z.string().nullable().default(null),
  b: z.string().nullable().default(null),
});
type S = z.infer<typeof schema>;
const human = (key: "a" | "b") =>
  HumanNode<S, string>({ ask: () => `${key}?`, answer: z.string().min(2), update: (s, v) => ({ ...s, [key]: v }) });
const inc = CodeNode<S>((s) => ({ ...s, n: s.n + 1 }));

// human at start / middle / end, and two humans in a row
const shapes = {
  start: () =>
    createGraph(schema, {
      start: "h",
      nodes: { h: human("a"), x: inc },
      edges: [{ from: "h", to: "x" }],
      endNodes: ["x"],
    }),
  middle: () =>
    createGraph(schema, {
      start: "x",
      nodes: { x: inc, h: human("a"), y: inc },
      edges: [
        { from: "x", to: "h" },
        { from: "h", to: "y" },
      ],
      endNodes: ["y"],
    }),
  end: () =>
    createGraph(schema, {
      start: "x",
      nodes: { x: inc, h: human("a") },
      edges: [{ from: "x", to: "h" }],
      endNodes: ["h"],
    }),
  twoHumans: () =>
    createGraph(schema, {
      start: "h",
      nodes: { h: human("a"), k: human("b") },
      edges: [{ from: "h", to: "k" }],
      endNodes: ["k"],
    }),
};

async function converse(g: ReturnType<(typeof shapes)[keyof typeof shapes]>, answers: string[], viaJsonl: boolean) {
  let r = await g.run({});
  for (const v of answers) {
    if (r.status !== "paused") break;
    r = await g.resume(viaJsonl ? fromJSONL(toJSONL(r.trace)) : r.trace, v);
  }
  return r;
}

for (const [name, make] of Object.entries(shapes)) {
  describe(`shape: ${name}`, () => {
    const answers = ["x", "ok", "fine"]; // "x" is invalid (min 2) -> asked again
    for (const viaJsonl of [false, true]) {
      it(`completes (jsonl=${viaJsonl})`, async () => {
        const r = await converse(make(), answers, viaJsonl);
        expect(r.status).toBe("completed");
        expect(r.state.a).toBe("ok");
      });
    }
    for (const mode of ["recorded", "live"] as const) {
      it(`replays to the same result (${mode})`, async () => {
        const g = make();
        const r = await converse(g, answers, false);
        const rp = await g.replay(r.trace, { mode });
        expect(rp.status).toBe("completed");
        expect(rp.state).toEqual(r.state);
        expect(diffTraces(r.trace, rp.trace).equal).toBe(true);
        const rp2 = await g.replay(fromJSONL(toJSONL(rp.trace)), { mode });
        expect(rp2.state).toEqual(r.state);
      });
    }
    it("recovers from a crash after any event", async () => {
      const g = make();
      const r = await converse(g, answers, false);
      for (let cut = 1; cut < r.trace.length; cut++) {
        const partial: Trace = r.trace.slice(0, cut);
        const last = partial[partial.length - 1];
        const paused = last?.type === "run_end"; // every run_end before the final one is a pause
        let out = await g.resume(partial, paused ? "ok" : undefined);
        for (let i = 0; i < 3 && out.status === "paused"; i++) out = await g.resume(out.trace, "ok");
        expect(out.status, `cut after seq ${cut - 1} (${last?.type})`).toBe("completed");
        expect(out.state.a).toBe("ok");
        expect(out.trace.map((e) => e.seq)).toEqual(out.trace.map((_, i) => i));
      }
    });
    it("works with runSync / resumeSync", () => {
      const g = make();
      let r = g.runSync({});
      for (const v of answers) if (r.status === "paused") r = g.resumeSync(r.trace, v);
      expect(r.status).toBe("completed");
    });
  });
}
