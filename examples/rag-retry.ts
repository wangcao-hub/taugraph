// pnpm example:rag
// Retrieval -> LLM answer, with a conditional retry loop:
//
//   search ──(docs found)──▶ answer (end)
//     ▲  └──(no docs, attempts < 3)──▶ rewrite ──▶ search
//     └──(no docs, attempts >= 3)──▶ giveUp (end)
//
// The trace is streamed to examples/out/<runId>.jsonl as it is written, then replayed
// with a different model; retrieval is reused from the recording, not re-executed.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createGraph, diffTraces, fromJSONL, type RunContext } from "../src/index.js";
import { CodeNode, type LLMModel, LLMNode, textOf } from "../src/nodes/index.js";
import { modelFromEnv } from "./adapters/openai-compatible.js";

const schema = z.object({
  question: z.string().min(1),
  query: z.string().nullable().default(null),
  attempts: z.number().int().default(0),
  docs: z.array(z.string()).nullable().default(null),
  answer: z.string().nullable().default(null),
});
type State = z.infer<typeof schema>;

// --- A fake search tool. Real tools are injected the same way: by the node, not the kernel.
const corpus: Record<string, string> = {
  orchestration: "Agent orchestration decides which step runs next and what state it sees.",
  graph: "A graph harness models an agent workflow as nodes connected by edges.",
  replay: "Replaying a trace re-runs a workflow from recorded inputs to compare outputs.",
};
function searchTool(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/);
  return Object.entries(corpus)
    .filter(([key]) => words.includes(key))
    .map(([, doc]) => doc);
}

// --- Models: a real one from env, or deterministic mocks.
const mock = (id: string, style: (docs: string) => string): LLMModel => ({
  id,
  complete: (request) => ({ content: style(textOf(request.messages.at(-1)?.content ?? "")) }),
});
const model = modelFromEnv() ?? mock("mock:verbose", (prompt) => `Based on the notes: ${prompt.split("\n")[1]}`);
const conciseModel = mock("mock:concise", () => "Orchestration = choosing the next step.");

const answerNode = (m: LLMModel) =>
  LLMNode<State>({
    model: m,
    prompt: (s) => ({
      messages: [
        { role: "system", content: "Answer using only the notes. One sentence." },
        { role: "user", content: `Question: ${s.question}\n${(s.docs ?? []).join(" ")}` },
      ],
      temperature: 0,
    }),
    update: (s, text) => ({ ...s, answer: text }),
    retry: { maxAttempts: 2 },
  });

const graph = createGraph(schema, {
  start: "search",
  nodes: {
    search: CodeNode((s, ctx: RunContext) => {
      const query = s.query ?? s.question;
      const docs = searchTool(query);
      // Side effects are declared explicitly in the transcript.
      ctx.trace.append({ type: "tool_call", input: { tool: "search", query }, output: docs });
      return { ...s, query, docs: docs.length > 0 ? docs : null };
    }),
    rewrite: CodeNode((s) => ({
      ...s,
      attempts: s.attempts + 1,
      // A real graph might ask an LLM here. This one strips punctuation and stop words.
      query: s.question
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => !["what", "is", "agent", "an", "the", "a"].includes(w))
        .join(" "),
    })),
    answer: answerNode(model),
    giveUp: CodeNode((s) => ({ ...s, answer: "Sorry, I could not find anything about that." })),
  },
  conditionalEdges: [
    {
      from: "search",
      route: (s) => (s.docs ? "answer" : s.attempts < 3 ? "rewrite" : "giveUp"),
      targets: ["answer", "rewrite", "giveUp"],
    },
  ],
  edges: [{ from: "rewrite", to: "search" }],
  endNodes: ["answer", "giveUp"],
});

// --- Run, streaming the append-only log to disk.
const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
let file = "";
const result = await graph.run(
  { question: "What is agent orchestration?" },
  {
    onEvent: (event) => {
      file ||= join(outDir, `${event.runId}.jsonl`);
      appendFileSync(file, `${JSON.stringify(event)}\n`);
    },
  },
);

console.log("path:   ", result.path.join(" -> "));
console.log("answer: ", result.state.answer);
console.log("trace:  ", file);

// --- Load the trace back from disk and replay it with a different model.
const recorded = fromJSONL(readFileSync(file, "utf8"));
const replayed = await graph.replay(recorded, { overrides: { answer: answerNode(conciseModel) } });

console.log("\nreplay with mock:concise");
for (const event of replayed.trace.filter((e) => e.type === "exit")) {
  console.log(`  step ${event.step} ${String(event.nodeId).padEnd(8)} source=${event.meta?.source}`);
}
console.log("answer: ", replayed.state.answer);
console.log("diff:   ", JSON.stringify(diffTraces(recorded, replayed.trace)));
