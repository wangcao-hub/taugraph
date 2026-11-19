import { defineNode, type MaybePromise, type Node, type RetryPolicy, type StandardSchemaV1 } from "../index.js";

// ---------------------------------------------------------------------------
// Model contract. taugraph ships no provider; adapt any SDK or HTTP API to this.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Everything in a request is recorded in the trace, so keep it plain JSON. */
export interface LLMRequest {
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Hint for adapters that support JSON mode. */
  readonly responseFormat?: "text" | "json";
  /** Provider-specific options, passed through by the adapter. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface LLMResponse {
  readonly content: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface LLMModel {
  /** Recorded in every `llm_call` event, e.g. "openai:gpt-4o-mini" or "ollama:qwen3". */
  readonly id: string;
  complete(request: LLMRequest, options: { readonly signal: AbortSignal }): MaybePromise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// LLMNode
// ---------------------------------------------------------------------------

interface LLMNodeBase<S> {
  readonly model: LLMModel;
  /** Builds the request from state. A string becomes a single user message. */
  readonly prompt: (state: S) => LLMRequest | string;
  /** Retries the whole call, including output parsing. */
  readonly retry?: RetryPolicy;
}

export interface LLMTextNodeConfig<S> extends LLMNodeBase<S> {
  /** Folds the reply into state. The return type does not drive inference; the graph does. */
  readonly update: (state: S, text: string, response: LLMResponse) => NoInfer<S>;
}

export interface LLMStructuredNodeConfig<S, T> extends LLMNodeBase<S> {
  /** Parses the response content as JSON (code fences allowed) and validates it. */
  readonly output: StandardSchemaV1<unknown, T>;
  readonly update: (state: S, data: T, response: LLMResponse) => NoInfer<S>;
}

/** Thrown when structured output is not JSON or fails its schema. Retryable. */
export class LLMOutputError extends Error {
  override readonly name = "LLMOutputError";
  constructor(
    message: string,
    readonly content: string,
    readonly issues?: readonly StandardSchemaV1.Issue[],
  ) {
    super(message);
  }
}

/**
 * Calls a model and folds the result into state. Every call is appended to the trace
 * as an `llm_call` event (request in `input`, response in `output`).
 * Stays synchronous when the model does, so mock models work with `runSync`.
 */
export function LLMNode<S, T>(config: LLMStructuredNodeConfig<S, T>): Node<S>;
export function LLMNode<S>(config: LLMTextNodeConfig<S>): Node<S>;
export function LLMNode<S, T>(config: LLMTextNodeConfig<S> | LLMStructuredNodeConfig<S, T>): Node<S> {
  const { model, prompt } = config;
  return defineNode<S>(
    (state, ctx) => {
      const built = prompt(state);
      const request: LLMRequest = typeof built === "string" ? { messages: [{ role: "user", content: built }] } : built;
      const startedAt = Date.now();

      return then(model.complete(request, { signal: ctx.signal }), (response) => {
        if (typeof response?.content !== "string") {
          throw new TypeError(`Model "${model.id}" returned a response without a string \`content\``);
        }
        ctx.trace.append({
          type: "llm_call",
          input: request,
          output: response,
          meta: { model: model.id, durationMs: Date.now() - startedAt },
        });
        if (!("output" in config)) return config.update(state, response.content, response);
        return then(parseStructured(config.output, response.content), (data) => config.update(state, data, response));
      });
    },
    { kind: "llm", ...(config.retry && { retry: config.retry }) },
  );
}

function parseStructured<T>(schema: StandardSchemaV1<unknown, T>, content: string): MaybePromise<T> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const text = (fenced?.[1] ?? content).trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LLMOutputError("Model output is not valid JSON", content);
  }
  return then(schema["~standard"].validate(json), (result) => {
    if (result.issues) {
      const detail = result.issues.map((issue) => issue.message).join("; ");
      throw new LLMOutputError(`Model output does not match the schema: ${detail}`, content, result.issues);
    }
    return result.value;
  });
}

function then<A, B>(value: MaybePromise<A>, fn: (value: A) => MaybePromise<B>): MaybePromise<B> {
  if (value !== null && typeof value === "object" && typeof (value as PromiseLike<A>).then === "function") {
    return Promise.resolve(value).then(fn);
  }
  return fn(value as A);
}
