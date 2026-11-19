/**
 * The execution loop, written once as a generator.
 *
 * Every operation that might be asynchronous (a node call, a schema validation) is
 * `yield`ed. `driveSync` feeds results straight back and rejects Promises;
 * `driveAsync` awaits them. This keeps the kernel sync-first without tying it to
 * any async runtime, and both drivers share exactly the same semantics.
 */
import { formatIssues, TaugraphError } from "./errors.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import { KERNEL_EVENT_TYPES, type RecordedStep, TRACE_FORMAT, TRACE_VERSION, TraceLog } from "./trace.js";
import type { Node, PluginEvent, ReplayMode, RunContext, RunOptions, RunResult } from "./types.js";
import { freezeJson, isThenable, jsonEqual, NotJsonError, randomId } from "./util.js";

export const DEFAULT_MAX_STEPS = 100;

export type Outgoing<S> =
  | { readonly kind: "edge"; readonly to: string }
  | { readonly kind: "route"; readonly route: (state: S) => string; readonly targets?: ReadonlySet<string> };

export interface CompiledGraph<S> {
  readonly schema: StandardSchemaV1<unknown, S>;
  readonly start: string;
  readonly nodes: Readonly<Record<string, Node<S>>>;
  readonly outgoing: ReadonlyMap<string, Outgoing<S>>;
  readonly endNodes: ReadonlySet<string>;
}

export interface ReplayPlan<S> {
  readonly sourceRunId: string;
  readonly mode: ReplayMode;
  readonly overrides: Readonly<Record<string, Node<S> | undefined>>;
  readonly recorded: ReadonlyMap<number, RecordedStep>;
}

export interface ExecuteParams<S> {
  readonly graph: CompiledGraph<S>;
  readonly input: unknown;
  readonly options: RunOptions;
  readonly replay?: ReplayPlan<S>;
}

type Effects<T> = Generator<unknown, T, unknown>;

const NON_RETRYABLE = new Set(["ABORTED", "ASYNC_IN_SYNC_RUN", "INVALID_EVENT"]);
const NEVER_ABORTED = new AbortController().signal;

export function* execute<S>(params: ExecuteParams<S>): Effects<RunResult<S>> {
  const { graph, options, replay } = params;
  const runId = options.runId ?? randomId();
  const signal = options.signal ?? NEVER_ABORTED;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const log = new TraceLog(runId, options.onEvent);
  const path: string[] = [];

  try {
    const input = toJson(params.input, "INVALID_STATE", "Run input is not plain JSON");
    log.append({
      type: "run_start",
      input,
      meta: {
        format: TRACE_FORMAT,
        version: TRACE_VERSION,
        start: graph.start,
        ...(replay && { replayOf: replay.sourceRunId, replayMode: replay.mode }),
      },
    });

    let state: S = yield* validate(graph.schema, input, "Run input failed schema validation");
    let current = graph.start;

    for (let step = 0; ; step++) {
      throwIfAborted(signal);
      if (step >= maxSteps) {
        throw new TaugraphError(
          "MAX_STEPS",
          `Run exceeded maxSteps (${maxSteps}). The graph may loop forever; add an exit condition or raise maxSteps.`,
        );
      }
      path.push(current);
      state = yield* runStep({ graph, log, runId, signal, replay, nodeId: current, step, state });
      if (graph.endNodes.has(current)) break;
      current = nextNode(graph, current, state);
    }

    log.append({ type: "run_end", output: state, meta: { status: "completed", steps: path.length } });
    return { runId, state, trace: log.snapshot(), path };
  } catch (thrown) {
    const error =
      thrown instanceof TaugraphError
        ? thrown
        : new TaugraphError("NODE_FAILED", errorMessage(thrown), { cause: thrown });
    log.append({
      type: "run_end",
      meta: {
        status: "failed",
        steps: path.length,
        error: {
          code: error.code,
          message: error.message,
          ...(error.nodeId !== undefined && { nodeId: error.nodeId }),
        },
      },
    });
    error.trace = log.snapshot();
    throw error;
  }
}

interface StepParams<S> {
  readonly graph: CompiledGraph<S>;
  readonly log: TraceLog;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly replay: ReplayPlan<S> | undefined;
  readonly nodeId: string;
  readonly step: number;
  readonly state: S;
}

function* runStep<S>(p: StepParams<S>): Effects<S> {
  const { graph, log, nodeId, step, state } = p;
  const override = p.replay?.overrides[nodeId];
  const recorded = override ? undefined : p.replay?.recorded.get(step);

  if (recorded && recorded.nodeId === nodeId && jsonEqual(recorded.input, state)) {
    const meta = { attempt: 1, source: "recorded", recordedFrom: { runId: p.replay?.sourceRunId, seq: recorded.seq } };
    log.append({ type: "enter", nodeId, step, input: state, meta });
    const output = toJson(
      recorded.output,
      "INVALID_STATE",
      `Recorded output of node "${nodeId}" is not plain JSON`,
      nodeId,
      step,
    );
    const next = yield* validate(
      graph.schema,
      output,
      `Recorded output of node "${nodeId}" (step ${step}) no longer matches the schema`,
      nodeId,
      step,
    );
    log.append({ type: "exit", nodeId, step, output: next, meta: { ...meta, durationMs: 0 } });
    return next;
  }

  const node = override ?? (graph.nodes[nodeId] as Node<S>);
  const source = override ? "override" : "live";
  const maxAttempts = node.retry?.maxAttempts ?? 1;

  for (let attempt = 1; ; attempt++) {
    throwIfAborted(p.signal);
    const meta = { attempt, source, ...(node.kind !== undefined && { kind: node.kind }) };
    log.append({ type: "enter", nodeId, step, input: state, meta });
    const startedAt = Date.now();
    const { ctx, close } = createContext(log, p.runId, nodeId, step, attempt, p.signal);
    try {
      let output: unknown;
      try {
        output = yield node(state, ctx);
      } finally {
        close();
      }
      const json = toJson(
        output,
        "INVALID_STATE",
        `Node "${nodeId}" (step ${step}) returned a state that is not plain JSON`,
        nodeId,
        step,
      );
      const next = yield* validate(
        graph.schema,
        json,
        `Node "${nodeId}" (step ${step}) returned invalid state`,
        nodeId,
        step,
      );
      log.append({ type: "exit", nodeId, step, output: next, meta: { ...meta, durationMs: Date.now() - startedAt } });
      return next;
    } catch (thrown) {
      const error = asNodeError(thrown, nodeId, step);
      const willRetry = attempt < maxAttempts && !NON_RETRYABLE.has(error.code);
      log.append({
        type: "error",
        nodeId,
        step,
        meta: { attempt, source, code: error.code, message: error.message, willRetry },
      });
      if (!willRetry) throw error;
    }
  }
}

function createContext(
  log: TraceLog,
  runId: string,
  nodeId: string,
  step: number,
  attempt: number,
  signal: AbortSignal,
): { ctx: RunContext; close: () => void } {
  let open = true;
  const fail = (message: string, cause?: unknown): never => {
    throw new TaugraphError("INVALID_EVENT", message, { nodeId, step, cause });
  };
  const ctx: RunContext = Object.freeze({
    meta: Object.freeze({ runId, nodeId, step, attempt }),
    signal,
    trace: Object.freeze({
      append(event: PluginEvent) {
        if (!open) fail(`Node "${nodeId}" appended "${event.type}" after its step finished`);
        if (typeof event.type !== "string" || event.type === "") fail("Trace events need a non-empty string type");
        if (KERNEL_EVENT_TYPES.has(event.type)) fail(`Event type "${event.type}" is reserved for the kernel`);
        let payload: { input?: unknown; output?: unknown; meta?: Record<string, unknown> };
        try {
          payload = freezeJson({ input: event.input, output: event.output, meta: event.meta });
        } catch (cause) {
          return fail(`Event "${event.type}" from node "${nodeId}" is not plain JSON: ${errorMessage(cause)}`, cause);
        }
        log.append({ type: event.type, nodeId, step, ...payload });
      },
    }),
  });
  return { ctx, close: () => (open = false) };
}

function nextNode<S>(graph: CompiledGraph<S>, from: string, state: S): string {
  const out = graph.outgoing.get(from) as Outgoing<S>;
  if (out.kind === "edge") return out.to;

  let to: unknown;
  try {
    to = out.route(state);
  } catch (cause) {
    throw new TaugraphError("INVALID_ROUTE", `Router of node "${from}" threw: ${errorMessage(cause)}`, {
      nodeId: from,
      cause,
    });
  }
  if (typeof to !== "string" || !Object.hasOwn(graph.nodes, to)) {
    const hint = isThenable(to) ? " Routers must be synchronous; do async work in a node and route on its result." : "";
    throw new TaugraphError(
      "INVALID_ROUTE",
      `Router of node "${from}" returned ${describe(to)}, which is not a node id.${hint}`,
      { nodeId: from },
    );
  }
  if (out.targets && !out.targets.has(to)) {
    throw new TaugraphError(
      "INVALID_ROUTE",
      `Router of node "${from}" returned "${to}", which is not in its declared targets [${[...out.targets].join(", ")}]`,
      { nodeId: from },
    );
  }
  return to;
}

function* validate<S>(
  schema: StandardSchemaV1<unknown, S>,
  value: unknown,
  message: string,
  nodeId?: string,
  step?: number,
): Effects<S> {
  let result = schema["~standard"].validate(value);
  if (isThenable(result)) result = (yield result) as StandardSchemaV1.Result<S>;
  if (result.issues) {
    throw new TaugraphError("INVALID_STATE", `${message}:\n${formatIssues(result.issues)}`, {
      nodeId,
      step,
      issues: result.issues,
    });
  }
  return toJson(result.value, "INVALID_STATE", `${message}: validated state is not plain JSON`, nodeId, step);
}

function toJson<T>(value: T, code: "INVALID_STATE", message: string, nodeId?: string, step?: number): T {
  try {
    return freezeJson(value);
  } catch (cause) {
    if (!(cause instanceof NotJsonError)) throw cause;
    throw new TaugraphError(code, `${message} (${cause.message})`, { nodeId, step, cause });
  }
}

function asNodeError(thrown: unknown, nodeId: string, step: number): TaugraphError {
  if (thrown instanceof TaugraphError) {
    if (thrown.nodeId !== undefined) return thrown;
    return new TaugraphError(thrown.code, `Node "${nodeId}" (step ${step}): ${thrown.message}`, {
      nodeId,
      step,
      issues: thrown.issues,
      cause: thrown.cause,
    });
  }
  return new TaugraphError("NODE_FAILED", `Node "${nodeId}" (step ${step}) failed: ${errorMessage(thrown)}`, {
    nodeId,
    step,
    cause: thrown,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): TaugraphError {
  return new TaugraphError("ABORTED", "Run was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (isThenable(value)) return "a Promise";
  return String(value);
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export function driveSync<T>(effects: Effects<T>): T {
  let next = effects.next();
  while (!next.done) {
    if (isThenable(next.value)) {
      Promise.resolve(next.value).catch(() => {}); // the result is discarded; avoid an unhandled rejection
      next = effects.throw(
        new TaugraphError("ASYNC_IN_SYNC_RUN", "runSync() received a Promise. Use run() for async nodes or schemas."),
      );
    } else {
      next = effects.next(next.value);
    }
  }
  return next.value;
}

export async function driveAsync<T>(effects: Effects<T>, signal?: AbortSignal): Promise<T> {
  let next = effects.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = isThenable(next.value) ? await abortable(next.value, signal) : next.value;
    } catch (error) {
      next = effects.throw(error);
      continue;
    }
    next = effects.next(value);
  }
  return next.value;
}

/** Stops waiting as soon as the signal fires, even if the node ignores the signal. */
function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
