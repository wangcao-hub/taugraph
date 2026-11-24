// A small adapter from the LLMModel contract to any OpenAI-compatible /chat/completions endpoint:
// OpenAI, Ollama, vLLM, LM Studio, DeepSeek, ... including tool calling.
// It lives in examples on purpose: taugraph ships no provider code.
import type { ChatMessage, LLMModel, ToolCall, ToolChoice, ToolSpec } from "../../src/nodes/index.js";

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1" for Ollama */
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
}

/** A tool call as OpenAI sends it: arguments are a JSON string. */
export interface OpenAIToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** taugraph messages in OpenAI's wire format. */
export function toOpenAIMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAITools(tools: readonly ToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, ...(t.description && { description: t.description }), parameters: t.inputSchema },
  }));
}

export function toOpenAIToolChoice(choice: ToolChoice): unknown {
  return typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
}

/** OpenAI's tool calls as taugraph's, arguments parsed. Unreadable arguments become `{}` with a `parseError`. */
export function fromOpenAIToolCalls(calls: readonly OpenAIToolCall[]): ToolCall[] {
  return calls.flatMap((c, i) => {
    const name = c.function?.name;
    if (!name) return [];
    const raw = c.function?.arguments ?? "";
    let parsed: unknown = {};
    let parseError: string | undefined;
    if (raw.trim() !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseError = "arguments are not valid JSON";
      }
    }
    const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    if (!parseError && !isObject) parseError = "arguments are not a JSON object";
    return [
      {
        id: c.id || `call_${i}`,
        name,
        arguments: isObject && !parseError ? (parsed as Record<string, unknown>) : {},
        ...(parseError && { parseError }),
      },
    ];
  });
}

export function openAICompatible(options: OpenAICompatibleOptions): LLMModel {
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  return {
    id: `openai-compatible:${options.model}`,
    async complete(request, { signal }) {
      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          messages: toOpenAIMessages(request.messages),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.responseFormat === "json" && { response_format: { type: "json_object" } }),
          ...(request.tools?.length && { tools: toOpenAITools(request.tools) }),
          ...(request.toolChoice && { tool_choice: toOpenAIToolChoice(request.toolChoice) }),
          ...request.extra,
        }),
      });
      if (!response.ok) {
        throw new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      const body = (await response.json()) as ChatCompletion;
      const choice = body.choices?.[0];
      const calls = choice?.message?.tool_calls;
      return {
        content: choice?.message?.content ?? "",
        ...(body.model && { model: body.model }),
        ...(choice?.finish_reason && { finishReason: choice.finish_reason }),
        usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
        ...(calls?.length && { toolCalls: fromOpenAIToolCalls(calls) }),
      };
    },
  };
}

/** Uses TAUGRAPH_BASE_URL / TAUGRAPH_MODEL / TAUGRAPH_API_KEY when set, otherwise returns undefined. */
export function modelFromEnv(): LLMModel | undefined {
  const { TAUGRAPH_BASE_URL: baseURL, TAUGRAPH_MODEL: model, TAUGRAPH_API_KEY: apiKey } = process.env;
  if (!baseURL || !model) return undefined;
  return openAICompatible({ baseURL, model, ...(apiKey && { apiKey }) });
}
