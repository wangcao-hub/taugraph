// pnpm example:checkout
// Decision / execution separation, with a human in the loop:
//
//   quote ──▶ confirm (human) ──▶ classify (LLM picks ONE command) ──┬─ confirm ─▶ place (write, end)
//     ▲                ▲                                            ├─ modify ──▶ quote
//     │                └──────────── explain ◀──────────────────────┼─ explore
//     └─────────────────────────────────────────────────────────────┴─ cancel ──▶ cancelled (end)
//
// The model only classifies the user's reply into a fixed set of commands; the schema rejects
// anything else. Prices, routing and the order call are code. The run pauses for every reply
// and is stored as JSONL between turns, as if the process restarted.
import { z } from "zod";
import { createGraph, diffTraces, fromJSONL, isTaugraphError, toJSONL } from "../src/index.js";
import { CodeNode, HumanNode, type LLMModel, LLMNode } from "../src/nodes/index.js";
import { modelFromEnv } from "./adapters/openai-compatible.js";

const Command = z.enum(["confirm", "modify", "explore", "cancel"]);

const schema = z.object({
  item: z.string(),
  qty: z.number().int().positive().default(1),
  price: z.number().nullable().default(null),
  reply: z.string().nullable().default(null),
  command: Command.nullable().default(null),
  note: z.string().nullable().default(null),
  orderId: z.string().nullable().default(null),
  outcome: z.enum(["ordered", "cancelled"]).nullable().default(null),
});
type State = z.infer<typeof schema>;

const PRICES: Record<string, number> = { "coffee beans": 18 };

// Deterministic stand-in for a small model. Set TAUGRAPH_BASE_URL / TAUGRAPH_MODEL to use a real one.
const keywordModel: LLMModel = {
  id: "mock:keywords",
  complete(request) {
    const text = (request.messages.at(-1)?.content ?? "").toLowerCase();
    const qty = /\b(\d+)\b/.exec(text)?.[1];
    if (qty) return { content: JSON.stringify({ command: "modify", qty: Number(qty) }) };
    if (text.includes("?")) return { content: JSON.stringify({ command: "explore" }) };
    if (/\b(no|cancel|stop)\b/.test(text)) return { content: JSON.stringify({ command: "cancel" }) };
    return { content: JSON.stringify({ command: /\b(yes|ok|go ahead|confirm)\b/.test(text) ? "confirm" : "explore" }) };
  },
};
const model = modelFromEnv() ?? keywordModel;

const graph = createGraph(schema, {
  start: "quote",
  nodes: {
    quote: CodeNode((s) => ({ ...s, price: (PRICES[s.item] ?? 0) * s.qty, note: null })),
    confirm: HumanNode<State, string>({
      ask: (s) => ({ text: `${s.note ? `${s.note} ` : ""}${s.qty} x ${s.item} for $${s.price}. Place the order?` }),
      answer: z.string().min(1),
      update: (s, reply) => ({ ...s, reply }),
    }),
    classify: LLMNode({
      model,
      prompt: (s) => ({
        messages: [
          {
            role: "system",
            content:
              'The user is looking at an order preview. Reply with JSON only: {"command": "confirm" | "modify" | "explore" | "cancel", "qty"?: number}. "qty" only with "modify".',
          },
          { role: "user", content: s.reply ?? "" },
        ],
        temperature: 0,
        responseFormat: "json",
      }),
      // Anything outside the allowed commands fails validation and is retried, never executed.
      output: z.object({ command: Command, qty: z.number().int().positive().optional() }),
      update: (s, out) => ({ ...s, command: out.command, qty: out.command === "modify" ? (out.qty ?? s.qty) : s.qty }),
      retry: { maxAttempts: 2 },
    }),
    explain: CodeNode((s) => ({ ...s, note: "Shipping is free on orders over $30." })),
    place: CodeNode(
      (s, ctx) => {
        const orderId = `order-${s.item.replace(/\s+/g, "-")}-${s.qty}`; // a real API call goes here
        ctx.trace.append({
          type: "tool_call",
          input: { tool: "orders.create", item: s.item, qty: s.qty },
          output: { orderId },
        });
        return { ...s, orderId, outcome: "ordered" };
      },
      { effect: "write" },
    ),
    cancelled: CodeNode((s) => ({ ...s, outcome: "cancelled" })),
  },
  edges: [
    { from: "quote", to: "confirm" },
    { from: "confirm", to: "classify" },
    { from: "explain", to: "confirm" },
  ],
  conditionalEdges: [
    {
      from: "classify",
      route: (s) => {
        if (s.command === "confirm") return "place";
        if (s.command === "modify") return "quote";
        if (s.command === "cancel") return "cancelled";
        return "explain";
      },
      targets: ["place", "quote", "explain", "cancelled"],
    },
  ],
  endNodes: ["place", "cancelled"],
});

// --- A conversation. Each user turn resumes the paused run from its stored JSONL.
let stored = "";
let result = await graph.run({ item: "coffee beans" });
for (const reply of ["make it 2", "is shipping included?", "yes, go ahead"]) {
  if (result.status !== "paused") break;
  console.log(`bot:  ${(result.pending.request as { text: string }).text}`);
  console.log(`user: ${reply}`);
  stored = toJSONL(result.trace); // persist; the process could exit here
  result = await graph.resume(fromJSONL(stored), reply);
}
console.log(`\n${result.status}: ${result.state.outcome} ${result.state.orderId ?? ""}`);
console.log(`path: ${result.path.join(" -> ")}`);

// --- Replay safety: re-running the conversation must not place a second order.
try {
  await graph.replay(result.trace, { mode: "live" });
} catch (error) {
  if (!isTaugraphError(error)) throw error;
  console.log(`\nlive replay stopped: ${error.code} at "${error.nodeId}"`);
}

// Swap in a mock order API and the same replay runs end to end; human replies come from the trace.
const replayed = await graph.replay(result.trace, {
  mode: "live",
  overrides: { place: CodeNode((s) => ({ ...s, orderId: "mock-order", outcome: "ordered" })) },
});
console.log(`replay with mock: ${replayed.status}, ${replayed.state.orderId}`);
console.log(`changed keys: ${diffTraces(result.trace, replayed.trace).changedKeys.join(", ")}`);
