# Trace format, version 1

A trace is the complete, append-only record of one run. It is an array of events in memory and JSON Lines on disk (`toJSONL` / `fromJSONL`): one event per line, in `seq` order.

## Event

```ts
interface TraceEvent {
  seq: number; // 0, 1, 2, ... no gaps
  runId: string; // same for every event of the run
  type: string;
  timestamp: number; // ms since epoch
  nodeId?: string; // absent on run_start / run_end
  step?: number; // index of the node execution, 0-based; absent on run_start / run_end
  input?: unknown; // JSON
  output?: unknown; // JSON
  meta?: Record<string, unknown>;
}
```

All payloads are plain JSON. In memory every event and payload is frozen.

## Kernel events

Only the kernel writes these. `ctx.trace.append` rejects them.

| type        | fields                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_start` | `input`: raw run input. `meta`: `format: "taugraph.trace"`, `version: 1`, `start`, and for replays `replayOf` (source runId) and `replayMode`.                                                |
| `enter`     | `nodeId`, `step`, `input`: state the node receives. `meta`: `attempt`, `source` (`live` \| `override` \| `recorded`), `kind`, and `recordedFrom: { runId, seq }` when `source` is `recorded`. |
| `exit`      | `nodeId`, `step`, `output`: validated new state. `meta`: same as `enter` plus `durationMs`.                                                                                                   |
| `error`     | `nodeId`, `step`. `meta`: `attempt`, `source`, `code`, `message`, `willRetry`.                                                                                                                |
| `run_end`   | `output`: final state (completed runs only). `meta`: `status` (`completed` \| `failed`), `steps`, `error: { code, message, nodeId? }` on failure.                                             |

## Plugin events

Written by nodes through `ctx.trace.append({ type, input?, output?, meta? })`. The kernel adds `seq`, `runId`, `timestamp`, `nodeId` and `step`, and copies the payload so later mutation cannot change history. Conventional types:

| type          | written by  | input          | output        | meta                  |
| ------------- | ----------- | -------------- | ------------- | --------------------- |
| `llm_call`    | `LLMNode`   | `LLMRequest`   | `LLMResponse` | `model`, `durationMs` |
| `tool_call`   | tool nodes  | tool arguments | tool result   | free-form             |
| `human_pause` | human nodes | prompt         | human reply   | free-form             |

Any other non-empty string is allowed for custom plugins. Prefix it (`myplugin.event`) to avoid collisions.

## Shape of a run

```
run_start
  enter(step 0) [plugin events...] exit(step 0)
  enter(step 1) error(step 1, willRetry) enter(step 1, attempt 2) exit(step 1)
  ...
run_end
```

- Each `step` has one or more `enter` events (one per attempt). Each attempt ends with exactly one `exit` or `error`.
- Plugin events of a step appear between its `enter` and its `exit` / `error`.
- Failures outside a step (invalid input, routing errors, `maxSteps`) appear only in `run_end.meta.error`.
- The execution path is the `nodeId` of the first `enter` of each step (`tracePath`).

## Replay contract

`graph.replay(trace)` starts a new run (new `runId`) from `run_start.input`. In `recorded` mode, the recorded output of step _n_ is reused when the node at step _n_ is not overridden, has the same id, and receives a state deep-equal to the recorded `enter.input`. Reused outputs are validated against the current schema again, so schema drift is caught.

## Versioning

`meta.version` on `run_start` is bumped on any breaking change to this format. `fromJSONL` and `replay` reject versions they do not understand.
