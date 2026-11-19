// A ~40 line adapter from the LLMModel contract to any OpenAI-compatible
// /chat/completions endpoint: OpenAI, Ollama, vLLM, LM Studio, DeepSeek, ...
// It lives in examples on purpose: taugraph ships no provider code.
import type { LLMModel } from "../../src/nodes/index.js";

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1" for Ollama */
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.responseFormat === "json" && { response_format: { type: "json_object" } }),
          ...request.extra,
        }),
      });
      if (!response.ok) {
        throw new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      const body = (await response.json()) as ChatCompletion;
      const choice = body.choices?.[0];
      return {
        content: choice?.message?.content ?? "",
        ...(body.model && { model: body.model }),
        ...(choice?.finish_reason && { finishReason: choice.finish_reason }),
        usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
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
