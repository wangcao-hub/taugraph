// pnpm example:quickstart
// fetch -> answer, then replay the run with the answer node swapped for a mock.
import { z } from "zod";
import { createGraph, diffTraces } from "../src/index.js";
import { CodeNode, type LLMModel, LLMNode } from "../src/nodes/index.js";
import { modelFromEnv } from "./adapters/openai-compatible.js";

const schema = z.object({
  question: z.string(),
  raw: z.string().nullable().default(null),
  final: z.string().nullable().default(null),
});

// Set TAUGRAPH_BASE_URL + TAUGRAPH_MODEL to use a real model, e.g. Ollama:
//   TAUGRAPH_BASE_URL=http://localhost:11434/v1 TAUGRAPH_MODEL=qwen3 pnpm example:quickstart
const echoModel: LLMModel = {
  id: "mock:echo",
  complete: (request) => ({ content: `(mock) ${request.messages.at(-1)?.content}` }),
};
const model = modelFromEnv() ?? echoModel;

const graph = createGraph(schema, {
  start: "fetch",
  nodes: {
    fetch: CodeNode((s) => ({ ...s, raw: `Reference notes about "${s.question}"` })),
    answer: LLMNode({
      model,
      prompt: (s) => `Answer in one sentence using these notes: ${s.raw}\n\nQuestion: ${s.question}`,
      update: (s, text) => ({ ...s, final: text }),
    }),
  },
  edges: [{ from: "fetch", to: "answer" }],
  endNodes: ["answer"],
});

const { state, trace } = await graph.run({ question: "What is agent orchestration?" });
console.log("answer:", state.final);
console.log("events:", trace.map((e) => e.type).join(" -> "));

// Replay: `fetch` is reused from the recording, `answer` runs the override.
const replayed = await graph.replay(trace, {
  overrides: { answer: CodeNode((s) => ({ ...s, final: "mock answer" })) },
});
console.log("replayed answer:", replayed.state.final);
console.log("diff:", diffTraces(trace, replayed.trace));
