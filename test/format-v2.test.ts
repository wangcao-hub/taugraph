import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, tool } from "../src/agent/index.js";
import {
  createGraph,
  createTraceEncoder,
  fromJSONL,
  runStatus,
  type StandardSchemaV1,
  TRACE_VERSION,
  type Trace,
  toJSONL,
} from "../src/index.js";

const plain = (trace: Trace) => JSON.parse(JSON.stringify(trace));

function errorOf(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

function agentRun(calls: number, size = 5000) {
  const big = "x".repeat(size);
  const replies = Array.from({ length: calls }, (_, i) => ({
    content: "",
    toolCalls: [{ id: `c${i}`, name: "read", arguments: { i } }],
  }));
  const model = { id: "mock", complete: () => replies.shift() ?? { content: "done" } };
  const read = tool({ name: "read", run: () => big });
  return createAgent({ model, tools: [read], maxRounds: calls + 1 }).runSync({
    messages: [{ role: "user", content: "go" }],
  });
}

function pausingGraph() {
  const schema = z.object({ n: z.number(), answer: z.string().nullable().default(null) });
  return createGraph(schema, {
    start: "count",
    nodes: {
      count: (s: z.infer<typeof schema>) => ({ ...s, n: s.n + 1 }),
      ask: (s: z.infer<typeof schema>, ctx) => ({ ...s, answer: ctx.interrupt<string>({ question: "ok?" }) }),
    },
    edges: [{ from: "count", to: "ask" }],
    endNodes: ["ask"],
  });
}

describe("trace format v2", () => {
  it("writes version 2 and reads back the same events", () => {
    const { trace } = agentRun(3, 50);
    expect(trace[0]?.meta?.version).toBe(TRACE_VERSION);
    expect(TRACE_VERSION).toBe(2);
    const text = toJSONL(trace);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"outputPatch"');
    expect(fromJSONL(text)).toEqual(plain(trace));
  });

  it("round-trips paused, resumed and replayed runs", async () => {
    const graph = pausingGraph();
    const paused = await graph.run({ n: 0 });
    const done = await graph.resume(paused.trace, "yes");
    const replayed = await graph.replay(done.trace);
    for (const trace of [paused.trace, done.trace, replayed.trace]) {
      expect(fromJSONL(toJSONL(trace))).toEqual(plain(trace));
    }
    expect(runStatus(paused.trace)).toBe("paused");
    expect(runStatus(done.trace)).toBe("completed");
    expect(runStatus(done.trace.slice(0, 3))).toBe("running");
  });

  it("writes chunks that concatenate into the whole trace", () => {
    const { trace } = agentRun(4, 50);
    const cut = 7;
    const text = `${toJSONL(trace, { from: 0 }).split("\n").slice(0, cut).join("\n")}\n${toJSONL(trace, { from: cut })}`;
    expect(fromJSONL(text)).toEqual(plain(trace));
    expect(toJSONL(trace, { from: trace.length })).toBe("");
    const encoder = createTraceEncoder(trace.slice(0, cut));
    const lines = trace.slice(cut).map((e) => encoder.encode(e));
    expect(`${lines.join("\n")}\n`).toBe(toJSONL(trace, { from: cut }));
  });

  it("reads version 1 text", () => {
    const { trace } = agentRun(2, 50);
    const v1 = trace.map((e, i) => JSON.stringify(i === 0 ? { ...e, meta: { ...e.meta, version: 1 } } : e)).join("\n");
    const read = fromJSONL(v1);
    expect(read[0]?.meta?.version).toBe(1);
    expect(read.slice(1)).toEqual(plain(trace).slice(1));
  });

  it("continues a version 1 trace with full lines, so the file stays version 1", () => {
    const { trace } = agentRun(3, 50);
    const v1Lines = trace.map((e, i) => JSON.stringify(i === 0 ? { ...e, meta: { ...e.meta, version: 1 } } : e));
    const v1 = fromJSONL(v1Lines.join("\n"));
    const cut = 4;
    const head = v1Lines.slice(0, cut).join("\n");
    const encoder = createTraceEncoder(v1.slice(0, cut));
    const lines = v1.slice(cut).map((e) => encoder.encode(e));
    for (const line of lines) expect(line).not.toMatch(/"(input|output)Patch"/);
    expect(fromJSONL(`${head}\n${lines.join("\n")}\n`)).toEqual(plain(v1));
    const chunk = toJSONL(v1, { from: cut });
    expect(chunk).not.toMatch(/"(input|output)Patch"/);
    expect(fromJSONL(`${head}\n${chunk}`)).toEqual(plain(v1));
    expect(toJSONL(v1)).toContain('"outputPatch"');
  });

  it("drops a torn last line only when asked, and never a broken line in the middle", () => {
    const { trace } = agentRun(2, 50);
    const text = toJSONL(trace);
    const torn = text.slice(0, text.length - 15);
    expect(() => fromJSONL(torn)).toThrow(/is not valid JSON/);
    expect(fromJSONL(torn, { tornTail: "drop" })).toEqual(plain(trace.slice(0, -1)));
    const lines = text.split("\n");
    lines[2] = "{broken";
    expect(() => fromJSONL(lines.join("\n"), { tornTail: "drop" })).toThrow(/Line 3/);
  });

  it("grows linearly with the number of steps", () => {
    const run100 = agentRun(100);
    const text100 = toJSONL(run100.trace);
    const conversation = JSON.stringify(run100.state.messages).length;
    expect(text100.length).toBeLessThan(5 * conversation);
    const text50 = toJSONL(agentRun(50).trace);
    expect(text100.length / text50.length).toBeLessThan(2.5);
    const read = fromJSONL(text100);
    const thinks = read.filter((e) => e.type === "enter" && e.nodeId === "think");
    const messages = (i: number) => ((thinks[i] as Trace[number]).input as { messages: unknown[] }).messages;
    expect(messages(50)[1]).toBe(messages(49)[1]);
  });

  it("rejects lines that are not objects", () => {
    const lines = toJSONL(agentRun(1, 50).trace).split("\n");
    for (const bad of ["null", "[1]", "[]"]) {
      const text = [lines[0], bad, ...lines.slice(2)].join("\n");
      expect(errorOf(() => fromJSONL(text))).toMatchObject({
        code: "INVALID_TRACE",
        message: "Event 1 is not an object",
      });
    }
  });

  it("rejects an unsupported version before reading any patch", () => {
    const lines = toJSONL(agentRun(1, 50).trace).split("\n");
    const head = JSON.parse(lines[0] as string);
    const text = [
      JSON.stringify({ ...head, meta: { ...head.meta, version: 3 } }),
      JSON.stringify({ ...JSON.parse(lines[1] as string), inputPatch: [{ op: "move", path: "/x", from: "/y" }] }),
      ...lines.slice(2),
    ].join("\n");
    expect(errorOf(() => fromJSONL(text))).toMatchObject({
      code: "INVALID_TRACE",
      message: "Unsupported trace version 3 (expected 1 or 2)",
    });
  });

  it("round-trips state with keys named constructor, toString and __proto__", async () => {
    type State = { readonly words: Readonly<Record<string, number>> };
    const passThrough: StandardSchemaV1<State, State> = {
      "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as State }) },
    };
    const words = (entries: [string, number][]) => ({ words: Object.fromEntries(entries) });
    const graph = createGraph(passThrough, {
      start: "add",
      nodes: {
        add: (s) => words([...Object.entries(s.words), ["constructor", 1], ["toString", 2], ["__proto__", 3]]),
        change: (s) =>
          words(
            Object.entries(s.words)
              .filter(([k]) => k !== "constructor" && k !== "toString")
              .map(([k, v]) => [k, k === "__proto__" ? v + 1 : v]),
          ),
        drop: (s) => words(Object.entries(s.words).filter(([k]) => k !== "__proto__")),
      },
      edges: [
        { from: "add", to: "change" },
        { from: "change", to: "drop" },
      ],
      endNodes: ["drop"],
    });
    const { trace } = await graph.run({ words: { a: 1 } });
    const read = fromJSONL(toJSONL(trace));
    expect(read).toEqual(plain(trace));
    const outputs = read.filter((e) => e.type === "exit").map((e) => (e.output as State).words);
    expect(outputs.map((w) => Object.keys(w).sort())).toEqual([
      ["__proto__", "a", "constructor", "toString"],
      ["__proto__", "a"],
      ["a"],
    ]);
    for (const w of outputs) expect(Object.getPrototypeOf(w)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(outputs[1], "__proto__")?.value).toBe(4);
  });
});
