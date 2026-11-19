import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, diffTraces, fromJSONL, type TaugraphError, toJSONL } from "../src/index.js";
import { CodeNode } from "../src/nodes/index.js";

const schema = z.object({
  question: z.string(),
  docs: z.string().nullable().default(null),
  answer: z.string().nullable().default(null),
});
type State = z.infer<typeof schema>;

function setup() {
  const calls = { search: 0, answer: 0 };
  const graph = createGraph(schema, {
    start: "search",
    nodes: {
      search: (s) => {
        calls.search++;
        return { ...s, docs: `docs about ${s.question}` };
      },
      answer: async (s) => {
        calls.answer++;
        return { ...s, answer: `live answer using ${s.docs}` };
      },
    },
    edges: [{ from: "search", to: "answer" }],
    endNodes: ["answer"],
  });
  return { graph, calls };
}

describe("replay", () => {
  it("reuses recorded outputs and only runs overridden nodes", async () => {
    const { graph, calls } = setup();
    const original = await graph.run({ question: "agents" });
    expect(calls).toEqual({ search: 1, answer: 1 });

    const replayed = await graph.replay(original.trace, {
      overrides: { answer: CodeNode<State>((s) => ({ ...s, answer: "mock answer" })) },
    });

    expect(calls).toEqual({ search: 1, answer: 1 }); // search came from the trace, answer from the override
    expect(replayed.state.answer).toBe("mock answer");
    expect(replayed.state.docs).toBe("docs about agents");
    expect(replayed.runId).not.toBe(original.runId);
    expect(replayed.trace[0]?.meta).toMatchObject({ replayOf: original.runId, replayMode: "recorded" });
    const sources = replayed.trace.filter((e) => e.type === "exit").map((e) => [e.nodeId, e.meta?.source]);
    expect(sources).toEqual([
      ["search", "recorded"],
      ["answer", "override"],
    ]);
  });

  it("produces the same result as the original when nothing is overridden", async () => {
    const { graph, calls } = setup();
    const original = await graph.run({ question: "agents" });
    const replayed = await graph.replay(original.trace);
    expect(calls).toEqual({ search: 1, answer: 1 });
    expect(diffTraces(original.trace, replayed.trace).equal).toBe(true);
  });

  it("runs live once the state diverges from the recording", async () => {
    const { graph, calls } = setup();
    const original = await graph.run({ question: "agents" });
    await graph.replay(original.trace, {
      overrides: { search: (s) => ({ ...s, docs: "different docs" }) },
    });
    // answer saw a different input than recorded, so it had to run for real
    expect(calls).toEqual({ search: 1, answer: 2 });
  });

  it("re-executes everything in live mode", async () => {
    const { graph, calls } = setup();
    const original = await graph.run({ question: "agents" });
    await graph.replay(original.trace, { mode: "live" });
    expect(calls).toEqual({ search: 2, answer: 2 });
  });

  it("replays a trace loaded from JSONL", async () => {
    const { graph, calls } = setup();
    const original = await graph.run({ question: "agents" });
    const replayed = await graph.replay(fromJSONL(toJSONL(original.trace)));
    expect(calls).toEqual({ search: 1, answer: 1 });
    expect(replayed.state).toEqual(original.state);
  });

  it("replays failed runs up to the failure", async () => {
    let fail = true;
    const graph = createGraph(schema, {
      start: "search",
      nodes: {
        search: (s) => ({ ...s, docs: "d" }),
        answer: (s) => {
          if (fail) throw new Error("model down");
          return { ...s, answer: "fixed" };
        },
      },
      edges: [{ from: "search", to: "answer" }],
      endNodes: ["answer"],
    });
    const error = (await graph.run({ question: "q" }).catch((e) => e)) as TaugraphError;
    fail = false;
    const replayed = await graph.replay(error.trace ?? []);
    expect(replayed.state.answer).toBe("fixed");
  });

  it("rejects overrides for unknown nodes", async () => {
    const { graph } = setup();
    const original = await graph.run({ question: "agents" });
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: unknown node on purpose
      graph.replay(original.trace, { overrides: { nope: (s: any) => s } as any }),
    ).rejects.toThrow(/unknown node "nope"/);
  });
});

describe("diffTraces", () => {
  it("reports the first divergence and changed keys", async () => {
    const { graph } = setup();
    const original = await graph.run({ question: "agents" });
    const replayed = await graph.replay(original.trace, {
      overrides: { answer: (s) => ({ ...s, answer: "other" }) },
    });
    const diff = diffTraces(original.trace, replayed.trace);
    expect(diff.equal).toBe(false);
    expect(diff.firstDivergence).toEqual({ step: 1, a: "answer", b: "answer" });
    expect(diff.changedKeys).toEqual(["answer"]);
    expect(diff.path).toEqual({ a: ["search", "answer"], b: ["search", "answer"] });
  });
});
