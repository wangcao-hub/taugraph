// taugraph kernel: graph definition, runtime, typed state, append-only trace.
// Plugin nodes (CodeNode, LLMNode, ...) live in "taugraph/nodes" and only use this public API.

export type { TaugraphErrorCode, TaugraphErrorDetails } from "./core/errors.js";
export { isTaugraphError, TaugraphError } from "./core/errors.js";
export { createGraph } from "./core/graph.js";
export { defineNode } from "./core/node.js";
export type { StandardSchemaV1 } from "./core/standard-schema.js";
export type { RecordedStep, RunStatus, TraceDiff } from "./core/trace.js";
export {
  assertTrace,
  createTraceEncoder,
  diffTraces,
  fromJSONL,
  recordedSteps,
  runStatus,
  TRACE_FORMAT,
  TRACE_VERSION,
  toJSONL,
  tracePath,
} from "./core/trace.js";
export type {
  CompletedRun,
  ConditionalEdge,
  Edge,
  Effect,
  Graph,
  GraphDefinition,
  KernelEventType,
  MaybePromise,
  Node,
  NodeFn,
  NodeMeta,
  PausedRun,
  Pending,
  PluginEvent,
  PluginEventType,
  ReplayMode,
  ReplayOptions,
  ResumeOptions,
  RetryPolicy,
  RunContext,
  RunOptions,
  RunResult,
  Trace,
  TraceEvent,
  TraceEventType,
} from "./core/types.js";
