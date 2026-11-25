# Design notes

Why the kernel looks the way it does. Each section names the alternative that was rejected.

## Four modules, nothing else

| Module  | File                                   | Responsibility                                            |
| ------- | -------------------------------------- | --------------------------------------------------------- |
| Graph   | `src/core/graph.ts`                    | Declaration and static validation                         |
| Runtime | `src/core/engine.ts`                   | Step loop, routing, retries, cancellation, pause / resume |
| State   | `src/core/util.ts` + the user's schema | Validation, JSON-only, deep freeze                        |
| Trace   | `src/core/trace.ts`                    | Append-only log, JSONL, replay and resume inputs, diff    |

`src/nodes/` holds plugin nodes. They import only the public entry point (`src/index.ts`), exactly as a third-party package would. `test/architecture.test.ts` fails if the kernel imports anything outside `src/core`, or if `package.json` gains a runtime dependency.

## `createGraph(schema, definition)` takes two arguments

With a single object (`createGraph({ schema, nodes })`) TypeScript infers the state type from the schema and from the node factories at the same time, and the factories win with `unknown`. Passing the schema first fixes the state type before the nodes are checked, so `CodeNode((s) => ...)` gets a typed `s` with no annotations. Node ids are inferred from the `nodes` keys and used with `NoInfer` everywhere else, so a typo in `edges` is a compile error instead of a new node id.

## Standard Schema instead of a Zod dependency

The kernel only needs `validate(value) → { value } | { issues }`. Standard Schema is that interface, implemented by Zod, Valibot, ArkType and others, and its types may be copied. The kernel therefore has zero runtime dependencies and users pick their validator.

## State is plain JSON, and frozen

Every state is copied into frozen plain JSON after validation. Rejected: `structuredClone`, which accepts `Date` and `Map`, values that change shape when the trace is written as JSONL. With JSON-only state, replaying a trace from disk behaves exactly like replaying it from memory. Freezing turns accidental in-place mutation into an immediate `TypeError` instead of a corrupted snapshot.

## Sync first: one generator, two drivers

The run loop is a generator that `yield`s every operation that might be async (node calls, schema validation). `runSync` feeds values straight back and rejects Promises with `ASYNC_IN_SYNC_RUN`; `run` awaits them. Rejected: an `async` loop with a separate sync copy (two implementations drift) and an always-async loop (contradicts "sync first", forces Promises on deterministic graphs and tests).

## Routers are pure and synchronous

A router that calls an LLM is a side effect hidden in an edge, invisible in the trace. Routing work belongs in a node that writes its decision into state; the router just reads it.

## No fan-out

One outgoing edge per node keeps the state model trivial: there is never more than one state, so no reducers, no merge conflicts and no ordering questions in the trace. Parallelism can come later as a plugin node that runs sub-graphs and merges explicitly.

## Replay reuses recorded outputs by default

Re-running every node on replay would call real models and tools again, which costs money and is not deterministic. In `recorded` mode a node's recorded output is reused only while the node sees exactly the recorded input, so the first changed state makes everything downstream run live. This is what makes "swap one node and compare" cheap and trustworthy.

## Replay never repeats a write

Recorded mode alone is not enough: once the state diverges, downstream nodes run live, and if one of them places an order, every replay places another. Nodes therefore declare `effect: "write"`, and a replay refuses to run such a node live unless it is overridden or the caller passes `allowWrites: true`. There are two levels because the kernel only needs to know one thing: is it safe to run this again? Finer business distinctions (reversible or not, needs confirmation or not) belong in the graph.

## The trace is the checkpoint

Pausing for a human usually means a checkpointer: a storage backend that snapshots state so the run can continue later. taugraph already records the state at every step, so `resume(trace, value)` rebuilds the position from the trace and continues it under the same runId. No storage interface enters the kernel; users keep the trace wherever they like.

`ctx.interrupt` re-runs the node on resume instead of continuing it from the middle, because a JavaScript function cannot be suspended across processes. Values are matched by call order within the step, which lets a node ask several questions and lets a validating `HumanNode` ask again. The kernel detects a pause through a flag rather than by the thrown signal reaching it, so a careless `try/catch` in a node cannot turn a pause into a normal return.

The same function recovers a trace that ended mid-run, for example after a crash. A step that was running is started again, except a `write` step: its effect may already have happened, so the kernel stops with `UNKNOWN_OUTCOME` and leaves the check to the caller. Failed and completed traces are not resumable; `replay` covers rerunning them.

## The log is written ahead

`onEvent` is called before the run continues, and a sink failure stops the run with `SINK_FAILED`. Otherwise a step could run, perhaps a write, after the event that announced it was lost, and the stored trace could no longer be resumed correctly. The sink is synchronous to keep `runSync` possible; buffer in the sink if your storage is asynchronous and you accept the weaker guarantee.

## Traces grow with what changed

Every step records its full input and output state, which makes replay and resume simple. Stored naively, that grows with the square of the run: an agent that appends one message per step stores the whole conversation twice per step, and every model call stores its request again. Two layers keep it linear without changing how traces are read. In memory, `freezeJson` reuses what it froze before, and equal parts of the previous state, so consecutive snapshots share structure. On disk, format v2 writes each snapshot as a JSON Patch against its base, and `fromJSONL` rebuilds full events. Making events themselves hold patches would be smaller still, but every reader of `event.input` would need a helper.

`taugraph/file` locks each run with a file holding the writer's process id, so a crashed process's lock can be told apart from a live one and a restart knows which runs to continue. A process id only means something on one machine, and a restarted container can get its old one back, so a lock with this process's own id counts as live only if it was written after this process started. By default the store fsyncs before a write step runs, at pauses and at the end, but not after read steps: losing a read step to a power cut only means running it again, while losing the record of a started write could repeat it.

## The tool loop is a graph, not a node

`createAgent` could have been one node that loops over model and tool calls internally. Every guarantee would then apply to the whole loop only: replay would reuse or rerun all of it, a single write tool would make the whole loop a write node, and an approval would rerun every call before it. As a graph with one step per model call and one per tool call, the existing rules land on exactly one call each, and write tools get their own `act_write` node so `effect: "write"` stays a static property of a node. Calls from one reply run one after another; running them in parallel waits for parallel nodes.

Tool calls carry parsed arguments, as in MCP and Anthropic, because a trace of JSON strings inside JSON is hard to read and diff; adapters convert OpenAI's string form and report unreadable arguments in `parseError` instead of guessing.

## Content is a string or parts

User messages and tool results carry `string | ContentPart[]`, the shape OpenAI and Anthropic use, so text and images can alternate. Two additive shapes were considered. An `images` field next to a string `content` keeps old adapters compiling, but those adapters would then drop images without a word, and the order of text and images is lost. A `parts` field next to `content` keeps the order, but stores the text twice and leaves adapters to guess which one wins. The union breaks adapters at compile time instead, which is where the fix is one call: `textOf(m.content)`, which throws on images unless told what to write instead. `system` and `assistant` stay strings, because no provider takes images there in a way worth the extra cases.

Images can be references (`url: "media:abc"`) that the adapter reads at call time with `resolveImages`. The trace stores the state at every step and every request, and the conversation is part of both, so a base64 image is stored again and again, while a reference is stored as a few bytes. In `recorded` replay, a step that sees its recorded state reuses its recorded result, so a reference only has to resolve for steps that run again.

## Reasoning: levels, and signatures per model

`reasoning` is one of seven levels, not a token budget. OpenAI-style providers take levels and refuse budgets, older Claude models and Gemini 2.5 take budgets, and a level carries over between them when an adapter maps it, while a budget does not. A request then reads the same in the trace whichever model serves it; a precise budget is still possible through `extra`.

Thinking comes back as readable text with an optional opaque `signature`, not as provider data, so traces stay readable. Signatures are bound to the model that made them, and replay can swap the model, so every assistant message the agent writes records `model` and adapters send signatures only to that model.

## `taugraph/openai` is a plugin, not an example

The OpenAI-compatible adapter started in `examples/` so the kernel would stay free of provider code. It was then copied into taugraph-mcp and into an app built on taugraph: three copies of the same tool-call, image and reasoning translation to keep in step. It needs nothing but `fetch`, so it now ships as an optional entry point next to `taugraph/agent`. The kernel and `taugraph/nodes` still contain no provider code, and an app that talks to another provider never loads it.

## `LLMNode` takes a model contract, not a callback

`LLMNode(async (s) => await client.chat(...))` would hide the call from the trace. `LLMNode({ model, prompt, update })` lets the node record the exact request and response as an `llm_call` event, and lets replay swap `model` without touching prompt logic. The node stays synchronous when the model is, so mock models work in `runSync`.

## Errors carry the trace

A failed run throws a `TaugraphError` with the transcript attached (`error.trace`), ending in a `run_end` event with `status: "failed"`. The partial trace is the most useful debugging artifact, so it is never lost, and it can be replayed after a fix.
