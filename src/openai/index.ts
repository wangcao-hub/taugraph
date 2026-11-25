// taugraph/openai: the LLMModel contract on any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, Qwen,
// Kimi, Ollama, vLLM, LM Studio, ...), with tool calling, images and reasoning. A plugin like taugraph/agent: it uses
// the global fetch, or the one you pass, and adds no dependencies.
import type { MaybePromise } from "../index.js";
import {
  type ChatMessage,
  type ImagePart,
  type ImageResolver,
  type LLMModel,
  type MessageContent,
  type ReasoningLevel,
  resolveImages,
  type ToolCall,
  type ToolChoice,
  type ToolSpec,
  textOf,
} from "../nodes/index.js";

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1" for Ollama */
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  /** Reads image URLs OpenAI cannot fetch, e.g. `media:abc` from your store. http(s) and data: URLs go as they are. */
  readonly resolveImage?: ImageResolver | undefined;
  /** Request parameters for a reasoning level, merged before `extra`. Default: `{ reasoning_effort }`, "off" as "none". */
  readonly reasoningParams?: ((level: ReasoningLevel) => Record<string, unknown>) | undefined;
  /**
   * Send a model's own reasoning back as `reasoning_content`. Default true: DeepSeek V4 and Kimi refuse a tool loop
   * without it. Set false for endpoints that refuse the field in input messages, such as Groq and Cerebras.
   */
  readonly sendReasoning?: boolean | undefined;
  /** Used instead of the global `fetch`, e.g. for a proxy, retries or tests. */
  readonly fetch?: typeof fetch | undefined;
}

/** A tool call as OpenAI sends it: arguments are a JSON string. */
export interface OpenAIToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface ChatCompletion {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
      /** DeepSeek, Qwen, Kimi */
      reasoning_content?: string | null;
      /** OpenRouter, Ollama */
      reasoning?: string | null;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const defaultReasoningParams = (level: ReasoningLevel): Record<string, unknown> => ({
  reasoning_effort: level === "off" ? "none" : level,
});

/** A model's own reasoning as `reasoning_content`, which DeepSeek V4 requires back in tool loops. Never another model's. */
function reasoningOf(
  m: Extract<ChatMessage, { role: "assistant" }>,
  modelId: string | undefined,
): Record<string, unknown> {
  if (modelId === undefined || m.model !== modelId || !m.reasoning?.length) return {};
  const text = m.reasoning
    .filter((r) => !r.redacted)
    .map((r) => r.text)
    .join("\n");
  return text === "" ? {} : { reasoning_content: text };
}

/** URLs OpenAI takes as they are. */
const SENDABLE = /^(https?|data):/i;
const shown = (url: string): string => (url.length > 100 ? `${url.slice(0, 100)}…` : url);

function imageURL(image: ImagePart): string {
  if ("data" in image) return `data:${image.mimeType};base64,${image.data}`;
  if (!SENDABLE.test(image.url)) {
    throw new TypeError(
      `Image "${shown(image.url)}" cannot be sent as a URL; make resolveImage return { data, mimeType } or an http(s) URL`,
    );
  }
  return image.url;
}

const imageOf = (image: ImagePart) => ({ type: "image_url", image_url: { url: imageURL(image) } });

const imagesIn = (content: MessageContent): ImagePart[] =>
  typeof content === "string" ? [] : content.filter((p): p is ImagePart => p.type === "image");

/** OpenAI's tool messages take text only, and have no error flag: errors say so in the text. */
function toolText(m: Extract<ChatMessage, { role: "tool" }>): string {
  const text = textOf(m.content, { imagePlaceholder: "" }) || (imagesIn(m.content).length > 0 ? "(image)" : "");
  return m.isError && !text.startsWith("Error") ? `Error: ${text}` : text;
}

/**
 * taugraph messages in OpenAI's wire format. Images from tool results go into one user message right after the
 * tool messages, since OpenAI's tool messages take text only. Image references must be read first (`resolveImage`).
 * Pass the adapter's id as `modelId` to send that model's own reasoning back.
 */
export function toOpenAIMessages(messages: readonly ChatMessage[], modelId?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let toolImages: Record<string, unknown>[] = [];
  const flush = () => {
    if (toolImages.length > 0) out.push({ role: "user", content: toolImages });
    toolImages = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: toolText(m) });
      const images = imagesIn(m.content);
      if (images.length > 0) {
        toolImages.push({ type: "text", text: `Images from tool call ${m.toolCallId}:` }, ...images.map(imageOf));
      }
      continue;
    }
    flush();
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
        ...reasoningOf(m, modelId),
      });
    } else if (m.role === "user" && typeof m.content !== "string") {
      out.push({
        role: "user",
        content: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : imageOf(p))),
      });
    } else {
      out.push({ role: m.role, content: m.content, ...(m.role === "assistant" && reasoningOf(m, modelId)) });
    }
  }
  flush();
  return out;
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

/** OpenAI's tool calls as taugraph's, arguments parsed. Unreadable arguments become `{}` with a `parseError`; missing ids become `call_<round>_<index>`. */
export function fromOpenAIToolCalls(calls: readonly OpenAIToolCall[], round = 1): ToolCall[] {
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
        id: c.id || `call_${round}_${i}`,
        name,
        arguments: isObject && !parseError ? (parsed as Record<string, unknown>) : {},
        ...(parseError && { parseError }),
      },
    ];
  });
}

export function openAICompatible(options: OpenAICompatibleOptions): LLMModel {
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const id = `openai-compatible:${options.model}`;
  const readImage = (image: string): MaybePromise<ImagePart> => {
    if (/^https?:/i.test(image)) return { type: "image", url: image };
    if (!options.resolveImage) throw new TypeError(`Image "${shown(image)}" needs resolveImage to be read`);
    return options.resolveImage(image);
  };
  return {
    id,
    async complete(request, { signal }) {
      const messages = await resolveImages(request.messages, readImage);
      const response = await (options.fetch ?? fetch)(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          messages: toOpenAIMessages(messages, options.sendReasoning === false ? undefined : id),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.responseFormat === "json" && { response_format: { type: "json_object" } }),
          ...(request.tools?.length && { tools: toOpenAITools(request.tools) }),
          ...(request.toolChoice && { tool_choice: toOpenAIToolChoice(request.toolChoice) }),
          ...(request.reasoning && (options.reasoningParams ?? defaultReasoningParams)(request.reasoning)),
          ...request.extra,
        }),
      });
      if (!response.ok) {
        throw new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      const body = (await response.json()) as ChatCompletion;
      const choice = body.choices?.[0];
      const calls = choice?.message?.tool_calls;
      const round = request.messages.filter((m) => m.role === "assistant").length + 1;
      const message = choice?.message;
      const thought = message?.reasoning_content || message?.reasoning;
      const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
      return {
        content: message?.content ?? "",
        ...(body.model && { model: body.model }),
        ...(choice?.finish_reason && { finishReason: choice.finish_reason }),
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ...(typeof reasoningTokens === "number" && { reasoningTokens }),
        },
        ...(thought && { reasoning: [{ text: thought }] }),
        ...(calls?.length && { toolCalls: fromOpenAIToolCalls(calls, round) }),
      };
    },
  };
}
