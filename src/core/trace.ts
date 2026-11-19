import { TaugraphError } from "./errors.js";
import type { KernelEventType, Trace, TraceEvent, TraceEventType } from "./types.js";
import { jsonEqual } from "./util.js";

export const TRACE_FORMAT = "taugraph.trace";
export const TRACE_VERSION = 1;

export const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set<KernelEventType>([
  "run_start",
  "enter",
  "exit",
  "error",
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
 */
export class TraceLog {
  readonly #events: TraceEvent[] = [];
  readonly #runId: string;
  readonly #onEvent: ((event: TraceEvent) => void) | undefined;

  constructor(runId: string, onEvent?: (event: TraceEvent) => void) {
    this.#runId = runId;
    this.#onEvent = onEvent;
  }

  append(draft: EventDraft): TraceEvent {
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
    if (draft.meta !== undefined)
      event.meta = Object.isFrozen(draft.meta) ? draft.meta : Object.freeze({ ...draft.meta });
    const frozen = Object.freeze(event) as unknown as TraceEvent;
    this.#events.push(frozen);
    if (this.#onEvent) {
      try {
        this.#onEvent(frozen);
      } catch (error) {
        // A broken sink must not corrupt the run; surface the error out of band.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    return frozen;
  }

  snapshot(): Trace {
    return Object.freeze(this.#events.slice());
  }
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
