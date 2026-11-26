/**
 * The execution loop, written once as a generator.
 *
 * Every operation that might be asynchronous (a node call, a schema validation) is
 * `yield`ed. `driveSync` feeds results straight back and rejects Promises;
 * `driveAsync` awaits them. This keeps the kernel sync-first without tying it to
 * any async runtime, and both drivers share exactly the same semantics.
 */
import { formatIssues, TaugraphError } from "./errors.js";
import { FATAL, isRetryable, retryDelay } from "./retry.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import {
  deliveredValues,
  KERNEL_EVENT_TYPES,
  type RecordedAnswers,
  type RecordedStep,
  type ResumePoint,
  TRACE_FORMAT,
  TRACE_VERSION,
  TraceLog,
  tracePath,
} from "./trace.js";
import type { Node, PluginEvent, ReplayMode, RetryPolicy, RunContext, RunOptions, RunResult, Trace } from "./types.js";
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
  readonly answers: ReadonlyMap<number, RecordedAnswers>;
  readonly allowWrites: boolean;
}

/** Checked by `graph.resume` before anything is appended. */
export interface ResumePlan {
  readonly trace: Trace;
  readonly point: ResumePoint;
  /** Frozen JSON value for a paused step, otherwise undefined. */
  readonly value: unknown;
  /** The trace is a replay and the caller did not pass allowWrites: keep blocking writes. */
  readonly blockWrites: boolean;
}

export interface ExecuteParams<S> {
  readonly graph: CompiledGraph<S>;
  readonly options: RunOptions;
  /** Raw run input. Ignored when resuming. */
  readonly input?: unknown;
  readonly replay?: ReplayPlan<S>;
  readonly resume?: ResumePlan;
}

type Effects<T> = Generator<unknown, T, unknown>;

/** Where the step loop starts: a node to run, or an already finished run to close. */
type Start<S> =
  | {
      readonly nodeId: string;
      readonly step: number;
      readonly state: S;
      /** Values for the first step's `ctx.interrupt`; undefined lets a replay supply recorded ones. */
      readonly values: readonly unknown[] | undefined;
      readonly recovered: boolean;
    }
  | { readonly done: S };

type StepOutcome<S> =
  | { readonly kind: "exit"; readonly state: S }
  | { readonly kind: "pause"; readonly request: unknown };

const NEVER_ABORTED = new AbortController().signal;

/** Yielded to wait before a retry: `run` sleeps, `runSync` blocks the thread. */
class Wait {
  constructor(readonly ms: number) {}
}

/** Thrown by `ctx.interrupt` to unwind the node. Detection does not rely on it propagating. */
class PauseSignal extends Error {
  override readonly name = "TaugraphPause";
  constructor() {
    super("Run paused by ctx.interrupt(). Do not catch this; it is how the node waits for input.");
  }
}

export function* execute<S>(params: ExecuteParams<S>): Effects<RunResult<S>> {
  const { graph, options, replay, resume } = params;
  const signal = options.signal ?? NEVER_ABORTED;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const runId = resume ? (resume.trace[0] as Trace[number]).runId : (options.runId ?? randomId());
  const log = new TraceLog(runId, options.onEvent, resume?.trace);
  const blockWrites = replay ? !replay.allowWrites : resume?.blockWrites === true;

  try {
    const start = resume ? yield* beginResume(graph, log, resume) : yield* beginRun(graph, log, params.input, replay);
    let state: S;
    if ("done" in start) {
      state = start.done;
    } else {
      state = start.state;
      let current = start.nodeId;
      let carry: Pick<StepParams<S>, "values" | "recovered"> = { values: start.values, recovered: start.recovered };
      for (let step = start.step; ; step++) {
        throwIfAborted(signal);
        if (step >= maxSteps) {
          throw new TaugraphError(
            "MAX_STEPS",
            `Run exceeded maxSteps (${maxSteps}). The graph may loop forever; add an exit condition or raise maxSteps.`,
          );
        }
        const params = { graph, log, runId, signal, replay, blockWrites, nodeId: current, step, state, ...carry };
        const outcome = yield* runStep(params);
        carry = { values: undefined, recovered: false };
        if (outcome.kind === "pause") {
          log.append({
            type: "run_end",
            meta: { status: "paused", steps: tracePath(log.snapshot()).length, pending: { nodeId: current, step } },
          });
          const trace = log.snapshot();
          const pending = { nodeId: current, step, request: outcome.request };
          return { status: "paused", runId, state, trace, path: tracePath(trace), pending };
        }
        state = outcome.state;
        if (graph.endNodes.has(current)) break;
        current = nextNode(graph, current, state);
      }
    }

    log.append({
      type: "run_end",
      output: state,
      meta: { status: "completed", steps: tracePath(log.snapshot()).length },
    });
    const trace = log.snapshot();
    return { status: "completed", runId, state, trace, path: tracePath(trace) };
  } catch (thrown) {
    const error =
      thrown instanceof TaugraphError
        ? thrown
        : new TaugraphError("NODE_FAILED", errorMessage(thrown), { cause: thrown });
    log.appendFinal({
      type: "run_end",
      meta: {
        status: "failed",
        steps: tracePath(log.snapshot()).length,
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

function* beginRun<S>(
  graph: CompiledGraph<S>,
  log: TraceLog,
  rawInput: unknown,
  replay: ReplayPlan<S> | undefined,
): Effects<Start<S>> {
  const input = toJson(rawInput, "Run input is not plain JSON");
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
  const state = yield* validate(graph.schema, input, "Run input failed schema validation");
  return { nodeId: graph.start, step: 0, state, values: undefined, recovered: false };
}

function* beginResume<S>(graph: CompiledGraph<S>, log: TraceLog, plan: ResumePlan): Effects<Start<S>> {
  const { point } = plan;
  if (point.kind === "start" || point.kind === "after") {
    log.append({ type: "resume", meta: { reason: "recovered" } });
    if (point.kind === "start") {
      const input = (plan.trace[0] as Trace[number]).input;
      const state = yield* validate(graph.schema, input, "Run input failed schema validation");
      return { nodeId: graph.start, step: 0, state, values: [], recovered: false };
    }
    const message = `State recorded after step ${point.step} no longer matches the schema`;
    const state = yield* validate(graph.schema, point.state, message, point.nodeId, point.step);
    if (graph.endNodes.has(point.nodeId)) return { done: state };
    const step = point.step + 1;
    return {
      nodeId: nextNode(graph, point.nodeId, state),
      step,
      state,
      values: deliveredValues(plan.trace, step),
      recovered: false,
    };
  }

  const delivered = point.kind === "paused";
  log.append({
    type: "resume",
    nodeId: point.nodeId,
    step: point.step,
    ...(delivered && plan.value !== undefined && { input: plan.value }),
    meta: { reason: delivered ? "paused" : "recovered" },
  });
  const message = `State recorded for step ${point.step} no longer matches the schema`;
  const state = yield* validate(graph.schema, point.state, message, point.nodeId, point.step);
  return {
    nodeId: point.nodeId,
    step: point.step,
    state,
    values: deliveredValues(log.snapshot(), point.step),
    recovered: point.kind === "running",
  };
}

interface StepParams<S> {
  readonly graph: CompiledGraph<S>;
  readonly log: TraceLog;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly replay: ReplayPlan<S> | undefined;
  /** True during a replay, and when resuming a replay, unless allowWrites was passed. */
  readonly blockWrites: boolean;
  readonly nodeId: string;
  readonly step: number;
  readonly state: S;
  /** Values for `ctx.interrupt`, set when resuming this step. */
  readonly values: readonly unknown[] | undefined;
  readonly recovered: boolean;
}

function* runStep<S>(p: StepParams<S>): Effects<StepOutcome<S>> {
  const { graph, log, nodeId, step, state, replay } = p;
  const override = replay?.overrides[nodeId];
  const recorded = override ? undefined : replay?.recorded.get(step);

  if (recorded && recorded.nodeId === nodeId && jsonEqual(recorded.input, state)) {
    const meta = { attempt: 1, source: "recorded", recordedFrom: { runId: replay?.sourceRunId, seq: recorded.seq } };
    log.append({ type: "enter", nodeId, step, input: state, meta });
    const output = toJson(recorded.output, `Recorded output of node "${nodeId}" is not plain JSON`, nodeId, step);
    const message = `Recorded output of node "${nodeId}" (step ${step}) no longer matches the schema`;
    const next = yield* validate(graph.schema, output, message, nodeId, step, state);
    log.append({ type: "exit", nodeId, step, output: next, meta: { ...meta, durationMs: 0 } });
    return { kind: "exit", state: next };
  }

  const node = override ?? (graph.nodes[nodeId] as Node<S>);
  const source = override ? "override" : "live";
  if (p.blockWrites && node.effect === "write") {
    throw new TaugraphError(
      "WRITE_BLOCKED",
      `Replay reached write node "${nodeId}" (step ${step}), which would run live. Override it with a mock, or pass allowWrites: true to really run it.`,
      { nodeId, step },
    );
  }

  let values = p.values;
  if (values === undefined) {
    const answers = replay?.answers.get(step);
    values = answers && answers.nodeId === nodeId && jsonEqual(answers.input, state) ? answers.values : [];
    for (const value of values) {
      const from = { runId: replay?.sourceRunId };
      log.append({ type: "resume", nodeId, step, input: value, meta: { reason: "replayed", recordedFrom: from } });
    }
  }

  const maxAttempts = node.retry?.maxAttempts ?? 1;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(p.signal);
    const meta = {
      attempt,
      source,
      ...(node.kind !== undefined && { kind: node.kind }),
      ...(node.effect !== undefined && { effect: node.effect }),
      ...(p.recovered && { recovered: true }),
    };
    log.append({ type: "enter", nodeId, step, input: state, meta });
    const startedAt = Date.now();
    const control = createContext({ ...p, attempt, values });
    try {
      let output: unknown;
      let failure: { readonly error: unknown } | undefined;
      try {
        output = yield node(state, control.ctx);
      } catch (error) {
        failure = { error };
      } finally {
        control.close();
      }
      // A requested pause wins, even if the node caught the signal or threw something else.
      if (control.pending) {
        const { request } = control.pending;
        const durationMs = Date.now() - startedAt;
        log.append({ type: "pause", nodeId, step, output: request, meta: { ...meta, durationMs } });
        return { kind: "pause", request };
      }
      if (failure) throw failure.error;
      const message = `Node "${nodeId}" (step ${step}) returned a state that is not plain JSON`;
      const json = toJson(output, message, nodeId, step, state);
      const next = yield* validate(
        graph.schema,
        json,
        `Node "${nodeId}" (step ${step}) returned invalid state`,
        nodeId,
        step,
        state,
      );
      log.append({ type: "exit", nodeId, step, output: next, meta: { ...meta, durationMs: Date.now() - startedAt } });
      return { kind: "exit", state: next };
    } catch (thrown) {
      const error = asNodeError(thrown, nodeId, step);
      const willRetry = attempt < maxAttempts && shouldRetry(node, error, thrown);
      const delayMs = willRetry && node.retry ? retryDelay(node.retry, attempt, thrown) : 0;
      log.append({
        type: "error",
        nodeId,
        step,
        meta: { attempt, source, code: error.code, message: error.message, willRetry, ...(willRetry && { delayMs }) },
      });
      if (!willRetry) throw error;
      if (delayMs > 0) yield new Wait(delayMs);
    }
  }
}

/** `retryOn` (or `isRetryable`) decides, except for a run that is stopping and for writes not declared idempotent. */
function shouldRetry<S>(node: Node<S>, error: TaugraphError, thrown: unknown): boolean {
  const retry: RetryPolicy | undefined = node.retry;
  if (!retry || FATAL.has(error.code)) return false;
  if (node.effect === "write" && retry.idempotent !== true) return false; // createGraph refuses these too
  return (retry.retryOn ?? isRetryable)(thrown);
}

interface ContextParams {
  readonly log: TraceLog;
  readonly runId: string;
  readonly nodeId: string;
  readonly step: number;
  readonly attempt: number;
  readonly recovered: boolean;
  readonly signal: AbortSignal;
  readonly values: readonly unknown[];
}

interface Control {
  readonly ctx: RunContext;
  readonly pending: { readonly request: unknown } | undefined;
  close(): void;
}

function createContext(p: ContextParams): Control {
  const { log, nodeId, step } = p;
  let open = true;
  let used = 0;
  let pending: { readonly request: unknown } | undefined;
  const fail = (message: string, cause?: unknown): never => {
    throw new TaugraphError("INVALID_EVENT", message, { nodeId, step, cause });
  };

  const ctx: RunContext = Object.freeze({
    meta: Object.freeze({
      runId: p.runId,
      nodeId,
      step,
      attempt: p.attempt,
      recovered: p.recovered,
      idempotencyKey: `${p.runId}:${step}`,
    }),
    signal: p.signal,
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
    interrupt<T>(request?: unknown): T {
      if (!open) fail(`Node "${nodeId}" called interrupt() after its step finished`);
      if (pending) throw new PauseSignal();
      if (used < p.values.length) return p.values[used++] as T;
      let frozen: unknown;
      try {
        frozen = request === undefined ? undefined : freezeJson(request);
      } catch (cause) {
        fail(`interrupt() request from node "${nodeId}" is not plain JSON: ${errorMessage(cause)}`, cause);
      }
      pending = { request: frozen };
      throw new PauseSignal();
    },
  });

  return {
    ctx,
    get pending() {
      return pending;
    },
    close: () => {
      open = false;
    },
  };
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
  base?: unknown,
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
  return toJson(result.value, `${message}: validated state is not plain JSON`, nodeId, step, base);
}

export function toJson<T>(value: T, message: string, nodeId?: string, step?: number, base?: unknown): T {
  try {
    return freezeJson(value, base);
  } catch (cause) {
    if (!(cause instanceof NotJsonError)) throw cause;
    throw new TaugraphError("INVALID_STATE", `${message} (${cause.message})`, { nodeId, step, cause });
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
    const effect = next.value;
    if (effect instanceof Wait) {
      let failure: TaugraphError | undefined;
      try {
        blockFor(effect.ms);
      } catch (error) {
        failure = error as TaugraphError;
      }
      next = failure ? effects.throw(failure) : effects.next(undefined);
    } else if (isThenable(effect)) {
      Promise.resolve(effect).catch(() => {}); // the result is discarded; avoid an unhandled rejection
      next = effects.throw(
        new TaugraphError("ASYNC_IN_SYNC_RUN", "runSync() received a Promise. Use run() for async nodes or schemas."),
      );
    } else {
      next = effects.next(effect);
    }
  }
  return next.value;
}

/** Blocks the thread for `ms`. Throws ASYNC_IN_SYNC_RUN where blocking is not allowed, such as a browser's main thread. */
function blockFor(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (cause) {
    throw new TaugraphError("ASYNC_IN_SYNC_RUN", `runSync() cannot wait ${ms}ms before retrying here; use run()`, {
      cause,
    });
  }
}

export async function driveAsync<T>(effects: Effects<T>, signal?: AbortSignal): Promise<T> {
  let next = effects.next();
  while (!next.done) {
    const effect = next.value;
    let value: unknown;
    try {
      if (effect instanceof Wait) value = await sleep(effect.ms, signal);
      else value = isThenable(effect) ? await abortable(effect, signal) : effect;
    } catch (error) {
      next = effects.throw(error);
      continue;
    }
    next = effects.next(value);
  }
  return next.value;
}

/** Resolves after `ms`, or rejects with ABORTED as soon as the signal fires. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
