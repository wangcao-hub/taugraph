# taugraph (τ)

[![CI](https://github.com/wangcao-hub/taugraph/actions/workflows/ci.yml/badge.svg)](https://github.com/wangcao-hub/taugraph/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/taugraph)](https://www.npmjs.com/package/taugraph) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**Minimal typed agent graph harness.**

> Pi is a loop. τ is the trajectory.

A tiny kernel that runs a graph of nodes over one schema-validated, immutable state, and writes every step to an append-only, replayable transcript. LLM calls, tools, sub-agents and humans are plugin nodes. The kernel knows nothing about them.

[中文文档](./README.zh-CN.md) · [Design notes](./docs/design.md) · [Trace format](./docs/trace-format.md)

```
npm install taugraph zod     # or any Standard Schema library: valibot, arktype, ...
```

## Why τ

In reinforcement learning, τ is the standard symbol for a trajectory: the sequence of states and actions an agent goes through. A taugraph run is exactly that, a path through the graph with a state snapshot at every step, recorded so it can be replayed. The name is also a nod to [Pi](https://pi.dev), whose minimal, append-only design taugraph follows (and to τ = 2π).

## Why put the flow in code

If a model decides every step and gets each one right 95% of the time, a 3-step flow succeeds about 86% of the time and a 5-step flow about 77%. Better prompts move 95% to 97%, never to 100%. taugraph takes everything that can be written down in advance (what runs next, when to stop and ask, which calls change the world) out of the model and into a typed graph. The model is left with what only it can do, such as understanding a reply and picking one of a few allowed commands.

## How it works

A model is one kind of node among others. It writes a value into state; code reads that value and decides what happens next.

```mermaid
flowchart LR
  reply(["user reply<br/>resume(trace, value)"]) --> ask
  ask["confirm<br/>HumanNode · ctx.interrupt"] --> classify
  classify["classify<br/>LLMNode<br/>output: one of 4 commands"] --> route{"conditional edge<br/>pure code"}
  route -->|confirm| place["place order<br/>effect: write"]
  route -->|modify| quote["quote<br/>code"]
  route -->|explore| explain["explain<br/>code"]
  route -->|cancel| cancelled["cancelled<br/>code"]
  quote -.-> ask
  explain -.-> ask
  classDef human fill:#fef3c7,stroke:#d97706,color:#111
  classDef model fill:#ede9fe,stroke:#7c3aed,color:#111
  classDef code fill:#e0f2fe,stroke:#0284c7,color:#111
  classDef write fill:#fee2e2,stroke:#dc2626,color:#111
  class reply,ask human
  class classify model
  class route,quote,explain,cancelled code
  class place write
```

<sub>The graph of [`examples/checkout.ts`](./examples/checkout.ts). Yellow waits for a person. Purple is the only place a model runs, and its output must parse as one of four commands. Blue is code you can unit-test. Red changes the outside world, so replays block it unless you allow it.</sub>

Everything taugraph does after a run is computed from one append-only log. There is no second store to keep in sync.

```mermaid
flowchart LR
  exec["run · resume"] -- "append, write-ahead" --> trace[("trace · JSONL<br/>state at every step<br/>LLM and tool calls<br/>human answers")]
  trace -- "resume(trace, value)" --> pause["pause and resume<br/>no checkpointer"]
  trace -- "resume(trace)" --> recover["crash recovery<br/>unfinished write: UNKNOWN_OUTCOME"]
  trace -- "replay(trace, overrides)" --> cf["counterfactual replay<br/>writes blocked"]
  trace -- "diffTraces · export" --> evals["regression evals"]
  classDef log fill:#f1f5f9,stroke:#475569,color:#111
  class trace log
```

## What's new in the design

1. **The trace is the checkpoint.** Pause, resume and crash recovery are all derived from the append-only log, so the kernel has no checkpointer, thread store or storage interface. Store the JSONL wherever you like. (LangGraph's `interrupt()` needs a checkpointer and a thread id.)
2. **Counterfactual replay.** A replayed step reuses its recorded output only when it receives exactly the recorded input state; any step that sees a different state runs live. "What if step 2 had used another model?" is one call, and the steps before the first change cost nothing. (LangGraph's replay re-executes every node after the checkpoint, LLM and API calls included. Durable-execution engines such as Temporal treat a divergence from history as a non-determinism error.)

```mermaid
flowchart LR
  s0["step 0 · quote<br/>recorded"] --> s1["step 1 · confirm<br/>recorded answer: make it 2"] --> s2["step 2 · classify<br/>new model says: confirm"] --> s3["step 3 · place order<br/>WRITE_BLOCKED"]
  classDef rec fill:#f1f5f9,stroke:#94a3b8,color:#111
  classDef new fill:#ede9fe,stroke:#7c3aed,color:#111
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#111
  class s0,s1 rec
  class s2 new
  class s3 stop
```

<sub>The checkout conversation replayed with an over-eager classifier. Steps 0 and 1 come from the trace, including the person's answer. The new model reads "make it 2" as a confirmation, so the run would now place an order; the replay stops there instead.</sub>

3. **Replays don't repeat side effects unless you say so.** `effect: "write"` is part of the node, not a convention. Replays, and resumed replays, refuse to run a write node live unless you override it or pass `allowWrites: true`. A write that was running when the process died becomes `UNKNOWN_OUTCOME`, never a silent retry, and a failed write is retried only when it is declared idempotent.
4. **Conversations become test cases.** Human answers are stored in the trace as inputs. Replaying a human-in-the-loop run needs no human: each `ctx.interrupt` gets its recorded answer as long as the step sees the recorded state. (LangGraph fires interrupts again on replay.)
5. **Models choose, code routes.** Routers are synchronous functions of the state; an async router is rejected at run time. A model can only write a schema-checked value into state, such as one of four commands, and the edge reads it. A router cannot await a model call, so model decisions happen in nodes, where the trace records them.

## Where it sits

|                 | Pi                              | LangGraph                                 | taugraph                                      |
| --------------- | ------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Kernel          | single-agent loop (LLM ↔ tools) | stateful graph with channels and reducers | graph scheduler + typed state                 |
| Orchestration   | extension                       | core                                      | core                                          |
| State           | message transcript              | channels, checkpoint per step             | one schema-checked, frozen JSON object        |
| Pause for input | the conversation itself         | `interrupt()` + a checkpointer            | `ctx.interrupt()`, resumed from the trace     |
| Log             | append-only session             | checkpoints in a persistence backend      | append-only event stream with state snapshots |
| LLM / tools     | built in                        | bring your own, often LangChain           | plugin nodes, none in the kernel              |
| Runtime deps    | provider SDKs                   | LangChain core and friends                | **none**                                      |

## Rules of the kernel

1. The kernel runs graphs, validates state and appends to the trace. It has **no LLM, no tools, no RAG, no memory**.
2. State has a schema ([Standard Schema](https://standardschema.dev): Zod ≥ 3.24, Valibot ≥ 1, ArkType ≥ 2).
3. The trace is append-only. Events are frozen and never edited.
4. A run is a serializable trace. Replay it at any time, with any node or model swapped.
5. No hidden magic. Side effects are recorded as explicit events, and nodes that change the world declare `effect: "write"` so a replay never repeats them.
6. Sync first, async optional. `runSync` never touches a Promise; no async runtime is assumed.
7. Zero runtime dependencies. Works in Node ≥ 22, Bun, Deno and browsers (CI runs Node 22 and 24; Bun was checked by hand for 0.4.0, Deno and Chrome for 0.2.0).

These are enforced by tests (`test/architecture.test.ts`), not only by convention.

## Quick start

```ts
import { createGraph, diffTraces, toJSONL } from "taugraph";
import { CodeNode, LLMNode, type LLMModel, textOf } from "taugraph/nodes";
import { z } from "zod";

const State = z.object({
  question: z.string(),
  raw: z.string().nullable().default(null),
  final: z.string().nullable().default(null),
});

// Any provider fits this contract; taugraph/openai covers OpenAI-compatible endpoints.
const model: LLMModel = {
  id: "mock:echo",
  complete: (req) => ({ content: `echo: ${textOf(req.messages.at(-1)?.content ?? "")}` }),
};

const graph = createGraph(State, {
  start: "fetch",
  nodes: {
    fetch: CodeNode((s) => ({ ...s, raw: `notes about ${s.question}` })),
    answer: LLMNode({
      model,
      prompt: (s) => `Use these notes: ${s.raw}\nQuestion: ${s.question}`,
      update: (s, text) => ({ ...s, final: text }),
    }),
  },
  edges: [{ from: "fetch", to: "answer" }],
  endNodes: ["answer"],
});

const { state, trace } = await graph.run({ question: "What is agent orchestration?" });
const jsonl = toJSONL(trace); // one event per line, ready for a file or an eval harness

// Replay with the answer node mocked. `fetch` reuses its recorded output.
const replay = await graph.replay(trace, {
  overrides: { answer: CodeNode((s) => ({ ...s, final: "mock answer" })) },
});
console.log(diffTraces(trace, replay.trace)); // { equal: false, firstDivergence: { step: 1, ... }, changedKeys: ["final"] }
```

State, input and node ids are all inferred from the schema and `nodes`. A typo in an edge, or a node that returns the wrong shape, is a compile error.

With TypeScript older than 5.9, a node that returns a literal value (for example `outcome: "ordered"` for a union field) is not inferred; write `CodeNode<State>(...)` there. TypeScript 5.9 and 7 need no annotation.

## Concepts

### State

One object, described by a schema. Every node receives the current state **deeply frozen** and returns a **new** state. The kernel validates every output against the schema and fails with an explicit error:

```ts
error.code; // "INVALID_STATE"
error.message; // Node "answer" (step 1) returned invalid state:
//   - final: Invalid input: expected string, received number
```

State must be plain JSON (no `Date`, `Map`, class instances). That is what makes a trace loaded from disk replay exactly like one held in memory.

### Node

```ts
type Node<S> = (state: S, ctx: RunContext) => S | Promise<S>;

interface RunContext {
  meta: { runId: string; nodeId: string; step: number; attempt: number; recovered: boolean; idempotencyKey: string };
  signal: AbortSignal; // pass it to fetch / model clients
  trace: { append(event: PluginEvent): void }; // record a side effect
  interrupt<T>(request?: unknown): T; // pause the run until resume(trace, value)
}
```

Any function with this signature is a node. The context deliberately contains no models, tools or stores; nodes bring their own dependencies.

### Graph

Start node, plain edges, conditional edges, end nodes. That is all.

```ts
conditionalEdges: [{ from: "search", route: (s) => (s.docs ? "answer" : "rewrite"), targets: ["answer", "rewrite"] }];
```

The graph is checked when it is built: unknown nodes, dead ends, end nodes with outgoing edges and fan-out (two edges leaving one node) are rejected. Routers are pure and synchronous; if routing needs an LLM, do that in a node and route on its result. `maxSteps` (default 100) stops runaway loops.

### Trace

An append-only list of frozen events:

```
run_start → enter → [llm_call | tool_call | ...] → exit → enter → pause → run_end(paused)
          → resume → enter → exit → ... → run_end
```

`enter` carries the input state, `exit` the output state, so the stream doubles as a sequence of snapshots. Nodes add their own events with `ctx.trace.append`. Kernel event types are reserved.

Consecutive snapshots share whatever did not change. In memory this always holds; on disk it holds when you write with `toJSONL`, `createTraceEncoder` or `fileStore`. These write format v2, which stores each snapshot as a patch against the one before, so a trace grows with what changed rather than with the size of the state. That holds for items appended to arrays and for changes to object keys; inserting at the front of a long array or reordering an object's keys still rewrites that array or object.

`run(input, { onEvent })` hands every event to your sink before the run continues. The sink may return a Promise: `run` waits for it after every kernel event, so a `write` step's `enter` is stored before the node runs, and the events a node appends are stored before its step ends. Calls never overlap. If the sink throws or rejects, the run stops with `SINK_FAILED`, so no step runs without being logged. `runSync` takes synchronous sinks only. Full spec: [docs/trace-format.md](./docs/trace-format.md).

### Pause and resume

A node calls `ctx.interrupt(request)` to wait for something from outside: a human approval, a button click, a webhook. The run returns `{ status: "paused", pending: { nodeId, step, request } }`. Store the trace anywhere, exit the process, and later:

```ts
const result = await graph.resume(trace, value); // same runId, appended to the same trace
```

On resume the waiting node runs again from the top and `ctx.interrupt` returns `value`; code before the call runs twice, so keep it free of side effects. The n-th `interrupt` in a node gets the n-th value, and each visit of a looping node gets its own values. **The trace is the checkpoint**: no database or checkpointer is involved. Resume a paused trace once; to reject stale answers (an old button clicked twice), compare `pending.step` with the latest trace you stored.

`resume(trace)` without a value also recovers a trace that ended mid-run, for example after a crash: it continues after the last finished step. If a `write` node was running at that moment, its outcome is unknown, so resume stops with `UNKNOWN_OUTCOME`. Check the outside system, then call `resume(trace, undefined, { allowWrites: true })`; the node sees `ctx.meta.recovered === true`.

### Effects

```ts
CodeNode(placeOrder, { effect: "write" });
```

`write` marks a node whose call changes the outside world. It is recorded on `enter` events, and replay refuses to run it live (`WRITE_BLOCKED`) unless you override it with a mock or pass `allowWrites: true`. This also holds when you resume a replay that paused. Undeclared nodes count as `read`.

### Replay

```ts
graph.replay(trace, { overrides?, mode?: "recorded" | "live", allowWrites? })
```

The run restarts from the recorded input under a new runId. In `recorded` mode (default), a node that is not overridden and sees exactly the recorded input state reuses its recorded output, with no side effects. As soon as the state diverges, nodes run live. `live` re-executes everything. Values delivered by `resume` are fed back to `ctx.interrupt` whenever a step sees the recorded state, so a human-in-the-loop conversation replays without anyone answering again. `write` nodes are blocked as described above. Use `diffTraces(a, b)` to find the first diverging step and the changed state keys.

Typical uses: swap a model and compare answers, mock a flaky tool, rerun a failed production trace locally after a fix, build regression evals from recorded traces.

### Errors and retries

Every failure is a `TaugraphError` with a `code` (`INVALID_GRAPH`, `INVALID_STATE`, `INVALID_ROUTE`, `NODE_FAILED`, `MAX_STEPS`, `ABORTED`, `TIMEOUT`, `ASYNC_IN_SYNC_RUN`, `INVALID_TRACE`, `INVALID_EVENT`, `WRITE_BLOCKED`, `UNKNOWN_OUTCOME`, `NOT_RESUMABLE`, `SINK_FAILED`), plus `nodeId`, `step`, schema `issues`, the original `cause`, and the `trace` up to the failure.

```ts
CodeNode(fetchPrices, { retry: { maxAttempts: 4 }, timeoutMs: 10_000 });
```

- **What is retried.** By default `isRetryable(error)` decides. Kernel errors that another attempt cannot fix (`INVALID_STATE`, `ABORTED`, `SINK_FAILED`, ...) are not retried, and neither are HTTP 4xx errors other than 408, 409, 425 and 429, read from a numeric `status` on the error or its `cause` chain. Everything else is retried, including errors it knows nothing about. Pass `retryOn(error)` to decide yourself; it gets the error the node threw.
- **How long it waits.** Exponential backoff: 500 ms, twice as long each time, at most 30 s, minus up to half at random (`backoff: { initialMs, factor, maxMs, jitter }`, or `false` to retry at once). A `retryAfterMs` on the error, which `taugraph/openai` reads from `Retry-After`, makes it wait at least that long. It is not capped by `maxMs`; pass `retryOn` or abort the run if a server may ask for very long waits (in `runSync` the thread blocks for the whole wait). `run` waits with a timer and stops at once when aborted; `runSync` blocks the thread, and fails with `ASYNC_IN_SYNC_RUN` where it may not (a browser's main thread). Each failed attempt is an `error` event with `willRetry`, and `delayMs` when it will retry.
- **Write nodes.** A `write` node with `retry` must set `idempotent: true`, or `defineNode` throws: a repeated order is a second order. `ctx.meta.idempotencyKey` (`<runId>:<step>`) is the same for every attempt of a step and after a crash; pass it to the API (as an `Idempotency-Key` header, say) so repeats are safe.
- **Timeouts.** `timeoutMs` on a node fails the attempt with `TIMEOUT` when its Promise has not settled in time, and aborts `ctx.signal`. `TIMEOUT` is retried like other errors. Synchronous code cannot be interrupted. When a `write` node stops on a timeout or an abort, its `error` event says `outcome: "unknown"`: the effect may or may not have happened.

## Plugin nodes (`taugraph/nodes`)

| Node        | What it does                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `CodeNode`  | Deterministic state transformation.                                                                             |
| `LLMNode`   | Calls an `LLMModel` (tools included), records an `llm_call` event, optionally parses JSON output with a schema. |
| `HumanNode` | Pauses for an answer via `ctx.interrupt`, validates it with a schema, asks again if invalid.                    |

`LLMNode` only defines the call contract (`{ id, complete(request, { signal }) }`); bring any other provider through a small adapter. [`taugraph/openai`](#openai-compatible-models-taugraphopenai) covers OpenAI-compatible endpoints. Messages can carry images; see [Images](#images).

Writing your own node type takes one call to `defineNode`:

```ts
import { defineNode } from "taugraph";

interface Tool {
  name: string;
  run(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export const ToolNode = <S>(tool: Tool, apply: (s: S, out: unknown) => S) =>
  defineNode<S>(
    async (state, ctx) => {
      const output = await tool.run(state, ctx.signal);
      ctx.trace.append({ type: "tool_call", input: { tool: tool.name }, output });
      return apply(state, output);
    },
    { kind: "tool" },
  );
```

## Agent (`taugraph/agent`)

`createAgent` turns the model ↔ tools loop into an ordinary taugraph graph. Each model call and each tool call is a step of its own, so everything above applies to every single call: it is in the trace, replay reuses it, a replay never repeats a write, a crash mid-write stops with `UNKNOWN_OUTCOME`, and a call can wait for a human.

```ts
import { createAgent, tool } from "taugraph/agent";
import { z } from "zod";

const weather = tool({
  name: "weather",
  description: "Today's weather for a city",
  input: z.object({ city: z.string() }), // validates arguments and becomes the JSON Schema the model sees
  run: ({ city }) => `${city}: cloudy, -2~5°C`,
});

const addTodo = tool({
  name: "add_todo",
  effect: "write", // runs in a write step
  input: z.object({ text: z.string() }),
  run: ({ text }) => `added "${text}"`,
});

const agent = createAgent({
  model, // any LLMModel whose adapter supports tools
  tools: [weather, addTodo],
  system: "You help with the day.",
  approve: (call, t) => (t.effect === "write" ? "ask" : "run"),
});

const result = await agent.run({ messages: [{ role: "user", content: "What should I wear today?" }] });
// paused on add_todo: result.pending.request is { type: "tool_approval", call, effect: "write" }
const done = await agent.resume(result.trace, true); // or false, or { approved: false, reason }
console.log(done.state.final);
```

```
think ──a read call──▶ act ───────┐
  ▲   ──a write call─▶ act_write ─┤  more calls: act / act_write
  └───────────────────────────────┘  none left: think
think ──no calls, or maxRounds──▶ finish
```

- The state is `{ messages, pending, rounds, final, stop }`, validated by a built-in Standard Schema (no validator needed).
- Tool definitions follow MCP (`name`, `description`, `inputSchema` as JSON Schema). A tool's JSON Schema comes from `inputSchema` if given, else from `input` through [Standard JSON Schema](https://standardschema.dev/json-schema) (Zod 4, Valibot, ArkType).
- Invalid arguments, unknown tools, unreadable arguments and thrown errors go back to the model as error results; the loop continues.
- `maxRounds` (default 8) bounds model calls; at most 32 calls run per reply. Each tool run is a `tool_call` event.
- `timeoutMs` on `createAgent` limits each model call (`TIMEOUT`, which `retry` retries). `timeoutMs` on a tool limits each run of it: a read tool that takes longer answers the model with an error and the loop goes on; a write tool fails the run with `TIMEOUT`, because its effect is unknown.
- Models: the call contract gained optional `tools`, `toolChoice` and `toolCalls`, and `tool` messages. An adapter that maps `role` itself needs a `tool` branch. The [OpenAI-compatible adapter](#openai-compatible-models-taugraphopenai) translates them. `pnpm example:agent` runs the whole thing. Tool results may carry images (see [Images](#images)).

## OpenAI-compatible models (`taugraph/openai`)

`openAICompatible` turns any OpenAI-compatible `/chat/completions` endpoint into an `LLMModel`: OpenAI, DeepSeek, Qwen, Kimi, Ollama, vLLM, LM Studio and others. It translates tool calls, images and reasoning, uses the global `fetch`, and adds no dependencies. The kernel and `taugraph/nodes` contain no provider code; this entry is an optional plugin, like `taugraph/agent`.

```ts
import { openAICompatible } from "taugraph/openai";

const model = openAICompatible({
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: process.env.DEEPSEEK_API_KEY,
});
```

| Option            | What it does                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `baseURL`         | The part before `/chat/completions`, e.g. `https://api.openai.com/v1` or `http://localhost:11434/v1` |
| `model`           | The model name the endpoint expects                                                                  |
| `apiKey`          | Optional; sent as a Bearer token                                                                     |
| `resolveImage`    | Reads image references such as `media:abc` when a request is sent; see [Images](#images)             |
| `reasoningParams` | Maps a reasoning level to request parameters; see [Reasoning models](#reasoning-models)              |
| `sendReasoning`   | `false` stops sending the model's own reasoning back, for endpoints that refuse the field            |
| `tokenLimit`      | `"max_completion_tokens"` for OpenAI's reasoning models; default `"max_tokens"`                      |
| `fetch`           | Used instead of the global `fetch`, e.g. for a proxy or tests                                        |

The model's `id` is `openai-compatible:<model>`. It is recorded in every `llm_call` event, and assistant messages with that `model` count as this model's own when reasoning is sent back.

A response outside 2xx throws `HTTPError` with `status`, `url` and `retryAfterMs` (read from `Retry-After`), so an `LLMNode` with `retry` retries 408, 409, 425, 429 and 5xx, waiting at least as long as `Retry-After` asks, and gives up on other 4xx at once.

Any other provider fits the same contract through a small adapter of your own: an `LLMModel` is `{ id, complete(request, { signal }) }`.

## Images

User messages and tool results can carry images. Their `content` is then an array of parts, in order; `system` and `assistant` messages stay text.

```ts
const question: ChatMessage = {
  role: "user",
  content: [
    { type: "text", text: "Which of these is the receipt?" },
    { type: "image", data: base64, mimeType: "image/png" }, // the bytes, in base64
    { type: "image", url: "media:9f2c" }, // or a reference the adapter reads when it calls the model
  ],
};
```

- A URL may be `https:`, `data:` or a reference of your own. The trace records the state at every step and every request. `toJSONL` and `fileStore` write a base64 image that a tool returns three times (the `tool_call` output, the `exit` patch that adds it to the state, and the next request) and one that the user sends twice (when it enters the state and in the first request that sends it), but a sink of your own that writes `JSON.stringify(event)` for each event repeats it at every step. A reference costs a few bytes either way. In `recorded` replay, a step that sees its recorded state reuses its recorded result, so a reference only has to resolve for steps that run again.
- Tools return images the same way: `run: () => ({ content: [{ type: "text", text: "the page" }, { type: "image", url: "media:shot1" }] })`.
- An MCP tool result can be returned as it is when it holds text and image blocks; other blocks, such as audio or resources, fail the run, so convert them first.
- For adapters, `resolveImages(messages, resolve)` turns `data:` URLs into base64 and every other URL into what `resolve` returns. An adapter that sends text only uses `textOf(m.content)`, which throws on images unless given `{ imagePlaceholder }`, so a model never answers about a picture it did not get.
- The [OpenAI-compatible adapter](#openai-compatible-models-taugraphopenai) sends http(s) and `data:` URLs as they are and reads the rest with `resolveImage`. OpenAI's tool messages take text only, so it moves tool images into a user message right after them.

```ts
const model = openAICompatible({
  baseURL: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  resolveImage: async (url) => {
    const id = /^media:([\w-]+)$/.exec(url)?.[1];
    if (!id) throw new Error(`Unknown image reference: ${url}`);
    return { type: "image", mimeType: "image/png", data: (await readFile(`media/${id}.png`)).toString("base64") };
  },
});
```

## Reasoning models

`reasoning` on a request says how much the model should think first: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"`. Leave it out and the adapter sends nothing, so the model uses its default. Adapters map the level to the provider's setting; one that knows the model's levels rounds to the nearest, and one for a provider that takes a token budget turns levels into budgets.

```ts
const agent = createAgent({ model, tools, reasoning: "high" }); // every model call in the run
```

- Replies carry what the model thought in `response.reasoning` (`{ text, signature?, redacted? }[]`) and its token count in `usage.reasoningTokens`, which is part of `outputTokens`. Both are in the `llm_call` event.
- Some providers refuse the next request of a tool loop unless the model's earlier thinking comes back unchanged: DeepSeek V4 (`reasoning_content`), Claude (signed thinking blocks) and Gemini 3 (a `thoughtSignature` on the first tool call of a step, kept in `ToolCall.signature`). The agent stores reasoning and signatures in the assistant messages it writes, so the next round sends them.
- A signature is only valid for the model that wrote it, so every assistant message the agent writes records `model`, the `LLMModel.id`. Adapters send reasoning and signatures back only when `m.model` is their own `id`, so a replay that swaps the model never sends one model's signatures to another.
- Assistant messages record `model`, so a replay that swaps the model diverges at the first model call that runs again, even if the new model answers the same; later steps run live and write steps stop with `WRITE_BLOCKED`.
- The [OpenAI-compatible adapter](#openai-compatible-models-taugraphopenai) sends the level as `reasoning_effort` as it is (`"off"` as `"none"`), reads `reasoning_content` or `reasoning` from replies, and sends its own `reasoning_content` back; set `sendReasoning: false` for endpoints that refuse that field, such as Groq and Cerebras. When a provider has its own switch, or refuses a level, map levels in `reasoningParams`:

```ts
// DeepSeek V4: a thinking switch; it maps the levels itself
const deepseek = (level: ReasoningLevel) =>
  level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: level };
// Qwen on vLLM or SGLang
const qwen = (level: ReasoningLevel) => ({ chat_template_kwargs: { enable_thinking: level !== "off" } });

const model = openAICompatible({
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  reasoningParams: deepseek,
});
```

## Saving to files (`taugraph/file`)

`fileStore(dir)` keeps one JSONL file per run and appends every event before the run takes its next step. After a crash, find the runs that did not finish and continue them:

```ts
import { fileStore } from "taugraph/file";

const store = fileStore("./runs");
await graph.run(input, { onEvent: store.sink });

// after a restart
for (const run of store.list()) {
  if (run.status !== "interrupted") continue;
  try {
    await graph.resume(store.load(run.runId)!, undefined, { onEvent: store.sink });
  } catch (error) {
    // UNKNOWN_OUTCOME: a write step was running. Check the outside system, then resume with { allowWrites: true }.
    console.error(run.runId, error);
  }
}
```

- Use one directory per graph: the recovery loop above resumes every interrupted run in the directory with one graph.
- `list()` reports `running` (a live process holds the run's lock), `interrupted` (no end and nobody writing it), `paused`, `completed` or `failed`. It skips files it cannot read as a trace; `load` throws `INVALID_TRACE` for them.
- A crash can leave the last line half-written. `load` ignores it, and the store cuts it off before it continues the run. For a write step that was running, `resume` throws `UNKNOWN_OUTCOME` instead of running it again.
- `durability` decides when to `fsync`: `"writes"` (default) before a write step runs, at a pause and at the end; `"every"` after each event; `"none"` never. With `"writes"`, a power cut can lose read steps, which are safe to run again, but cannot make a write step run twice. It can also lose a new run entirely if the run has not yet reached a write step, a pause or its end.
- Each run has a lock file while it is written, so two processes cannot append to the same run. A lock left by a process that died is taken over.
- The lock works between processes on one machine (one pid namespace). Containers that share a volume cannot see each other's processes, so do not let two of them write the same directory.
- Two stores in one thread cannot write the same run; on Node this also holds across worker threads. Bun and Deno give the lock no way to tell worker threads apart, so write a directory from one thread there. A worker stopped with `worker.terminate()` keeps its locks until the process exits.
- A process that dies at the wrong moment can leave `<runId>.lock.takeover`. The error names the file; remove it if no process is writing the run. On a file system without hard links, such a process or a power cut can also leave an empty `<runId>.lock`: `list()` reports the run as `running` and the store refuses the lock until it is 10 seconds old, then takes it over. A crash can also leave `<runId>.lock.<pid>.<random>` temp files, which are harmless and safe to delete.
- It uses `node:fs` (Node, Bun, Deno) and adds no dependencies. Run ids may contain ASCII letters, digits, `_`, `-` and `.` (not first), up to 128 characters.

## Integrations

| Package                                                     | Use it to                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [taugraph-mcp](https://github.com/wangcao-hub/taugraph-mcp) | Serve flows as MCP tools to any MCP client: Claude, Cursor, Kiro, AgentScope Java and others. `npx -y taugraph-mcp ./flows` |
| [taugraph-pi](https://github.com/wangcao-hub/taugraph-pi)   | Run flows as tools inside the [Pi](https://pi.dev) coding agent. `pi install npm:taugraph-pi`                               |

Both keep the trace format, so runs recorded through them can be replayed and diffed with this package.

## Not in the kernel, on purpose

Persistence backends, distributed workers, parallel nodes, nested subgraphs, built-in tools, memory, vector stores, visual editors, event routing, triggers and schedulers. Parallel calls inside one step are fine: use `Promise.all` in a node. Some will arrive as separate plugin packages; none will enter the kernel. `taugraph/file` is an optional entry point outside the kernel, like `taugraph/agent`.

## Roadmap

- `taugraph/tools`: shell and filesystem tool nodes
- `taugraph/subagent`: delegate to external agents (ACP, Pi instances)
- `taugraph/compact`: trace and state compaction
- `taugraph/tui`: terminal trace viewer

## Development

```
pnpm install
pnpm check          # typecheck + lint + test
pnpm build
pnpm example:rag       # retrieval -> answer with a retry loop, JSONL trace, replay
pnpm example:checkout  # human in the loop: pause/resume, LLM picks a command, replay never re-orders
```

Set `TAUGRAPH_BASE_URL` and `TAUGRAPH_MODEL` (and `TAUGRAPH_API_KEY` if needed) to run the examples against a real OpenAI-compatible endpoint, e.g. Ollama at `http://localhost:11434/v1`.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
