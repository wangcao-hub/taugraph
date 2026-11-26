export type MaybePromise<T> = T | PromiseLike<T>;

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/** Event types written by the kernel. Nodes cannot append these. */
export type KernelEventType = "run_start" | "enter" | "exit" | "error" | "pause" | "resume" | "run_end";

/** Event types reserved by convention for plugin nodes. */
export type PluginEventType = "llm_call" | "tool_call";

export type TraceEventType = KernelEventType | PluginEventType | (string & {});

/** One immutable, JSON-serializable record in the append-only transcript. */
export interface TraceEvent {
  /** Position in the run, starting at 0. Strictly increasing. */
  readonly seq: number;
  readonly runId: string;
  readonly type: TraceEventType;
  /** Milliseconds since epoch. */
  readonly timestamp: number;
  readonly nodeId?: string;
  /** Index of the node execution this event belongs to, starting at 0. */
  readonly step?: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** A full run transcript. Serialize it with `toJSONL`, replay it with `graph.replay`. */
export type Trace = readonly TraceEvent[];

/** What a node may append through `ctx.trace.append`. The kernel fills in the rest. */
export interface PluginEvent {
  readonly type: TraceEventType;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/**
 * What running a node does to the outside world.
 * - `read`: safe to run again (queries, LLM calls, pure code).
 * - `write`: changes something outside the run (placing an order, sending a message).
 *   Replay never re-executes a write node unless you pass `allowWrites: true`.
 * Undeclared nodes are treated like `read`.
 */
export type Effect = "read" | "write";

export interface RunContext {
  readonly meta: {
    readonly runId: string;
    readonly nodeId: string;
    readonly step: number;
    /** 1-based attempt number when the node has a retry policy. */
    readonly attempt: number;
    /**
     * True when this step was already running when the trace ended (e.g. after a crash)
     * and `resume` started it again. A write node should check whether its effect already happened.
     */
    readonly recovered: boolean;
    /**
     * `<runId>:<step>`: the same for every attempt of this step, and when a crashed step is restarted. Pass it to an
     * API that deduplicates (an `Idempotency-Key` header, say) so a retried write takes effect once.
     */
    readonly idempotencyKey: string;
  };
  /** Aborted when the caller cancels the run. Pass it to fetch / model clients. */
  readonly signal: AbortSignal;
  readonly trace: {
    /** Append a side-effect record (llm_call, tool_call, ...) to the transcript. */
    append(event: PluginEvent): void;
  };
  /**
   * Asks the outside world for a value and pauses the run until `graph.resume(trace, value)`.
   * On resume the node runs again from the top and this call returns the value.
   * The n-th call in a node returns the n-th value delivered to this step.
   * Code before the call runs again on resume, so keep it free of side effects.
   * `request` (plain JSON) is recorded in the `pause` event and returned as `pending.request`.
   */
  interrupt<T = unknown>(request?: unknown): T;
}

export interface RetryBackoff {
  /** Wait before the first retry, in milliseconds. Default 500. */
  readonly initialMs?: number;
  /** Each further retry waits this many times longer. Default 2. */
  readonly factor?: number;
  /** Upper bound for the computed wait. Default 30_000. A longer `retryAfterMs` on the error still wins. */
  readonly maxMs?: number;
  /** Share of each wait taken off at random, 0 to 1. Default 0.5: a wait is 50% to 100% of the computed one. */
  readonly jitter?: number;
}

export interface RetryPolicy {
  /** Total attempts including the first one. Must be an integer >= 1. */
  readonly maxAttempts: number;
  /** Wait between attempts. Default `{ initialMs: 500, factor: 2, maxMs: 30_000, jitter: 0.5 }`; `false` retries at once. */
  readonly backoff?: false | RetryBackoff;
  /** Whether an error is worth another attempt. Gets the error the node threw. Default: `isRetryable`. */
  readonly retryOn?: (error: unknown) => boolean;
  /**
   * Required on `write` nodes with a retry policy: repeating the node is safe, for example because it passes
   * `ctx.meta.idempotencyKey` to an API that deduplicates.
   */
  readonly idempotent?: boolean;
}

/** Receives the current (deeply frozen) state and returns a brand-new state. */
export type NodeFn<S> = (state: S, ctx: RunContext) => MaybePromise<S>;

export interface NodeMeta {
  /** Free-form label recorded in `enter` events, e.g. "code" or "llm". */
  readonly kind?: string;
  readonly retry?: RetryPolicy;
  readonly effect?: Effect;
}

/** Any function with the `NodeFn` signature is a node. Plugins attach metadata with `defineNode`. */
export type Node<S> = NodeFn<S> & NodeMeta;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface Edge<K extends string> {
  readonly from: K;
  readonly to: K;
}

export interface ConditionalEdge<S, K extends string> {
  readonly from: K;
  /** Pure, synchronous routing function. Put side effects in a node instead. */
  readonly route: (state: NoInfer<S>) => K;
  /** Optional allow-list of targets, checked at build time and at run time. */
  readonly targets?: readonly K[];
}

/** Graph shape. The state schema is passed separately: `createGraph(schema, definition)`. */
export interface GraphDefinition<S, K extends string> {
  readonly start: NoInfer<K>;
  readonly nodes: { readonly [P in K]: Node<NoInfer<S>> };
  readonly edges?: readonly Edge<NoInfer<K>>[];
  readonly conditionalEdges?: readonly ConditionalEdge<S, NoInfer<K>>[];
  readonly endNodes: readonly NoInfer<K>[];
}

export interface RunOptions {
  /** Defaults to a random UUID. */
  readonly runId?: string;
  readonly signal?: AbortSignal;
  /** Upper bound on node executions, guards against unbounded loops. Defaults to 100. */
  readonly maxSteps?: number;
  /**
   * Called synchronously for every appended event, before the run continues. Use it to write
   * the trace to durable storage. If it throws, the run stops with SINK_FAILED.
   */
  readonly onEvent?: (event: TraceEvent) => void;
}

export type ReplayMode = "recorded" | "live";

export interface ReplayOptions<S, K extends string> extends RunOptions {
  /** Replace node implementations for this replay only, e.g. swap a model or mock a tool. */
  readonly overrides?: { readonly [P in K]?: Node<S> };
  /**
   * - `recorded` (default): a non-overridden node reuses its recorded output when it sees
   *   exactly the recorded input state; otherwise it runs live.
   * - `live`: every node runs again.
   * In both modes, values delivered by `resume` are fed to `ctx.interrupt` again when the
   * step sees the recorded input state.
   */
  readonly mode?: ReplayMode;
  /** Let `write` nodes run live. Off by default so a replay never repeats a real side effect. */
  readonly allowWrites?: boolean;
}

export interface ResumeOptions extends Omit<RunOptions, "runId"> {
  /** Required to restart a `write` node that was running when the trace ended. */
  readonly allowWrites?: boolean;
}

/** Where a paused run is waiting. Compare `step` with your latest trace to reject stale answers. */
export interface Pending<K extends string = string> {
  readonly nodeId: K;
  readonly step: number;
  readonly request: unknown;
}

interface RunResultBase<S, K extends string> {
  readonly runId: string;
  /** Final state, or for a paused run the state the waiting node received. */
  readonly state: S;
  readonly trace: Trace;
  /** Node ids in execution order, across pauses. */
  readonly path: readonly K[];
}

export interface CompletedRun<S, K extends string = string> extends RunResultBase<S, K> {
  readonly status: "completed";
}

export interface PausedRun<S, K extends string = string> extends RunResultBase<S, K> {
  readonly status: "paused";
  readonly pending: Pending<K>;
}

export type RunResult<S, K extends string = string> = CompletedRun<S, K> | PausedRun<S, K>;

export interface Graph<S, I, K extends string> {
  readonly start: K;
  readonly nodeIds: readonly K[];
  readonly endNodes: readonly K[];
  run(input: I, options?: RunOptions): Promise<RunResult<S, K>>;
  /** Runs without Promises. Throws ASYNC_IN_SYNC_RUN if a node or the schema returns a Promise. */
  runSync(input: I, options?: RunOptions): RunResult<S, K>;
  /**
   * Continues a trace under the same runId, appending to it.
   * - Paused trace: `value` is returned by the waiting node's `ctx.interrupt`.
   * - Trace that ended without `run_end` (crash): restarts from the last unfinished step; omit `value`.
   */
  resume(trace: Trace, value?: unknown, options?: ResumeOptions): Promise<RunResult<S, K>>;
  resumeSync(trace: Trace, value?: unknown, options?: ResumeOptions): RunResult<S, K>;
  /** Re-runs a recorded trace from its original input under a new runId. */
  replay(trace: Trace, options?: ReplayOptions<S, K>): Promise<RunResult<S, K>>;
}
