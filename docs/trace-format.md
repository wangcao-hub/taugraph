# Trace format, version 2

A trace is the complete, append-only record of one run. It is an array of events in memory and JSON Lines on disk (`toJSONL` / `fromJSONL`): one event per line, in `seq` order. A paused run and its resumptions share one runId and one trace.

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

| type        | fields                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_start` | `input`: raw run input. `meta`: `format: "taugraph.trace"`, `version: 2`, `start`, and for replays `replayOf` (source runId) and `replayMode`.                                                                                                                                                       |
| `enter`     | `nodeId`, `step`, `input`: state the node receives. `meta`: `attempt`, `source` (`live` \| `override` \| `recorded`), `kind`, `effect`, `recovered: true` when restarted after a crash, and `recordedFrom: { runId, seq }` when `source` is `recorded`.                                              |
| `exit`      | `nodeId`, `step`, `output`: validated new state. `meta`: same as `enter` plus `durationMs`.                                                                                                                                                                                                          |
| `error`     | `nodeId`, `step`. `meta`: `attempt`, `source`, `code`, `message`, `willRetry`.                                                                                                                                                                                                                       |
| `pause`     | `nodeId`, `step`, `output`: the `ctx.interrupt` request. `meta`: same as `enter` plus `durationMs`.                                                                                                                                                                                                  |
| `resume`    | Starts a new segment. `meta.reason`: `paused` (`nodeId`, `step`, `input`: the delivered value), `recovered` (continuing an interrupted trace; `nodeId` and `step` only when restarting an unfinished step), or `replayed` (a recorded value fed back during replay, with `recordedFrom: { runId }`). |
| `run_end`   | `output`: final state (completed runs only). `meta`: `status` (`completed` \| `paused` \| `failed`), `steps`, `pending: { nodeId, step }` when paused, `error: { code, message, nodeId? }` on failure.                                                                                               |

## Plugin events

Written by nodes through `ctx.trace.append({ type, input?, output?, meta? })`. The kernel adds `seq`, `runId`, `timestamp`, `nodeId` and `step`, and copies the payload so later mutation cannot change history. Conventional types:

| type        | written by                | input                                            | output                                     | meta                                                                        |
| ----------- | ------------------------- | ------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| `llm_call`  | `LLMNode`                 | `LLMRequest`                                     | `LLMResponse`                              | `model`, `durationMs`                                                       |
| `tool_call` | tool nodes; `createAgent` | tool arguments; agent: `{ id, name, arguments }` | tool result; agent: `{ content, isError }` | free-form; agent: `effect`, `durationMs`, `error: true` when the tool threw |

Any other non-empty string is allowed for custom plugins. Prefix it (`myplugin.event`) to avoid collisions.

In `llm_call.input.messages` (the `content` of user and tool messages) and in the agent's `tool_call.output.content`, content is either a string or an array of parts: `{ type: "text", text }`, `{ type: "image", data, mimeType }` (base64) or `{ type: "image", url, mimeType? }`. `toJSONL` and `fileStore` write a base64 image that a tool returns three times (the `tool_call` output, the `exit` patch that adds it to the state, and the next `llm_call`) and one that the user sends twice (when it enters the state and in the first `llm_call` that sends it); a sink that writes `JSON.stringify(event)` for each event repeats it at every step. Pass a reference as `url` and let the adapter read it to keep traces small. In `recorded` mode, replay reuses a step's recorded `exit` state when the step sees its recorded input, so references only have to resolve for steps that run again (`source` `live` or `override`).

`llm_call.output.reasoning` holds what the model thought (`{ text, signature?, redacted? }[]`) and `llm_call.output.usage.reasoningTokens` its token count. Assistant messages may carry `reasoning` and `model`, the `LLMModel.id` that wrote them; tool calls may carry `signature`. Adapters send signatures back only to the model named in `model`.

## Shape of a run

```
run_start
  enter(step 0) [plugin events...] exit(step 0)
  enter(step 1) error(step 1, willRetry) enter(step 1, attempt 2) exit(step 1)
  enter(step 2) pause(step 2)
run_end(paused)
resume(step 2, reason paused)
  enter(step 2) exit(step 2)
  ...
run_end(completed)
```

- Each attempt starts with `enter` and ends with exactly one `exit`, `error` or `pause`.
- Plugin events of a step appear between its `enter` and the end of the attempt.
- Every `run_end(paused)` is followed, if the run continues, by a `resume`. A trace that ends without `run_end` was interrupted (for example by a crash) and can be continued with `resume`.
- The values delivered to step _n_ are the `input` of its `resume` events whose reason is not `recovered`, in order. The k-th `ctx.interrupt` call of the step returns the k-th value.
- Failures outside a step (invalid input, routing errors, `maxSteps`, `WRITE_BLOCKED`) appear only in `run_end.meta.error`.
- The execution path is the `nodeId` of the first `enter` of each step (`tracePath`).

## Resume contract

`graph.resume(trace, value?)` appends to the trace under the same runId. Nothing is appended if the resume is rejected (`NOT_RESUMABLE`, `UNKNOWN_OUTCOME`, `INVALID_STATE` for a non-JSON value).

- Ends with `run_end(paused)`: `value` is delivered to the pending step, which runs again from the top.
- Ends without `run_end`: continues from the last step event. A finished step routes on; an unfinished step runs again with `ctx.meta.recovered === true`, except that an unfinished `write` step needs `allowWrites: true`. Passing a value here is rejected.
- Ends with `run_end(completed | failed)`: rejected. Use `replay` to run it again.
- The trace is a replay (`run_start.meta.replayOf` is set): `write` nodes stay blocked (`WRITE_BLOCKED`) unless `allowWrites: true` is passed.

## Replay contract

`graph.replay(trace)` starts a new run (new `runId`) from `run_start.input`. In `recorded` mode, the recorded output of step _n_ is reused when the node at step _n_ is not overridden, has the same id, and receives a state deep-equal to the recorded `enter.input`. Reused outputs are validated against the current schema again, so schema drift is caught. In both modes, a live step that receives its recorded input state gets the recorded `resume` values again. A `write` node that would run live fails with `WRITE_BLOCKED` unless `allowWrites` is set; overriding it with a node that is not `write` avoids this.

## Encoding (version 2)

`toJSONL` writes one event per line. Events keep their shape in memory; on disk, an `input` or `output` field may be written as `inputPatch` / `outputPatch`, a JSON Patch (RFC 6902, only `add`, `remove` and `replace`; `add` to an array takes `-` to append or an index from 0 to the length to insert, and writers currently append with `-` only) against a base value:

| field                           | base                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `run_start.input`               | none, always written in full                                                                          |
| `enter.input`, `run_end.output` | the current state: the `run_start` input until the first `exit`, then the latest `exit` output        |
| `exit.output`                   | the latest `enter.input` of the same step                                                             |
| any other field                 | the same field of the most recent earlier event with the same `type` and `nodeId` that has that field |

Events without `nodeId` are bases for each other when they have the same `type`. A field is never written both in full and as a patch. When the order of an object's keys changes, the writer replaces the whole object; keys that `add` puts into an object go at the end.

`toJSONL` uses the patch when it is shorter than 4096 characters or not longer than the full value; `[]` means equal to the base. Readers check patches strictly: `add` into an array takes `-` or an index from 0 to its length, `replace` and `remove` need the key or index to exist, only an object's own keys count, `__proto__` is an ordinary key, and the whole value (path `""`) can be replaced but not removed. `fromJSONL` applies patches in order and returns full events. `toJSONL(trace, { from })` writes the events from `from` on with earlier events as bases, so chunks written that way concatenate into a valid file; `createTraceEncoder(prefix)` does the same one event at a time for a store. `fromJSONL(text, { tornTail: "drop" })` drops a last line that a crash cut short (no final newline, not valid JSON); any other broken line is `INVALID_TRACE`.

## Versioning

`meta.version` on `run_start` is bumped on any breaking change to this format. Version 2 added patches; `fromJSONL` reads versions 1 and 2 and rejects others, and `replay` and `resume` accept both. `toJSONL(trace)` writes version 2, also for a trace read from version 1. After a version 1 header, `toJSONL(trace, { from })` with `from > 0` and `createTraceEncoder(prefix)` write full lines, so a continued version 1 file stays version 1. Additive changes, such as new event types or new `meta` fields, do not bump the version; consumers should ignore what they do not know.
