# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-11-25

Traces grow linearly instead of with the square of the run, in memory and in JSONL (format version 2), and `taugraph/file` stores them as crash-safe files that a restarted process can continue.

### Changed

- **Breaking:** trace format version 2: `toJSONL` writes each `input` / `output` as a JSON Patch against a base value when the patch is under 4096 characters or not longer than the value, so traces grow with what changed instead of with the square of the run. That holds for items appended to arrays and for changes to object keys; inserting at the front of a long array or reordering an object's keys still rewrites that array or object. `fromJSONL`, `resume` and `replay` read versions 1 and 2. In memory, events keep their shape, and consecutive states share the parts that did not change. taugraph 0.3 and older reject version 2 files. Code that parses `toJSONL` or `fileStore` lines itself now meets `inputPatch` / `outputPatch` instead of `input` / `output`, so read them with `fromJSONL` from 0.4. Custom sinks now see `run_start.meta.version` 2, which taugraph 0.3 rejects, so even files they write in full no longer load there.
- `toJSONL([])` returns `""` (was `"\n"`).
- `fromJSONL` returns frozen `input` / `output` values; events and their `meta` stay plain objects.
- `freezeJson` (state and payload checks) now rejects arrays with holes (`INVALID_STATE`; before, holes became `null` on disk), and a `__proto__` key in state is kept as an ordinary key.

### Added

- `taugraph/file`: `fileStore(dir, { durability })` stores one JSONL file per run, appended before each step continues; `load` ignores a half-written last line, and continuing a run cuts it off; a lock file per run keeps two processes on one machine from writing the same run; `list()` reports `running`, `interrupted`, `paused`, `completed` or `failed`. `durability` is `"writes"` (default: fsync before write steps, at pauses and at the end), `"every"` or `"none"`.
- `runStatus(trace)`, `createTraceEncoder(prefix)`, `toJSONL(trace, { from })` and `fromJSONL(text, { tornTail: "drop" })`.

## [0.3.0] - 2026-11-25

Tool calling, images and reasoning models in the model contract, plus two plugin entry points: `taugraph/agent` (the model ↔ tools loop as a graph) and `taugraph/openai` (an adapter for any OpenAI-compatible endpoint).

### Changed

- **Breaking:** the `content` of `user` and `tool` messages is `string | ContentPart[]`, so they can carry images. Code that builds messages is unaffected; code that reads `content` as a string no longer compiles. An adapter that sends text only replaces `m.content` with `textOf(m.content)`, which throws on images unless given `{ imagePlaceholder }`. Template strings, `+` and `String()` still compile but turn parts into `[object Object]`, and JavaScript adapters get no compile error, so search for reads of `content` too.
- Types: `ChatMessage` is now a union by `role` and includes `role: "tool"`. Code that only reads `role` and `content` is unaffected, and nothing changes at run time for code that sends no tool messages. An adapter that maps `role` into a provider SDK's message type, or switches over `role` exhaustively, needs a `tool` branch; TypeScript points to the line.

### Added

- Tool calling in the model contract: optional `tools` and `toolChoice` on `LLMRequest`, `toolCalls` on `LLMResponse`, `tool` messages and assistant `toolCalls` in `ChatMessage`. Tool definitions follow MCP (`name`, `description`, `inputSchema`); arguments are parsed JSON.
- `taugraph/agent`: `createAgent` runs the model ↔ tools loop as a graph with one step per model call and one per tool call, so tracing, replay, write protection, crash recovery and approvals (`approve` → `ctx.interrupt`) apply to each call. `tool()` takes a Standard Schema for arguments and derives the JSON Schema through Standard JSON Schema. Bounded by `maxRounds` (default 8) and 32 calls per reply; calls beyond 32 get error answers after the results of the calls that ran. For adapter authors: assistant messages written by the agent always carry `model`, may carry `reasoning`, and tool calls may carry `signature`; strict endpoints such as OpenAI's refuse these fields, so build the provider's message from `role` and `content` (and tool fields) instead of forwarding messages as they are.
- `taugraph/openai`: the OpenAI-compatible adapter, formerly an example, as a plugin entry point. `openAICompatible({ baseURL, model, apiKey?, resolveImage?, reasoningParams?, sendReasoning?, fetch? })` adds no dependencies and uses the global `fetch` unless given one. It translates tools, tool calls and tool results (`pnpm example:agent`); missing call ids become `call_<round>_<index>`, and error results that do not already start with `Error` get an `Error: ` prefix because OpenAI's tool messages have no error flag. It sends images, reads image references with `resolveImage`, and moves images from tool results into a user message after the tool messages. It sends `reasoning_effort` or your `reasoningParams`, reads `reasoning_content` and `reasoning`, and sends the model's own reasoning back unless `sendReasoning: false`. `fetch` replaces the global one, e.g. for a proxy, retries or tests.
- Images in messages: `TextPart`, `ImagePart` (base64 `data` + `mimeType`, or a `url` that may be a reference of your own) and `ContentPart` in `taugraph/nodes`. `resolveImages(messages, resolve)` reads references when a request is sent, so traces can keep a few bytes per image; `textOf(content)` gives the text for text-only adapters.
- Agent tools can return text and images (`{ content: ContentPart[] }`); the state schema checks parts and points at the bad one.
- Reasoning models: `reasoning` on `LLMRequest` (seven levels, `"off"` to `"max"`), what the model thought in `LLMResponse.reasoning` and `usage.reasoningTokens`, `ToolCall.signature`, and `reasoning` and `model` on assistant messages, so a tool loop can send a model's own thinking back as DeepSeek V4, Claude and Gemini 3 require. `createAgent({ reasoning })` sets the level for every call and records which model wrote each message.

## [0.2.0] - 2026-11-19

First release on npm.

### Added

- Pause and resume: `ctx.interrupt(request)` pauses a run; `graph.resume(trace, value)` / `resumeSync` continues it under the same runId, appending to the same trace. Runs now return `status: "completed" | "paused"`, and paused runs carry `pending: { nodeId, step, request }`.
- Crash recovery: `resume(trace)` continues a trace that ended without `run_end`. An unfinished `write` step fails with `UNKNOWN_OUTCOME` unless `allowWrites: true`; restarted steps see `ctx.meta.recovered`.
- Effects: nodes can declare `effect: "read" | "write"` (`defineNode`, `CodeNode`). Replay blocks live `write` nodes with `WRITE_BLOCKED` unless overridden or `allowWrites: true`, including when a paused replay is resumed.
- Replay feeds values delivered by `resume` back to `ctx.interrupt` when a step sees its recorded state, in both modes.
- `HumanNode` plugin: pause for an answer, validate it with a schema, ask again with the error.
- Kernel events `pause` and `resume`; `run_end.meta.status` can be `paused`. Error codes `WRITE_BLOCKED`, `UNKNOWN_OUTCOME`, `NOT_RESUMABLE`, `SINK_FAILED`.
- Example `examples/checkout.ts`: the model only picks one of a fixed set of commands, and code does the rest.

### Changed

- `onEvent` failures stop the run with `SINK_FAILED` instead of being rethrown asynchronously while the run continued.
- `RunResult` is now a union of `CompletedRun` and `PausedRun`; check `status` before reading `pending`.
- Removed the conventional `human_pause` plugin event type; pausing is now the kernel's `pause` event.

## [0.1.0] - 2026-11-19

GitHub only, not published to npm.

### Added

- Kernel: `createGraph` with static validation, sequential and conditional edges, end nodes, `maxSteps`.
- Runtime: `run` (async) and `runSync` sharing one generator-based loop; per-node retry policy; cancellation via `AbortSignal`.
- State: Standard Schema validation of input and every node output; JSON-only, deeply frozen state.
- Trace: append-only event log (format version 1), `onEvent` streaming, `toJSONL` / `fromJSONL`, `diffTraces`.
- Replay: `graph.replay` with node overrides and `recorded` / `live` modes.
- Plugin nodes (`taugraph/nodes`): `CodeNode`, `LLMNode` with a provider-agnostic `LLMModel` contract and structured output.
- Examples: quick start, retrieval with retry loop, OpenAI-compatible adapter.

[Unreleased]: https://github.com/wangcao-hub/taugraph/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/wangcao-hub/taugraph/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/wangcao-hub/taugraph/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/wangcao-hub/taugraph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wangcao-hub/taugraph/releases/tag/v0.1.0
