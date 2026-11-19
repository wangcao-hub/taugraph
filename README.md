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

## Where it sits

|               | Pi                              | LangGraph                                 | taugraph                                      |
| ------------- | ------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Kernel        | single-agent loop (LLM ↔ tools) | stateful graph with channels and reducers | graph scheduler + typed state                 |
| Orchestration | extension                       | core                                      | core                                          |
| State         | message transcript              | channels, checkpoint per step             | one schema-checked, frozen JSON object        |
| Log           | append-only session             | checkpoints in a persistence backend      | append-only event stream with state snapshots |
| LLM / tools   | built in                        | bring your own, often LangChain           | plugin nodes, none in the kernel              |
| Runtime deps  | provider SDKs                   | LangChain core and friends                | **none**                                      |

## Rules of the kernel

1. The kernel runs graphs, validates state and appends to the trace. It has **no LLM, no tools, no RAG, no memory**.
2. State has a schema ([Standard Schema](https://standardschema.dev): Zod ≥ 3.24, Valibot ≥ 1, ArkType ≥ 2).
3. The trace is append-only. Events are frozen and never edited.
4. A run is a serializable trace. Replay it at any time, with any node or model swapped.
5. No hidden magic. Side effects are recorded as explicit events, and nodes that change the world declare `effect: "write"` so a replay never repeats them.
6. Sync first, async optional. `runSync` never touches a Promise; no async runtime is assumed.
7. Zero runtime dependencies. Works in Node ≥ 22, Bun, Deno and browsers.

These are enforced by tests (`test/architecture.test.ts`), not only by convention.

## Quick start

```ts
import { createGraph, diffTraces, toJSONL } from "taugraph";
import { CodeNode, LLMNode, type LLMModel } from "taugraph/nodes";
import { z } from "zod";

const State = z.object({
  question: z.string(),
  raw: z.string().nullable().default(null),
  final: z.string().nullable().default(null),
});

// Any provider fits this contract. See examples/adapters/openai-compatible.ts.
const model: LLMModel = { id: "mock:echo", complete: (req) => ({ content: `echo: ${req.messages.at(-1)?.content}` }) };

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
  meta: { runId: string; nodeId: string; step: number; attempt: number; recovered: boolean };
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

`run(input, { onEvent })` hands every event to your sink before the run continues. If the sink throws, the run stops with `SINK_FAILED`, so no step runs without being logged. Full spec: [docs/trace-format.md](./docs/trace-format.md).

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

Every failure is a `TaugraphError` with a `code` (`INVALID_GRAPH`, `INVALID_STATE`, `INVALID_ROUTE`, `NODE_FAILED`, `MAX_STEPS`, `ABORTED`, `ASYNC_IN_SYNC_RUN`, `INVALID_TRACE`, `INVALID_EVENT`, `WRITE_BLOCKED`, `UNKNOWN_OUTCOME`, `NOT_RESUMABLE`, `SINK_FAILED`), plus `nodeId`, `step`, schema `issues`, the original `cause`, and the `trace` up to the failure. Nodes can opt into retries: `CodeNode(fn, { retry: { maxAttempts: 3 } })`. Each failed attempt is an `error` event.

## Plugin nodes (`taugraph/nodes`)

| Node        | What it does                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `CodeNode`  | Deterministic state transformation.                                                            |
| `LLMNode`   | Calls an `LLMModel`, records an `llm_call` event, optionally parses JSON output with a schema. |
| `HumanNode` | Pauses for an answer via `ctx.interrupt`, validates it with a schema, asks again if invalid.   |

`LLMNode` only defines the call contract (`{ id, complete(request, { signal }) }`); bring OpenAI, Ollama or anything else through a small adapter. A 40-line OpenAI-compatible one is in [`examples/adapters`](./examples/adapters/openai-compatible.ts).

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

## Not in the kernel, on purpose

Persistence backends, distributed workers, parallel nodes, nested subgraphs, built-in tools, memory, vector stores, visual editors, event routing, triggers and schedulers. Parallel calls inside one step are fine: use `Promise.all` in a node. Some will arrive as separate plugin packages; none will enter the kernel.

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
