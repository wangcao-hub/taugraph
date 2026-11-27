// The model <-> tools loop as a taugraph graph: one step per model call and one step per tool call, so the trace,
// replay, write protection, crash recovery and approvals all apply to every single call.
//
//   think --a call, read-->  act --------+-- more calls --> act / act_write
//     |   --a call, write--> act_write --+-- none left ---> think
//     +--no calls, or maxRounds reached--> finish
import {
  createGraph,
  defineNode,
  type Effect,
  type Graph,
  type MaybePromise,
  type RetryPolicy,
  type RunContext,
  type StandardSchemaV1,
  TaugraphError,
} from "../index.js";
import {
  type ChatMessage,
  type LLMModel,
  LLMNode,
  type MessageContent,
  type ReasoningLevel,
  type ToolCall,
  type ToolChoice,
  type ToolSpec,
} from "../nodes/index.js";
import { type AgentInput, type AgentState, agentStateSchema, checkContent } from "./state.js";
import { andThen, deadline, issuesText, isThenable, settle } from "./util.js";

export { type AgentInput, type AgentState, type AgentStop, agentStateSchema } from "./state.js";

export type ToolArgs = Readonly<Record<string, unknown>>;

export interface ToolContext {
  readonly call: ToolCall;
  readonly signal: AbortSignal;
  /** The step was running when an earlier trace ended and was started again. */
  readonly recovered: boolean;
}

/** A string, or text and images in order (`isError` tells the model the call failed). */
export type ToolResult = string | { readonly content: MessageContent; readonly isError?: boolean };

export interface Tool<A = ToolArgs> {
  readonly name: string;
  readonly description?: string;
  /** Validates the arguments, and becomes the JSON Schema the model sees (Standard JSON Schema). */
  readonly input?: StandardSchemaV1<unknown, A>;
  /** JSON Schema for the model, when `input` cannot produce one or you want your own. Wins over `input`. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** `"write"` for tools that change the outside world: they run in a write step, never repeated by replay. */
  readonly effect?: Effect;
  /**
   * Milliseconds one run may take; then its `signal` aborts. A read tool that takes longer answers the model with an
   * error and the loop goes on. A write tool fails the run with TIMEOUT, since its effect may or may not have
   * happened. Synchronous tools cannot be interrupted.
   */
  readonly timeoutMs?: number;
  run(args: A, ctx: ToolContext): MaybePromise<ToolResult>;
}

/** Defines a tool. Returns it unchanged; it only lets `args` take its type from `input`. */
export function tool<A = ToolArgs>(definition: Tool<A>): Tool<A> {
  return definition;
}

export type ApprovalDecision = "run" | "deny" | "ask";

/** Recorded by the pause when a call waits for approval. Resume with `true`, `false` or `{ approved, reason? }`. */
export interface ToolApprovalRequest {
  readonly type: "tool_approval";
  readonly call: ToolCall;
  readonly effect: Effect;
}

// biome-ignore lint/suspicious/noExplicitAny: each tool has its own argument type
type AnyTool = Tool<any>;

export interface AgentConfig {
  readonly model: LLMModel;
  readonly tools?: readonly AnyTool[];
  readonly system?: string;
  /** Model calls allowed in one run. Default 8. */
  readonly maxRounds?: number;
  /**
   * `"answer"`: the last model call that `maxRounds` allows gets no tools, so the model has to answer in words; tool
   * calls it returns anyway are ignored. Default `"tools"`: every call gets the tools.
   */
  readonly lastRound?: "tools" | "answer";
  readonly toolChoice?: ToolChoice;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** How much the model should think before each answer. Unset: the model's default. */
  readonly reasoning?: ReasoningLevel;
  /** Retries a failed model call. */
  readonly retry?: RetryPolicy;
  /** Milliseconds each model call may take; a slower call fails with TIMEOUT, which `retry` retries. */
  readonly timeoutMs?: number;
  /**
   * Decides each call before it runs: run it, refuse it, or pause and ask (`ctx.interrupt`). Called again when
   * the run resumes, so keep it pure. Without it every call runs.
   */
  readonly approve?: (call: ToolCall, tool: AnyTool, state: AgentState) => ApprovalDecision;
}

export type AgentNodeId = "think" | "act" | "act_write" | "finish";
export type AgentGraph = Graph<AgentState, AgentInput, AgentNodeId>;

export const AGENT_DEFAULTS = Object.freeze({ maxRounds: 8, maxCallsPerReply: 32, maxSteps: 1000 });

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DENIED = "The user did not allow this call";
const TOO_MANY = `Too many tool calls in one reply; at most ${AGENT_DEFAULTS.maxCallsPerReply} run`;
const MAX_TIMEOUT = 2_147_483_647;
const badTimeout = (ms: unknown): boolean =>
  ms !== undefined && !(Number.isInteger(ms) && (ms as number) >= 1 && (ms as number) <= MAX_TIMEOUT);

interface JSONSchemaProps {
  readonly jsonSchema?: { readonly input: (options: { readonly target: string }) => Record<string, unknown> };
}

function inputSchemaOf(t: AnyTool): Readonly<Record<string, unknown>> {
  if (t.inputSchema) return t.inputSchema;
  const converter = (t.input?.["~standard"] as JSONSchemaProps | undefined)?.jsonSchema;
  if (!converter) return { type: "object" };
  try {
    const json = converter.input({ target: "draft-2020-12" });
    return Object.fromEntries(Object.entries(json).filter(([key]) => key !== "$schema"));
  } catch (cause) {
    throw new TypeError(`createAgent: the input schema of tool "${t.name}" has no JSON Schema form; pass inputSchema`, {
      cause,
    });
  }
}

const toolMessage = (id: string, content: MessageContent, isError: boolean): ChatMessage => ({
  role: "tool",
  toolCallId: id,
  content,
  ...(isError && { isError: true }),
});

function lastAnswer(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m.content;
  }
  return "";
}

/** Error answers for the calls of the last assistant message that have none: the ones beyond the per-reply limit. */
function unanswered(messages: readonly ChatMessage[]): ChatMessage[] {
  let i = messages.length - 1;
  while (i >= 0 && messages[i]?.role !== "assistant") i--;
  const last = messages[i];
  if (last?.role !== "assistant" || !last.toolCalls) return [];
  const done = new Set(messages.slice(i + 1).flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  return last.toolCalls.filter((c) => !done.has(c.id)).map((c) => toolMessage(c.id, TOO_MANY, true));
}

function readApproval(answer: unknown): { approved: boolean; reason?: string } {
  if (answer === true) return { approved: true };
  if (typeof answer !== "object" || answer === null) return { approved: false };
  const { approved, reason } = answer as { approved?: unknown; reason?: unknown };
  return { approved: approved === true, ...(typeof reason === "string" && reason !== "" && { reason }) };
}

function resultOf(t: AnyTool, value: unknown): { content: MessageContent; isError: boolean } {
  if (typeof value === "string") return { content: value, isError: false };
  const content = typeof value === "object" && value !== null ? (value as { content?: unknown }).content : undefined;
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new TypeError(`Tool "${t.name}" returned neither a string nor { content: string | ContentPart[] }`);
  }
  const issues: StandardSchemaV1.Issue[] = [];
  checkContent(content, ["content"], issues, true);
  if (issues.length > 0) throw new TypeError(`Tool "${t.name}" returned bad content: ${issuesText(issues)}`);
  return { content: content as MessageContent, isError: (value as { isError?: unknown }).isError === true };
}

/** The model <-> tools loop as a graph. Every model call and every tool call is a step of its own. */
export function createAgent(config: AgentConfig): AgentGraph {
  const tools = new Map<string, AnyTool>();
  for (const t of config.tools ?? []) {
    if (!TOOL_NAME.test(t.name)) throw new TypeError(`createAgent: tool name "${t.name}" must match ${TOOL_NAME}`);
    if (tools.has(t.name)) throw new TypeError(`createAgent: two tools are named "${t.name}"`);
    if (t.effect !== undefined && t.effect !== "read" && t.effect !== "write") {
      throw new TypeError(`createAgent: tool "${t.name}" has effect ${String(t.effect)}; use "read" or "write"`);
    }
    if (badTimeout(t.timeoutMs)) {
      throw new TypeError(
        `createAgent: tool "${t.name}" has timeoutMs ${String(t.timeoutMs)}; use an integer from 1 to ${MAX_TIMEOUT}`,
      );
    }
    tools.set(t.name, t);
  }
  const maxRounds = config.maxRounds ?? AGENT_DEFAULTS.maxRounds;
  if (!Number.isInteger(maxRounds) || maxRounds < 1)
    throw new TypeError("createAgent: maxRounds must be an integer >= 1");
  const lastRound = config.lastRound ?? "tools";
  if (lastRound !== "tools" && lastRound !== "answer") {
    throw new TypeError(`createAgent: lastRound must be "tools" or "answer", got ${String(config.lastRound)}`);
  }
  /** Whether the call made from this state is the last one allowed and must be answered in words. */
  const answerOnly = (s: AgentState) => lastRound === "answer" && s.rounds === maxRounds - 1;
  if (badTimeout(config.timeoutMs)) {
    throw new TypeError(
      `createAgent: timeoutMs must be an integer from 1 to ${MAX_TIMEOUT}, got ${String(config.timeoutMs)}`,
    );
  }
  const specs: ToolSpec[] = [...tools.values()].map((t) => ({
    name: t.name,
    ...(t.description && { description: t.description }),
    inputSchema: inputSchemaOf(t),
  }));

  const callModel = LLMNode<AgentState>({
    model: config.model,
    ...(config.retry && { retry: config.retry }),
    prompt: (s) => ({
      messages: [...(config.system ? [{ role: "system" as const, content: config.system }] : []), ...s.messages],
      ...(!answerOnly(s) && specs.length > 0 && { tools: specs }),
      ...(!answerOnly(s) && config.toolChoice && { toolChoice: config.toolChoice }),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
      ...(config.reasoning && { reasoning: config.reasoning }),
    }),
    update: (s, text, response) => {
      const round = s.rounds + 1;
      // On the answer-only round the model was given no tools; calls it makes anyway are dropped.
      const asked = answerOnly(s) ? [] : (response.toolCalls ?? []);
      const calls = asked.map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
      const run = calls.slice(0, AGENT_DEFAULTS.maxCallsPerReply);
      const assistant: ChatMessage = {
        role: "assistant",
        content: text,
        ...(calls.length > 0 && { toolCalls: calls }),
        ...(response.reasoning?.length && { reasoning: response.reasoning }),
        model: config.model.id, // signatures are only valid for the model that wrote them
      };
      return {
        ...s,
        messages: [...s.messages, assistant],
        pending: run,
        rounds: round,
        final: run.length === 0 ? text : null,
        stop: run.length === 0 ? "done" : null,
      };
    },
  });

  const think = defineNode<AgentState>(
    (s, ctx) => {
      if (s.pending.length > 0) return s; // calls left from where an earlier run stopped: run them first
      if (s.rounds >= maxRounds) return { ...s, stop: "max_rounds", final: lastAnswer(s.messages) };
      return callModel(s, ctx);
    },
    {
      kind: "llm",
      ...(config.retry && { retry: config.retry }),
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
    },
  );

  /** Runs `pending[0]`. Everything before the tool runs is pure, so re-running the step on resume is safe. */
  const act = (effect: Effect) =>
    defineNode<AgentState>(
      (s, ctx: RunContext): MaybePromise<AgentState> => {
        const call = s.pending[0];
        if (!call) return s;
        const answered = (content: MessageContent, isError: boolean): AgentState => {
          const messages = [...s.messages, toolMessage(call.id, content, isError)];
          // after the last call that runs, answer the ones beyond the per-reply limit, so they come last
          return {
            ...s,
            messages: s.pending.length === 1 ? [...messages, ...unanswered(messages)] : messages,
            pending: s.pending.slice(1),
          };
        };
        const t = tools.get(call.name);
        if (!t) return answered(`No tool named "${call.name}"`, true);
        if (call.parseError) return answered(`Invalid arguments: ${call.parseError}`, true);
        const checked = t.input ? t.input["~standard"].validate(call.arguments) : { value: call.arguments };
        return andThen(checked, (result): MaybePromise<AgentState> => {
          if (result.issues) return answered(`Invalid arguments: ${issuesText(result.issues)}`, true);
          const decision = config.approve?.(call, t, s) ?? "run";
          if (decision === "deny") return answered(DENIED, true);
          if (decision === "ask") {
            const request: ToolApprovalRequest = { type: "tool_approval", call, effect };
            const { approved, reason } = readApproval(ctx.interrupt<unknown>(request));
            if (!approved) return answered(reason ? `${DENIED}: ${reason}` : DENIED, true);
          }
          const startedAt = Date.now();
          const record = (content: MessageContent, isError: boolean, failed: boolean): AgentState => {
            ctx.trace.append({
              type: "tool_call",
              input: { id: call.id, name: call.name, arguments: call.arguments },
              output: { content, isError },
              meta: { effect, durationMs: Date.now() - startedAt, ...(failed && { error: true }) },
            });
            return answered(content, isError);
          };
          const limit =
            t.timeoutMs === undefined
              ? undefined
              : deadline(
                  ctx.signal,
                  t.timeoutMs,
                  new TaugraphError("TIMEOUT", `Tool "${call.name}" timed out after ${t.timeoutMs}ms`),
                );
          return settle(
            () => {
              const signal = limit?.signal ?? ctx.signal;
              const value = t.run(result.value, { call, signal, recovered: ctx.meta.recovered });
              return limit && isThenable(value) ? limit.race(value) : value;
            },
            (value) => {
              limit?.dispose();
              const { content, isError } = resultOf(t, value);
              return record(content, isError, false);
            },
            (error) => {
              limit?.dispose();
              if (ctx.signal.aborted) throw error; // a cancelled run stops; it is not the tool's answer
              if (limit && error === limit.error) {
                if (effect === "write") throw error; // the write may or may not have happened: fail, do not guess
                return record(limit.error.message, true, true);
              }
              return record(String(error instanceof Error ? `Error: ${error.message}` : error), true, true);
            },
          );
        });
      },
      { kind: "tool", ...(effect === "write" && { effect }) },
    );

  const next = (s: AgentState): AgentNodeId => {
    const call = s.pending[0];
    if (call) return tools.get(call.name)?.effect === "write" ? "act_write" : "act";
    return s.stop ? "finish" : "think";
  };

  const graph = createGraph(agentStateSchema, {
    start: "think",
    nodes: {
      think,
      act: act("read"),
      act_write: act("write"),
      finish: defineNode<AgentState>((s) => s, { kind: "code" }),
    },
    conditionalEdges: [
      { from: "think", route: next, targets: ["act", "act_write", "finish"] },
      { from: "act", route: next, targets: ["act", "act_write", "think"] },
      { from: "act_write", route: next, targets: ["act", "act_write", "think"] },
    ],
    endNodes: ["finish"],
  });

  // maxRounds is the real bound; the kernel's step guard only has to leave room for every call of every round.
  const steps = <O extends { readonly maxSteps?: number }>(options?: O): O =>
    ({ ...options, maxSteps: options?.maxSteps ?? AGENT_DEFAULTS.maxSteps }) as O;
  return Object.freeze({
    start: graph.start,
    nodeIds: graph.nodeIds,
    endNodes: graph.endNodes,
    run: (input, options) => graph.run(input, steps(options)),
    runSync: (input, options) => graph.runSync(input, steps(options)),
    resume: (trace, value, options) => graph.resume(trace, value, steps(options)),
    resumeSync: (trace, value, options) => graph.resumeSync(trace, value, steps(options)),
    replay: (trace, options) => graph.replay(trace, steps(options)),
  } satisfies AgentGraph);
}
