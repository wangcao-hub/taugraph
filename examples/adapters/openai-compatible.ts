// The OpenAI-compatible adapter ships as `taugraph/openai`. The examples import it from here, together with a helper
// that reads the endpoint from the environment.
import type { LLMModel } from "../../src/nodes/index.js";
import { openAICompatible } from "../../src/openai/index.js";

export * from "../../src/openai/index.js";

/** Uses TAUGRAPH_BASE_URL / TAUGRAPH_MODEL / TAUGRAPH_API_KEY when set, otherwise returns undefined. */
export function modelFromEnv(): LLMModel | undefined {
  const { TAUGRAPH_BASE_URL: baseURL, TAUGRAPH_MODEL: model, TAUGRAPH_API_KEY: apiKey } = process.env;
  if (!baseURL || !model) return undefined;
  return openAICompatible({ baseURL, model, ...(apiKey && { apiKey }) });
}
