import { TaugraphError } from "./errors.js";
import type { KernelEventType, Trace, TraceEvent, TraceEventType } from "./types.js";
import { freezeJson, jsonEqual } from "./util.js";

export const TRACE_FORMAT = "taugraph.trace";
export const TRACE_VERSION = 1;

export const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set<KernelEventType>([
  "run_start",
  "enter",
  "exit",
  "error",
  "pause",
  "resume",
  "run_end",
]);

export interface EventDraft {
  readonly type: TraceEventType;
  readonly nodeId?: string | undefined;
  readonly step?: number | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Append-only event log for one run. Payloads must already be frozen JSON
 * (see `freezeJson`); the log only assigns seq / runId / timestamp and freezes the envelope.
 *
 * Every event is handed to `onEvent` before `append` returns. If the sink throws, `append`
 * throws SINK_FAILED and keeps throwing, so the run cannot take another step unlogged.
 */
export class TraceLog {
  readonly #events: TraceEvent[];
  readonly #runId: string;
  readonly #onEvent: ((event: TraceEvent) => void) | undefined;
  #sinkError: { readonly cause: unknown } | undefined;

  /** `prefix` continues an existing trace (resume); it is not sent to `onEvent` again. */
  constructor(runId: string, onEvent?: (event: TraceEvent) => void, prefix: Trace = []) {
    this.#runId = runId;
    this.#onEvent = onEvent;
    this.#events = prefix.map((event) => freezeJson(event));
  }

  append(draft: EventDraft): TraceEvent {
    const event = this.#push(draft);
    if (this.#sinkError) throw sinkFailed(this.#sinkError.cause);
    this.#emit(event);
    return event;
  }

  /** For the closing `run_end` of a failing run: never throws, skips a sink that already failed. */
  appendFinal(draft: EventDraft): TraceEvent {
    const event = this.#push(draft);
    if (!this.#sinkError) {
      try {
        this.#emit(event);
      } catch {
        // Already failing; the original error is the one to report.
      }
    }
    return event;
  }

  snapshot(): Trace {
    return Object.freeze(this.#events.slice());
  }

  #push(draft: EventDraft): TraceEvent {
    const event: Record<string, unknown> = {
      seq: this.#events.length,
      runId: this.#runId,
      type: draft.type,
      timestamp: Date.now(),
    };
    if (draft.nodeId !== undefined) event.nodeId = draft.nodeId;
    if (draft.step !== undefined) event.step = draft.step;
    if (draft.input !== undefined) event.input = draft.input;
    if (draft.output !== undefined) event.output = draft.output;
    if (draft.meta !== undefined) event.meta = Object.isFrozen(draft.meta) ? draft.meta : freezeJson(draft.meta);
    const frozen = Object.freeze(event) as unknown as TraceEvent;
    this.#events.push(frozen);
    return frozen;
  }

  #emit(event: TraceEvent): void {
    if (!this.#onEvent) return;
    try {
      this.#onEvent(event);
    } catch (cause) {
      this.#sinkError = { cause };
      throw sinkFailed(cause);
    }
  }
}

function sinkFailed(cause: unknown): TaugraphError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new TaugraphError("SINK_FAILED", `onEvent threw: ${reason}`, { cause });
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** One JSON object per line, the same layout as an append-only log file. */
export function toJSONL(trace: Trace): string {
  return trace
    .map((event) => JSON.stringify(event))
    .join("\n")
    .concat("\n");
}

export function fromJSONL(text: string): Trace {
  const events: unknown[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      events.push(JSON.parse(line));
    } catch (cause) {
      throw new TaugraphError("INVALID_TRACE", `Line ${index + 1} is not valid JSON`, { cause });
    }
  });
  return assertTrace(events);
}

/** Checks that a value is a well-formed taugraph trace and returns it typed. */
export function assertTrace(value: unknown): Trace {
  const fail = (message: string): never => {
    throw new TaugraphError("INVALID_TRACE", message);
  };
  if (!Array.isArray(value) || value.length === 0) fail("Trace must be a non-empty array of events");
  const events = value as Record<string, unknown>[];
  const first = events[0] as Record<string, unknown>;
  const meta = first.meta as Record<string, unknown> | undefined;
  if (first.type !== "run_start" || meta?.format !== TRACE_FORMAT) {
    fail(`First event must be a "${TRACE_FORMAT}" run_start event`);
  }
  if (meta?.version !== TRACE_VERSION) {
    fail(`Unsupported trace version ${String(meta?.version)} (expected ${TRACE_VERSION})`);
  }
  events.forEach((event, index) => {
    if (typeof event !== "object" || event === null) fail(`Event ${index} is not an object`);
    if (event.seq !== index) fail(`Event ${index} has seq ${String(event.seq)}; traces must be complete and ordered`);
    if (event.runId !== first.runId) fail(`Event ${index} belongs to a different run`);
    if (typeof event.type !== "string") fail(`Event ${index} has no type`);
    if (typeof event.timestamp !== "number") fail(`Event ${index} has no timestamp`);
  });
  return value as Trace;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export interface RecordedStep {
  readonly nodeId: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly seq: number;
}

/** Successful node executions keyed by step, pairing each `exit` with its `enter`. */
export function recordedSteps(trace: Trace): Map<number, RecordedStep> {
  const enters = new Map<number, TraceEvent>();
  const steps = new Map<number, RecordedStep>();
  for (const event of trace) {
    if (event.step === undefined || event.nodeId === undefined) continue;
    if (event.type === "enter") enters.set(event.step, event);
    if (event.type === "exit") {
      const enter = enters.get(event.step);
      if (enter)
        steps.set(event.step, { nodeId: event.nodeId, input: enter.input, output: event.output, seq: event.seq });
    }
  }
  return steps;
}

/** Node ids in execution order. */
export function tracePath(trace: Trace): string[] {
  const path: string[] = [];
  for (const event of trace) {
    if (event.type === "enter" && event.step === path.length && event.nodeId !== undefined) path.push(event.nodeId);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Pause / resume (internal; used by the engine)
// ---------------------------------------------------------------------------

/**
 * Where a trace can continue from.
 * - `start`: nothing ran yet.
 * - `after`: `step` finished; route on from its output.
 * - `paused`: `step` is waiting for a value.
 * - `resumed`: a value was delivered to `step` but the node had not started again.
 * - `running`: `step` was executing when the trace ended; its outcome is unknown.
 */
export type ResumePoint =
  | { readonly kind: "start" }
  | {
      readonly kind: "after" | "paused" | "resumed" | "running";
      readonly step: number;
      readonly nodeId: string;
      /** Output of the step for `after`, otherwise the state the step received. */
      readonly state: unknown;
    };

export function resumePoint(trace: Trace): ResumePoint {
  const last = trace[trace.length - 1] as TraceEvent;
  const status = last.type === "run_end" ? last.meta?.status : undefined;
  if (last.type === "run_end" && status !== "paused") {
    throw new TaugraphError(
      "NOT_RESUMABLE",
      `Run is ${String(status)}; only paused or interrupted runs can be resumed. Use graph.replay to run it again.`,
    );
  }

  // The step to continue is the one of the last step event that is not a delivered value.
  let target: number | undefined;
  for (let i = trace.length - 1; i >= 0 && target === undefined; i--) {
    const event = trace[i] as TraceEvent;
    if (event.step !== undefined && event.type !== "resume") target = event.step;
  }
  if (target === undefined) return { kind: "start" };

  let enter: TraceEvent | undefined;
  let output: unknown;
  let phase: "after" | "paused" | "resumed" | "running" = "running";
  for (const event of trace) {
    if (event.step !== target) continue;
    if (event.type === "enter") {
      enter ??= event;
      phase = "running";
    } else if (event.type === "exit") {
      phase = "after";
      output = event.output;
    } else if (event.type === "pause") {
      phase = "paused";
    } else if (event.type === "resume") {
      phase = "resumed";
    } else if (event.type === "error") {
      phase = "running";
    }
  }
  if (!enter || enter.nodeId === undefined) {
    throw new TaugraphError("INVALID_TRACE", `Step ${target} has events but no enter event`);
  }
  if (status === "paused" && phase !== "paused") {
    throw new TaugraphError("INVALID_TRACE", `run_end says the run is paused, but step ${target} is not`);
  }
  return { kind: phase, step: target, nodeId: enter.nodeId, state: phase === "after" ? output : enter.input };
}

/** Values delivered to `ctx.interrupt` at `step`, in order. */
export function deliveredValues(trace: Trace, step: number): unknown[] {
  return trace
    .filter((event) => event.type === "resume" && event.step === step && event.meta?.reason !== "recovered")
    .map((event) => event.input);
}

export interface RecordedAnswers {
  readonly nodeId: string;
  /** State the step received. Answers are only reused when a replay sees the same state. */
  readonly input: unknown;
  readonly values: readonly unknown[];
}

/** Values delivered by `resume`, keyed by step, for replays to feed back to `ctx.interrupt`. */
export function recordedAnswers(trace: Trace): Map<number, RecordedAnswers> {
  const enters = new Map<number, TraceEvent>();
  const values = new Map<number, unknown[]>();
  for (const event of trace) {
    if (event.step === undefined) continue;
    if (event.type === "enter" && !enters.has(event.step)) enters.set(event.step, event);
    if (event.type === "resume" && event.meta?.reason !== "recovered") {
      const value = event.input === undefined ? undefined : freezeJson(event.input);
      values.set(event.step, [...(values.get(event.step) ?? []), value]);
    }
  }
  const answers = new Map<number, RecordedAnswers>();
  for (const [step, list] of values) {
    const enter = enters.get(step);
    if (enter?.nodeId !== undefined) answers.set(step, { nodeId: enter.nodeId, input: enter.input, values: list });
  }
  return answers;
}

export interface TraceDiff {
  /** Same path, same per-step outputs, same final state. */
  readonly equal: boolean;
  readonly path: { readonly a: readonly string[]; readonly b: readonly string[] };
  /** First step whose node or output differs. */
  readonly firstDivergence?: { readonly step: number; readonly a?: string; readonly b?: string };
  /** Top-level keys of the final state that differ. `(root)` if the states are not both objects. */
  readonly changedKeys: readonly string[];
}

/** Compares two runs, e.g. an original trace and its replay with a swapped model. */
export function diffTraces(a: Trace, b: Trace): TraceDiff {
  const pathA = tracePath(a);
  const pathB = tracePath(b);
  const stepsA = recordedSteps(a);
  const stepsB = recordedSteps(b);

  let firstDivergence: TraceDiff["firstDivergence"];
  for (let step = 0; step < Math.max(pathA.length, pathB.length); step++) {
    const sameNode = pathA[step] === pathB[step];
    if (!sameNode || !jsonEqual(stepsA.get(step)?.output, stepsB.get(step)?.output)) {
      firstDivergence = { step, ...(pathA[step] && { a: pathA[step] }), ...(pathB[step] && { b: pathB[step] }) };
      break;
    }
  }

  const finalA = finalState(a);
  const finalB = finalState(b);
  const changedKeys: string[] = [];
  if (isRecord(finalA) && isRecord(finalB)) {
    for (const key of new Set([...Object.keys(finalA), ...Object.keys(finalB)])) {
      if (!jsonEqual(finalA[key], finalB[key])) changedKeys.push(key);
    }
  } else if (!jsonEqual(finalA, finalB)) {
    changedKeys.push("(root)");
  }

  return {
    equal: firstDivergence === undefined && changedKeys.length === 0,
    path: { a: pathA, b: pathB },
    ...(firstDivergence && { firstDivergence }),
    changedKeys,
  };
}

function finalState(trace: Trace): unknown {
  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i]?.type === "run_end") return trace[i]?.output;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
