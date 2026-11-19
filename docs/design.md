# Design notes

Why the kernel looks the way it does. Each section names the alternative that was rejected.

## Four modules, nothing else

| Module  | File                                   | Responsibility                              |
| ------- | -------------------------------------- | ------------------------------------------- |
| Graph   | `src/core/graph.ts`                    | Declaration and static validation           |
| Runtime | `src/core/engine.ts`                   | Step loop, routing, retries, cancellation   |
| State   | `src/core/util.ts` + the user's schema | Validation, JSON-only, deep freeze          |
| Trace   | `src/core/trace.ts`                    | Append-only log, JSONL, replay inputs, diff |

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

## No fan-out in v0.1

One outgoing edge per node keeps the state model trivial: there is never more than one state, so no reducers, no merge conflicts and no ordering questions in the trace. Parallelism can come later as a plugin node that runs sub-graphs and merges explicitly.

## Replay reuses recorded outputs by default

Re-running every node on replay would call real models and tools again, which costs money and is not deterministic. In `recorded` mode a node's recorded output is reused only while the node sees exactly the recorded input, so the first changed state makes everything downstream run live. This is what makes "swap one node and compare" cheap and trustworthy.

## `LLMNode` takes a model contract, not a callback

`LLMNode(async (s) => await client.chat(...))` would hide the call from the trace. `LLMNode({ model, prompt, update })` lets the node record the exact request and response as an `llm_call` event, and lets replay swap `model` without touching prompt logic. The node stays synchronous when the model is, so mock models work in `runSync`.

## Errors carry the trace

A failed run throws a `TaugraphError` with the transcript attached (`error.trace`), ending in a `run_end` event with `status: "failed"`. The partial trace is the most useful debugging artifact, so it is never lost, and it can be replayed after a fix.
