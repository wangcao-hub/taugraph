# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added

- Kernel: `createGraph` with static validation, sequential and conditional edges, end nodes, `maxSteps`.
- Runtime: `run` (async) and `runSync` sharing one generator-based loop; per-node retry policy; cancellation via `AbortSignal`.
- State: Standard Schema validation of input and every node output; JSON-only, deeply frozen state.
- Trace: append-only event log (format version 1), `onEvent` streaming, `toJSONL` / `fromJSONL`, `diffTraces`.
- Replay: `graph.replay` with node overrides and `recorded` / `live` modes.
- Plugin nodes (`taugraph/nodes`): `CodeNode`, `LLMNode` with a provider-agnostic `LLMModel` contract and structured output.
- Examples: quick start, retrieval with retry loop, OpenAI-compatible adapter.
