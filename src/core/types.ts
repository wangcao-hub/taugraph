export type MaybePromise<T> = T | PromiseLike<T>;

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/** Event types written by the kernel. Nodes cannot append these. */
export type KernelEventType = "run_start" | "enter" | "exit" | "error" | "run_end";

/** Event types reserved by convention for plugin nodes. */
export type PluginEventType = "llm_call" | "tool_call" | "human_pause";

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

/** A full run transcript. Serialize it with `toJSONL` and replay it with `graph.replay`. */
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

export interface RunContext {
  readonly meta: {
    readonly runId: string;
    readonly nodeId: string;
    readonly step: number;
    /** 1-based attempt number when the node has a retry policy. */
    readonly attempt: number;
  };
  /** Aborted when the caller cancels the run. Pass it to fetch / model clients. */
  readonly signal: AbortSignal;
  readonly trace: {
    /** Append a side-effect record (llm_call, tool_call, ...) to the transcript. */
    append(event: PluginEvent): void;
  };
}

export interface RetryPolicy {
  /** Total attempts including the first one. Must be an integer >= 1. */
  readonly maxAttempts: number;
}

/** Receives the current (deeply frozen) state and returns a brand-new state. */
export type NodeFn<S> = (state: S, ctx: RunContext) => MaybePromise<S>;

export interface NodeMeta {
  /** Free-form label recorded in `enter` events, e.g. "code" or "llm". */
  readonly kind?: string;
  readonly retry?: RetryPolicy;
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
  /** Called synchronously for every appended event. Use it to stream the trace to a sink. */
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
   */
  readonly mode?: ReplayMode;
}

export interface RunResult<S, K extends string = string> {
  readonly runId: string;
  readonly state: S;
  readonly trace: Trace;
  /** Node ids in execution order. */
  readonly path: readonly K[];
}

export interface Graph<S, I, K extends string> {
  readonly start: K;
  readonly nodeIds: readonly K[];
  readonly endNodes: readonly K[];
  run(input: I, options?: RunOptions): Promise<RunResult<S, K>>;
  /** Runs without Promises. Throws ASYNC_IN_SYNC_RUN if a node or the schema returns a Promise. */
  runSync(input: I, options?: RunOptions): RunResult<S, K>;
  /** Re-runs a recorded trace from its original input. */
  replay(trace: Trace, options?: ReplayOptions<S, K>): Promise<RunResult<S, K>>;
}
