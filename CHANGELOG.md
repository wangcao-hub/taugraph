# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/wangcao-hub/taugraph/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wangcao-hub/taugraph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wangcao-hub/taugraph/releases/tag/v0.1.0
