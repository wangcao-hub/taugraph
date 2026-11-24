// pnpm example:agent
// A tool-calling agent as a taugraph graph:
//
//   think (model) ──a read call──▶ act ───────┐
//     ▲          ──a write call─▶ act_write ──┤ (each call is one step)
//     └───────────────────────────────────────┘
//   think ──no calls──▶ finish
//
// `weather` only reads, so it runs freely. `add_todo` changes something, so it runs in the write step and
// waits for the user's approval. The run pauses, is stored as JSONL as if the process restarted, resumes with
// the answer, and is replayed: recorded outputs are reused, so the write is not repeated.
import { z } from "zod";
import { createAgent, tool } from "../src/agent/index.js";
import { diffTraces, fromJSONL, toJSONL } from "../src/index.js";
import type { LLMModel, LLMResponse } from "../src/nodes/index.js";
import { modelFromEnv } from "./adapters/openai-compatible.js";

const todos: string[] = [];

const weather = tool({
  name: "weather",
  description: "Today's weather for a city",
  input: z.object({ city: z.string().describe("City name") }),
  run: ({ city }) => `${city}: cloudy, -2~5°C, no rain`,
});

const addTodo = tool({
  name: "add_todo",
  description: "Add an item to the user's todo list",
  effect: "write",
  input: z.object({ text: z.string() }),
  run: ({ text }) => {
    todos.push(text);
    return `added "${text}"`;
  },
});

// Deterministic stand-in. Set TAUGRAPH_BASE_URL / TAUGRAPH_MODEL to use a real model with tool calling.
const replies: LLMResponse[] = [
  { content: "", toolCalls: [{ id: "c1", name: "weather", arguments: { city: "Nanjing" } }] },
  { content: "", toolCalls: [{ id: "c2", name: "add_todo", arguments: { text: "bring a coat" } }] },
  { content: "It is cold in Nanjing today; I added “bring a coat” to your todos." },
];
const scripted: LLMModel = { id: "mock:script", complete: () => replies.shift() ?? { content: "done" } };

const agent = createAgent({
  model: modelFromEnv() ?? scripted,
  tools: [weather, addTodo],
  system: "You help with the day. Check the weather before giving advice.",
  approve: (_call, t) => (t.effect === "write" ? "ask" : "run"),
});

const first = await agent.run({ messages: [{ role: "user", content: "What should I wear in Nanjing today?" }] });
console.log("status:", first.status);
if (first.status !== "paused") throw new Error("expected a pause for approval");
console.log("asks:", JSON.stringify(first.pending.request));

const stored = toJSONL(first.trace); // keep it anywhere; the process could exit here
const done = await agent.resume(fromJSONL(stored), true);
console.log("status:", done.status, "| path:", done.path.join(" → "));
console.log("answer:", done.state.final);
console.log("todos:", todos);

const again = await agent.replay(done.trace);
console.log("replay equal:", diffTraces(done.trace, again.trace).equal, "| todos still:", todos.length);
