# Reasoning Models — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reasoning level on requests, what the model thought (with signatures) on replies, and a tool loop that sends a model's own thinking back to it, as DeepSeek V4, Claude and Gemini 3 require.

**Architecture:** Optional fields in the model contract (`src/nodes/llm.ts`). The agent passes `reasoning` to every call and stores `reasoning` and `model` on the assistant messages it writes; its state schema checks them. Adapters map the level, read the thinking, and send reasoning and signatures back only when `m.model` is their own `id`.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, Zod in tests only, biome.

Spec: `docs/superpowers/specs/2026-11-24-reasoning-design.md`.

## Global Constraints

- Zero runtime dependencies; `src/core` untouched; `src/nodes` imports only `../index.js` and `./*.js`; `src/agent` imports only `../index.js`, `../nodes/index.js` and `./*.js`.
- Only optional fields are added; no existing field changes type; `TRACE_VERSION` unchanged.
- `ReasoningLevel` is exactly `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- An unset `reasoning` means the adapter sends no reasoning parameter at all.
- Signatures, `redacted` parts and `ToolCall.signature` go back only when the assistant message's `model` equals the adapter's `id`.
- Library text and code comments in English.
- `pnpm check` (typecheck + biome + vitest) must pass in every repo touched; `pnpm format` fixes formatting; Markdown goes through `pnpm exec biome check --write <file>`.
- taugraph work is on branch `feat/reasoning` (spec committed as `5283eb3`). Sibling work continues on each sibling's existing `feat/images` branch; their `package.json` and `pnpm-lock.yaml` are not committed.

---

### Task 1: Reasoning in the model contract

**Files:**

- Modify: `src/nodes/llm.ts`, `src/nodes/index.ts`
- Test: `test/types.test.ts`

**Interfaces:**

- Produces (exported from `taugraph/nodes`): `type ReasoningLevel`, `interface ReasoningPart { text: string; signature?: string; redacted?: boolean }`; new optional fields `LLMRequest.reasoning?: ReasoningLevel`, `LLMResponse.reasoning?: readonly ReasoningPart[]`, `LLMResponse.usage.reasoningTokens?: number`, `ToolCall.signature?: string`, and on the assistant variant of `ChatMessage`: `reasoning?: readonly ReasoningPart[]`, `model?: string`.

- [ ] **Step 1: Write the failing type test.** In `test/types.test.ts`, extend the nodes import with `type LLMRequest, type LLMResponse, type ReasoningLevel, type ReasoningPart`, and add after "lets user and tool messages carry images, ...":

```ts
it("describes reasoning in requests, replies and messages", () => {
  const parts: ReasoningPart[] = [
    { text: "hmm", signature: "sig" },
    { text: "", signature: "enc", redacted: true },
  ];
  const request: LLMRequest = { messages: [], reasoning: "max" };
  const response: LLMResponse = {
    content: "",
    reasoning: parts,
    usage: { outputTokens: 10, reasoningTokens: 7 },
    toolCalls: [{ id: "c1", name: "t", arguments: {}, signature: "ts" }],
  };
  const message: ChatMessage = { role: "assistant", content: "", reasoning: parts, model: "m" };
  // @ts-expect-error not a reasoning level
  const wrong: LLMRequest = { messages: [], reasoning: "ultra" };
  expectTypeOf<ReasoningLevel>().toEqualTypeOf<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">();
  void [request, response, message, wrong];
});
```

- [ ] **Step 2: Run it to see it fail.**

Run: `pnpm typecheck`
Expected: FAIL, `ReasoningLevel` / `ReasoningPart` are not exported and the new fields do not exist.

- [ ] **Step 3: Add the types.** In `src/nodes/llm.ts`:
  - Add to `ToolCall`, after `parseError`:

```ts
  /** The provider's opaque proof for this call (Gemini's thought signature). Send it back to the same model only. */
  readonly signature?: string;
```

- Add after the `ToolChoice` type:

```ts
/** How much a model should think before it answers. Adapters map it to the provider's setting, rounding to the nearest level the model has. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What a model thought before answering, in the order it gave. `signature` is the provider's opaque proof and is only
 * valid for the model that wrote it: adapters send it back when the assistant message's `model` is their own `id`.
 */
export interface ReasoningPart {
  readonly text: string;
  readonly signature?: string;
  /** The provider hid the text (a safety filter); `signature` holds the encrypted payload. */
  readonly redacted?: boolean;
}
```

- Replace the assistant variant of `ChatMessage` with:

```ts
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
      /** What the model thought first. */
      readonly reasoning?: readonly ReasoningPart[];
      /** The `LLMModel.id` that wrote this message; adapters send reasoning signatures back only to the same model. */
      readonly model?: string;
    }
```

- Add to `LLMRequest`, after `toolChoice`:

```ts
  /** How much the model should think first. Unset: the adapter sends nothing and the model uses its default. */
  readonly reasoning?: ReasoningLevel;
```

- In `LLMResponse`, replace the `usage` line with:

```ts
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /** Tokens spent thinking; already counted in `outputTokens`. */
    readonly reasoningTokens?: number;
  };
```

and add after `toolCalls`:

```ts
  /** What the model thought before answering, in order. */
  readonly reasoning?: readonly ReasoningPart[];
```

- [ ] **Step 4: Export them.** In `src/nodes/index.ts`, add `type ReasoningLevel,` and `type ReasoningPart,` to the `./llm.js` export list.

- [ ] **Step 5: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/nodes test/types.test.ts
git commit -m "feat(nodes): reasoning level, reasoning parts and signatures in the model contract"
```

---

### Task 2: The agent asks for a level and keeps the thinking

**Files:**

- Modify: `src/agent/index.ts` (`AgentConfig`, `callModel`'s `prompt` and `update`)
- Modify: `src/agent/state.ts` (`checkCall`, `checkMessage`, new `checkReasoning`)
- Test: `test/agent.test.ts`

**Interfaces:**

- Consumes: `ReasoningLevel`, `ReasoningPart` (Task 1).
- Produces: `AgentConfig.reasoning?: ReasoningLevel`. Every assistant message the agent writes has `model: config.model.id`, and `reasoning` when the reply had a non-empty `reasoning`.

- [ ] **Step 1: Write the failing tests.** In `test/agent.test.ts`:
  - In "runs a read tool, records it, and hands the result back to the model", the two assistant messages in the `state.messages` expectation get `model: "mock:agent"`:

```ts
      { role: "assistant", content: "", toolCalls: [call("c1", "weather", { city: "南京" })], model: "mock:agent" },
      { role: "tool", toolCallId: "c1", content: "南京: 晴，-2~5°C" },
      { role: "assistant", content: "南京晴", model: "mock:agent" },
```

- Add inside `describe("createAgent")`:

```ts
it("asks for the reasoning level and keeps what the model thought, with signatures, for the next round", async () => {
  const thought = [{ text: "need the weather first", signature: "sig-1" }];
  const signed = { ...call("c1", "weather", { city: "南京" }), signature: "ts-1" };
  const model = scripted([
    { content: "", reasoning: thought, toolCalls: [signed] },
    { content: "南京晴", reasoning: [] },
  ]);
  const { state } = await createAgent({ model, tools: [weather], reasoning: "high" }).run(ask("南京天气"));
  expect(model.requests.map((r) => r.reasoning)).toEqual(["high", "high"]);
  const first = { role: "assistant", content: "", toolCalls: [signed], reasoning: thought, model: "mock:agent" };
  expect(state.messages[1]).toEqual(first);
  expect(model.requests[1]?.messages[1]).toEqual(first);
  expect(state.messages[3]).toEqual({ role: "assistant", content: "南京晴", model: "mock:agent" });
  const plain = scripted([{ content: "hi" }]);
  await createAgent({ model: plain }).run(ask("x"));
  expect(plain.requests[0]).not.toHaveProperty("reasoning");
});

it("records which model wrote each message, so a replay with another model can leave old signatures out", async () => {
  const a = scripted([
    {
      content: "",
      reasoning: [{ text: "t", signature: "sig-a" }],
      toolCalls: [call("c1", "weather", { city: "南京" })],
    },
    { content: "晴" },
  ]);
  const { trace } = await createAgent({ model: a, tools: [weather] }).run(ask("南京天气"));
  const b = { ...scripted([{ content: "雨" }]), id: "mock:other" };
  const rainy = (s: AgentState): AgentState => ({
    ...s,
    messages: [...s.messages, { role: "tool", toolCallId: "c1", content: "南京: 雨" }],
    pending: [],
  });
  const replayed = await createAgent({ model: b, tools: [weather] }).replay(trace, { overrides: { act: rainy } });
  expect(b.requests[0]?.messages[1]).toMatchObject({
    role: "assistant",
    model: "mock:agent",
    reasoning: [{ text: "t", signature: "sig-a" }],
  });
  expect(replayed.state.messages.at(-1)).toEqual({ role: "assistant", content: "雨", model: "mock:other" });
});
```

(Import `type AgentState` from `../src/agent/index.js` if it is not imported yet.)

- Add inside `describe("agentStateSchema")`:

```ts
it("checks reasoning, the writing model and signatures", () => {
  const bad = agentStateSchema["~standard"].validate({
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "t", arguments: {}, signature: 3 }],
        model: 1,
        reasoning: [{ text: 1 }, { text: "", signature: 2, redacted: "yes" }, null],
      },
      { role: "assistant", content: "", reasoning: "thought" },
    ],
    pending: [{ id: "c1", name: "t", arguments: {}, signature: false }],
  });
  expect("issues" in bad && bad.issues?.map((i) => [i.path, i.message])).toEqual([
    [["messages", 0, "toolCalls", 0, "signature"], "expected a string"],
    [["messages", 0, "model"], "expected a string"],
    [["messages", 0, "reasoning", 0, "text"], "expected a string"],
    [["messages", 0, "reasoning", 1, "signature"], "expected a string"],
    [["messages", 0, "reasoning", 1, "redacted"], "expected a boolean"],
    [["messages", 0, "reasoning", 2], "expected a reasoning part object"],
    [["messages", 1, "reasoning"], "expected an array"],
    [["pending", 0, "signature"], "expected a string"],
  ]);
});
```

- [ ] **Step 2: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/agent.test.ts`
Expected: FAIL. Assistant messages have no `model`, `reasoning` is not passed or kept, and the schema accepts the bad fields.

- [ ] **Step 3: Pass the level and keep the thinking.** In `src/agent/index.ts`:
  - Add `type ReasoningLevel,` to the `../nodes/index.js` import.
  - Add to `AgentConfig`, after `maxTokens`:

```ts
  /** How much the model should think before each answer. Unset: the model's default. */
  readonly reasoning?: ReasoningLevel;
```

- In `callModel`'s `prompt`, add after the `maxTokens` line:
  `...(config.reasoning && { reasoning: config.reasoning }),`
- In `callModel`'s `update`, replace the `assistant` constant with:

```ts
const assistant: ChatMessage = {
  role: "assistant",
  content: text,
  ...(calls.length > 0 && { toolCalls: calls }),
  ...(response.reasoning?.length && { reasoning: response.reasoning }),
  model: config.model.id, // signatures are only valid for the model that wrote them
};
```

- [ ] **Step 4: Check the new fields in the state schema.** In `src/agent/state.ts`:
  - In `checkCall`, add after the `parseError` check:

```ts
if (value.signature !== undefined && typeof value.signature !== "string")
  issues.push({ message: "expected a string", path: [...path, "signature"] });
```

- Add above `checkMessage`:

```ts
function checkReasoning(value: unknown, path: Path, issues: Issue[]): void {
  if (!isObject(value)) {
    issues.push({ message: "expected a reasoning part object", path });
    return;
  }
  if (typeof value.text !== "string") issues.push({ message: "expected a string", path: [...path, "text"] });
  if (value.signature !== undefined && typeof value.signature !== "string")
    issues.push({ message: "expected a string", path: [...path, "signature"] });
  if (value.redacted !== undefined && typeof value.redacted !== "boolean")
    issues.push({ message: "expected a boolean", path: [...path, "redacted"] });
}
```

- In `checkMessage`, right after the existing `if (role === "assistant" && value.toolCalls !== undefined) { ... }` block, add:

```ts
if (role === "assistant") {
  if (value.model !== undefined && typeof value.model !== "string")
    issues.push({ message: "expected a string", path: [...path, "model"] });
  if (value.reasoning !== undefined) {
    if (!Array.isArray(value.reasoning)) issues.push({ message: "expected an array", path: [...path, "reasoning"] });
    else for (const [i, r] of value.reasoning.entries()) checkReasoning(r, [...path, "reasoning", i], issues);
  }
}
```

- [ ] **Step 5: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS. If another existing test compares whole assistant messages written by the agent, add `model: "mock:agent"` to its expectation and list it in the report.

Run: `pnpm example:agent`
Expected: still ends with `replay equal: true`.

- [ ] **Step 6: Commit.**

```bash
git add src/agent test/agent.test.ts
git commit -m "feat(agent): reasoning level per run; keep the model's thinking and who wrote each message"
```

---

### Task 3: Reasoning in the OpenAI-compatible example adapter

**Files:**

- Modify: `examples/adapters/openai-compatible.ts`
- Test: `test/adapter.test.ts`

**Interfaces:**

- Consumes: `ReasoningLevel` (Task 1); assistant messages carry `reasoning` and `model` (Task 2).
- Produces: `OpenAICompatibleOptions.reasoningParams?: (level: ReasoningLevel) => Record<string, unknown>`; `toOpenAIMessages(messages, modelId?: string)`, which sends an assistant message's reasoning as `reasoning_content` only when `m.model === modelId`.

- [ ] **Step 1: Write the failing tests.** Add inside `describe("OpenAI-compatible adapter")` in `test/adapter.test.ts` (the `fn` helper from earlier tests is in scope):

```ts
it("asks for a reasoning level, reads what the model thought, and sends its own reasoning back", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({
      choices: [{ message: { content: "好", reasoning_content: "先想想" } }],
      usage: { prompt_tokens: 1, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 7 } },
    });
  });
  const signal = new AbortController().signal;
  const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
  const mine = {
    role: "assistant" as const,
    content: "a",
    model: "openai-compatible:m",
    reasoning: [{ text: "one" }, { text: "", signature: "x", redacted: true }, { text: "two" }],
  };
  const theirs = { role: "assistant" as const, content: "b", model: "other", reasoning: [{ text: "secret" }] };
  const unknown = { role: "assistant" as const, content: "c", reasoning: [{ text: "?" }] };
  const response = await model.complete(
    { messages: [{ role: "user", content: "q" }, mine, theirs, unknown], reasoning: "off" },
    { signal },
  );
  expect(bodies[0]?.reasoning_effort).toBe("none");
  expect(bodies[0]?.messages).toEqual([
    { role: "user", content: "q" },
    { role: "assistant", content: "a", reasoning_content: "one\ntwo" },
    { role: "assistant", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  expect(response.reasoning).toEqual([{ text: "先想想" }]);
  expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 9, reasoningTokens: 7 });
  await model.complete({ messages: [{ role: "user", content: "q" }], reasoning: "high" }, { signal });
  expect(bodies[1]?.reasoning_effort).toBe("high");
  await model.complete({ messages: [{ role: "user", content: "q" }] }, { signal });
  expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  expect(
    toOpenAIMessages(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "t", arguments: {} }],
          reasoning: [{ text: "r" }],
          model: "me",
        },
      ],
      "me",
    ),
  ).toEqual([{ role: "assistant", content: null, tool_calls: [fn("c1", "t")], reasoning_content: "r" }]);
});

it("takes reasoning parameters for providers with their own switch, and reads the reasoning field", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({ choices: [{ message: { content: "好", reasoning: "thinking" } }] });
  });
  const signal = new AbortController().signal;
  const model = openAICompatible({
    baseURL: "http://x/v1",
    model: "m",
    reasoningParams: (level) =>
      level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" } },
  });
  const response = await model.complete({ messages: [{ role: "user", content: "q" }], reasoning: "off" }, { signal });
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(response.reasoning).toEqual([{ text: "thinking" }]);
  await model.complete(
    { messages: [{ role: "user", content: "q" }], reasoning: "off", extra: { thinking: { type: "enabled" } } },
    { signal },
  );
  expect(body.thinking).toEqual({ type: "enabled" }); // extra wins
});
```

- [ ] **Step 2: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/adapter.test.ts`
Expected: FAIL. No `reasoning_effort` is sent, no reasoning is read, and `toOpenAIMessages` takes no model id.

- [ ] **Step 3: Implement.** In `examples/adapters/openai-compatible.ts`:
  - First comment line: `... including tool calling, images and reasoning.`
  - Add `type ReasoningLevel,` to the `../../src/nodes/index.js` import.
  - Add to `OpenAICompatibleOptions`:

```ts
  /** Request parameters for a reasoning level, merged before `extra`. Default: `{ reasoning_effort }`, "off" as "none". */
  readonly reasoningParams?: (level: ReasoningLevel) => Record<string, unknown>;
```

- Replace the `ChatCompletion` interface with:

```ts
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
```

- `toOpenAIMessages`: change the signature to `export function toOpenAIMessages(messages: readonly ChatMessage[], modelId?: string): Record<string, unknown>[] {`; add this sentence to its doc comment: "Pass the adapter's id as `modelId` to send that model's own reasoning back."; add `...reasoningOf(m, modelId),` as the last property of the object pushed for an assistant message with tool calls; and change the final `else` branch to:

```ts
    } else {
      out.push({ role: m.role, content: m.content, ...(m.role === "assistant" && reasoningOf(m, modelId)) });
    }
```

- In `openAICompatible`: add the line below after `const url = ...`; use `id,` in the returned object; send `messages: toOpenAIMessages(messages, id),`; and add the spread shown after it just before `...request.extra,` in the body.

```ts
const id = `openai-compatible:${options.model}`;
```

```ts
          ...(request.reasoning && (options.reasoningParams ?? defaultReasoningParams)(request.reasoning)),
```

After the response is parsed, replace the returned object with:

```ts
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
          ...(reasoningTokens !== undefined && { reasoningTokens }),
        },
        ...(thought && { reasoning: [{ text: thought }] }),
        ...(calls?.length && { toolCalls: fromOpenAIToolCalls(calls, round) }),
      };
```

(keep `const calls = choice?.message?.tool_calls;` and `const round = ...` above it.)

- [ ] **Step 4: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add examples/adapters/openai-compatible.ts test/adapter.test.ts
git commit -m "feat(examples): reasoning level, reasoning replies and passback in the OpenAI-compatible adapter"
```

---

### Task 4: Documentation

**Files:**

- Modify: `README.md`, `README.zh-CN.md`, `docs/trace-format.md`, `docs/design.md`, `CHANGELOG.md`

**Interfaces:**

- Consumes: names from Tasks 1–3 exactly as written there.

- [ ] **Step 1: README.md.** Insert a new section right after the Images section, before `## Integrations`:

````md
## Reasoning models

`reasoning` on a request says how much the model should think first: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"`. Leave it out and the adapter sends nothing, so the model uses its default. Adapters map the level to the provider's setting and round to the nearest level the model has; for providers that take a token budget, the adapter turns levels into budgets.

```ts
const agent = createAgent({ model, tools, reasoning: "high" }); // every model call in the run
```

- Replies carry what the model thought in `response.reasoning` (`{ text, signature?, redacted? }[]`) and its token count in `usage.reasoningTokens`, which is part of `outputTokens`. Both are in the `llm_call` event.
- Some providers refuse the next request of a tool loop unless the model's earlier thinking comes back unchanged: DeepSeek V4 (`reasoning_content`), Claude (signed thinking blocks) and Gemini 3 (a `thoughtSignature` on each tool call, kept in `ToolCall.signature`). The agent stores reasoning and signatures in the assistant messages it writes, so the next round sends them.
- A signature is only valid for the model that wrote it, so every assistant message the agent writes records `model`, the `LLMModel.id`. Adapters send reasoning and signatures back only when `m.model` is their own `id`, so a replay that swaps the model never sends one model's signatures to another.
- The [OpenAI-compatible adapter](./examples/adapters/openai-compatible.ts) sends `reasoning_effort` by default (`"off"` as `"none"`), reads `reasoning_content` or `reasoning` from replies, and sends its own `reasoning_content` back. Providers with their own switch take `reasoningParams`:

```ts
// DeepSeek V4: a thinking switch, plus low, high or max
const deepseek = (level: ReasoningLevel) =>
  level === "off"
    ? { thinking: { type: "disabled" } }
    : {
        thinking: { type: "enabled" },
        reasoning_effort:
          level === "minimal" || level === "low" ? "low" : level === "xhigh" || level === "max" ? "max" : "high",
      };
// Qwen and vLLM
const qwen = (level: ReasoningLevel) => ({ chat_template_kwargs: { enable_thinking: level !== "off" } });

const model = openAICompatible({ baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", reasoningParams: deepseek });
```
````

- [ ] **Step 2: README.zh-CN.md.** Insert the same section right after the 图片 section, before `## 集成`:

````md
## 思考型模型

请求上的 `reasoning` 决定模型先想多少：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"` 或 `"max"`。不填时适配器什么都不发，由模型用默认值。适配器把档位换成各家的设置，模型没有的档位就近取；按 token 预算控制的服务，由适配器把档位换算成预算。

```ts
const agent = createAgent({ model, tools, reasoning: "high" }); // 这次运行里的每一次模型调用
```

- 回复里，模型想了什么在 `response.reasoning`（`{ text, signature?, redacted? }[]`），思考用掉的 token 数在 `usage.reasoningTokens`，已经算在 `outputTokens` 里。两者都会记进 `llm_call` 事件。
- 有几家要求工具循环的下一次请求原样带回模型之前的思考，否则拒绝请求：DeepSeek V4（`reasoning_content`）、Claude（带签名的思考块）、Gemini 3（每个工具调用上的 `thoughtSignature`，存在 `ToolCall.signature`）。agent 把思考和签名存进它写的 assistant 消息，下一轮自动带上。
- 签名只对写它的模型有效，所以 agent 写的每条 assistant 消息都记下 `model`，也就是 `LLMModel.id`。适配器只在 `m.model` 等于自己的 `id` 时发回思考和签名，回放时换了模型也不会把一个模型的签名发给另一个模型。
- [OpenAI 兼容适配器](./examples/adapters/openai-compatible.ts) 默认发 `reasoning_effort`（`"off"` 写成 `"none"`），从回复里读 `reasoning_content` 或 `reasoning`，并把自己的 `reasoning_content` 发回。有自己开关的服务用 `reasoningParams`：

```ts
// DeepSeek V4：一个思考开关，加上 low、high 或 max
const deepseek = (level: ReasoningLevel) =>
  level === "off"
    ? { thinking: { type: "disabled" } }
    : {
        thinking: { type: "enabled" },
        reasoning_effort:
          level === "minimal" || level === "low" ? "low" : level === "xhigh" || level === "max" ? "max" : "high",
      };
// Qwen 和 vLLM
const qwen = (level: ReasoningLevel) => ({ chat_template_kwargs: { enable_thinking: level !== "off" } });

const model = openAICompatible({ baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", reasoningParams: deepseek });
```
````

- [ ] **Step 3: docs/trace-format.md.** After the paragraph about content parts (the one that starts with ``In `llm_call.input.messages` ``), add:

```md
`llm_call.output.reasoning` holds what the model thought (`{ text, signature?, redacted? }[]`) and `llm_call.output.usage.reasoningTokens` its token count. Assistant messages may carry `reasoning` and `model`, the `LLMModel.id` that wrote them; tool calls may carry `signature`. Adapters send signatures back only to the model named in `model`.
```

- [ ] **Step 4: docs/design.md.** Add this section right after `## Content is a string or parts`:

```md
## Reasoning: levels, and signatures per model

`reasoning` is one of seven levels, not a token budget. OpenAI-style providers take levels and refuse budgets, Claude and Gemini 2.5 take budgets, and a level carries over between them when an adapter maps it, while a budget does not. A request then reads the same in the trace whichever model serves it; a precise budget is still possible through `extra`.

Thinking comes back as readable text with an optional opaque `signature`, not as provider data, so traces stay readable. Signatures are bound to the model that made them, and replay can swap the model, so every assistant message the agent writes records `model` and adapters send signatures only to that model.
```

- [ ] **Step 5: CHANGELOG.md.** Under `## [Unreleased]`, `### Added`, add:

```md
- Reasoning models: `reasoning` on `LLMRequest` (seven levels, `"off"` to `"max"`), what the model thought in `LLMResponse.reasoning` and `usage.reasoningTokens`, `ToolCall.signature`, and `reasoning` and `model` on assistant messages, so a tool loop can send a model's own thinking back as DeepSeek V4, Claude and Gemini 3 require. `createAgent({ reasoning })` sets the level for every call and records which model wrote each message. The OpenAI-compatible example adapter sends `reasoning_effort` or your `reasoningParams`, reads `reasoning_content` and `reasoning`, and sends its own reasoning back.
```

- [ ] **Step 6: Format and check.**

Run: `pnpm exec biome check --write README.md README.zh-CN.md docs/trace-format.md docs/design.md CHANGELOG.md && pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add README.md README.zh-CN.md docs/trace-format.md docs/design.md CHANGELOG.md
git commit -m "docs: reasoning models"
```

---

### Task 5: `taugraph-pi` maps levels and thinking

Repo: `/Users/mi/2026/claw/github/taugraph-pi`, branch `feat/images` (already has the images work).

**Files:**

- Modify: `src/model.ts`
- Test: `test/model.test.ts`
- Modify: `README.md:103`, `README.zh-CN.md` (the bullet at about line 12), `CHANGELOG.md`

**Interfaces:**

- Consumes: `ReasoningPart` and the new fields from Task 1, through a local pack of the taugraph branch.

- [ ] **Step 1: Install this taugraph.**

```bash
cd /Users/mi/2026/claw/github/taugraph && pnpm build && rm -rf /tmp/tg-pack && pnpm pack --pack-destination /tmp/tg-pack
cd /Users/mi/2026/claw/github/taugraph-pi && git checkout feat/images && pnpm add /tmp/tg-pack/taugraph-0.2.0.tgz
```

If `pnpm add` keeps an old unpacked copy, delete `node_modules/.pnpm/taugraph@file*` and run it again.

- [ ] **Step 2: Write the failing tests.** In `test/model.test.ts`:
  - Replace `ctxWith` with:

```ts
function ctxWith(reply: Record<string, unknown>, calls: unknown[] = [], simple: unknown[] = []) {
  const message = () => ({
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hello" },
    ],
    model: "m-1",
    usage: { input: 3, output: 5 },
    stopReason: "stop",
    ...reply,
  });
  return {
    model,
    modelRegistry: {
      complete: async (...args: unknown[]) => {
        calls.push(args);
        return message();
      },
      streamSimple: (...args: unknown[]) => {
        simple.push(args);
        return { result: async () => message() };
      },
    },
  } as unknown as ExtensionContext;
}
```

- In "calls Pi's registry with the session model and maps the reply", the expected `res` gets `reasoning: [{ text: "hmm" }],` (the fake reply has a thinking block).
- Add inside `describe("piModel")`:

```ts
it("asks Pi for a thinking level and maps what the model thought", async () => {
  const calls: unknown[][] = [];
  const simple: unknown[][] = [];
  const reply = {
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
      { type: "thinking", thinking: "", thinkingSignature: "enc", redacted: true },
      { type: "text", text: "done" },
    ],
    usage: { input: 1, output: 9, reasoning: 7 },
  };
  const m = piModel(ctxWith(reply, calls, simple));
  const signal = new AbortController().signal;
  const res = await m.complete({ messages: [{ role: "user", content: "q" }], reasoning: "high" }, { signal });
  expect(calls).toHaveLength(0);
  expect(simple[0]?.[2]).toMatchObject({ signal, reasoning: "high" });
  expect(res.reasoning).toEqual([
    { text: "plan", signature: "sig" },
    { text: "", signature: "enc", redacted: true },
  ]);
  expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 9, reasoningTokens: 7 });
  await m.complete({ messages: [{ role: "user", content: "q" }], reasoning: "off" }, { signal });
  expect(simple[1]?.[2]).not.toHaveProperty("reasoning");
  await m.complete({ messages: [{ role: "user", content: "q" }] }, { signal });
  expect(calls).toHaveLength(1);
});
```

- Add inside `describe("toPiContext")`:

```ts
it("sends thinking back only to the model that wrote it", () => {
  const reasoning = [{ text: "plan", signature: "sig" }];
  const ctx = toPiContext(
    {
      messages: [
        { role: "assistant", content: "a", reasoning, model: "pi:acme/m-1" },
        { role: "assistant", content: "b", reasoning, model: "pi:other/x" },
        { role: "assistant", content: "c", reasoning },
      ],
    },
    model,
  );
  expect(ctx.messages.map((m) => m.content)).toEqual([
    [
      { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
      { type: "text", text: "a" },
    ],
    [{ type: "text", text: "b" }],
    [{ type: "text", text: "c" }],
  ]);
});
```

- [ ] **Step 3: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/model.test.ts`
Expected: FAIL. `reasoning` is ignored and thinking blocks are dropped.

- [ ] **Step 4: Implement.** In `src/model.ts`:
  - Add `type ReasoningPart,` to the `taugraph/nodes` import, and add `type PiReply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;` next to `PiContext`.
  - Add this helper near `shown`, and make the `id` getter `return model ? idOf(model) : "pi:none";`:

```ts
const idOf = (model: PiModel): string => `pi:${model.provider}/${model.id}`;
```

- In `complete`, replace the `const reply = await ctx.modelRegistry.complete(...)` statement with:

```ts
const context = toPiContext({ ...request, messages }, model);
const base = {
  signal,
  ...(request.temperature !== undefined && { temperature: request.temperature }),
  ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
};
// Pi's thinking levels exist on its provider-neutral API only; "off" is the absence of a level there.
const reply: PiReply =
  request.reasoning === undefined
    ? await ctx.modelRegistry.complete(model, context, base)
    : await ctx.modelRegistry
        .streamSimple(model, context, {
          ...base,
          ...(request.reasoning !== "off" && { reasoning: request.reasoning }),
        })
        .result();
```

- Replace the `response` constant with:

```ts
const reasoning = reply.content.flatMap((part): ReasoningPart[] =>
  part.type === "thinking"
    ? [
        {
          text: part.thinking,
          ...(part.thinkingSignature !== undefined && { signature: part.thinkingSignature }),
          ...(part.redacted && { redacted: true }),
        },
      ]
    : [],
);
const response: LLMResponse = {
  content,
  model: reply.responseModel ?? reply.model,
  finishReason: reply.stopReason,
  usage: {
    inputTokens: reply.usage.input,
    outputTokens: reply.usage.output,
    ...(reply.usage.reasoning !== undefined && { reasoningTokens: reply.usage.reasoning }),
  },
  ...(reasoning.length > 0 && { reasoning }),
};
```

- In `toPiContext`'s assistant branch, before the `return`, add
  `const thinking = m.model === idOf(model) ? (m.reasoning ?? []).map(toPiThinking) : [];`
  and change `content: [{ type: "text", text: m.content }],` to `content: [...thinking, { type: "text", text: m.content }],`.
- Add below `toPiPart`:

```ts
/** A reasoning part as Pi's thinking block. Only sent back to the model that wrote it. */
const toPiThinking = (r: ReasoningPart) => ({
  type: "thinking" as const,
  thinking: r.text,
  ...(r.signature !== undefined && { thinkingSignature: r.signature }),
  ...(r.redacted && { redacted: true }),
});
```

- [ ] **Step 5: Docs and checks.**
  - `README.md:103`: append ``A request's `reasoning` level goes to Pi's thinking level, the model's thinking comes back in `response.reasoning`, and it is sent back to Pi when the same model continues the conversation.``
  - `README.zh-CN.md`, the "LLM 步骤使用你在 Pi 里选的模型" bullet: append this sentence (`reasoning` and `response.reasoning` in inline code): 请求的 reasoning 档位交给 Pi 的思考档位，模型的思考在 response.reasoning 里，同一个模型接着对话时会发回给 Pi。
  - `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add: ``- Reasoning: `request.reasoning` goes to Pi's thinking level (through `streamSimple`), Pi's thinking blocks come back as `response.reasoning` with their signatures and `usage.reasoningTokens`, and a model's own thinking is sent back to it. Requires taugraph 0.3.0.``

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit without the dependency change.**

```bash
git checkout package.json pnpm-lock.yaml
git add src/model.ts test/model.test.ts README.md README.zh-CN.md CHANGELOG.md
git commit -m "feat: reasoning levels and thinking (needs taugraph 0.3.0)"
```

---

### Task 6: `taugraph-mcp` maps levels in its OpenAI adapter

Repo: `/Users/mi/2026/claw/github/taugraph-mcp`, branch `feat/images` (already has the images work).

**Files:**

- Modify: `src/models.ts`
- Test: `test/models.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `ReasoningLevel` and the new fields from Task 1.
- Produces: `OpenAICompatibleOptions.reasoningParams?: (level: ReasoningLevel) => Record<string, unknown>`.

- [ ] **Step 1: Install this taugraph.**

```bash
cd /Users/mi/2026/claw/github/taugraph-mcp && git checkout feat/images && pnpm add /tmp/tg-pack/taugraph-0.2.0.tgz
```

(The tarball comes from Task 5 Step 1; rebuild it the same way if `/tmp/tg-pack` is gone. If `pnpm add` keeps an old unpacked copy, delete `node_modules/.pnpm/taugraph@file*` and run it again.)

- [ ] **Step 2: Write the failing tests.** In `test/models.test.ts`:
  - Inside `describe("samplingModel")`, add:

```ts
it("works with a reasoning level, which MCP sampling has no field for", async () => {
  const seen: { params?: { messages?: unknown[] } } = {};
  const reply = await samplingModel(samplingServer(seen)).complete(
    { messages: [{ role: "user", content: "hi" }], reasoning: "high" },
    { signal },
  );
  expect(reply.content).toBe("a cat");
  expect(seen.params).not.toHaveProperty("reasoning");
});
```

- Inside `describe("openAICompatibleModel")`, add:

```ts
it("asks for a reasoning level, reads what the model thought, and sends only OpenAI's fields", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({
      choices: [{ message: { content: "ok", reasoning_content: "hmm" } }],
      usage: { prompt_tokens: 1, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 } },
    });
  });
  const model = openAICompatibleModel({ baseURL: "http://x/v1", model: "m" });
  const reply = await model.complete(
    {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", model: "x", reasoning: [{ text: "r" }] },
      ],
      reasoning: "off",
    },
    { signal },
  );
  expect(body.reasoning_effort).toBe("none");
  expect(body.messages).toEqual([
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ]);
  expect(reply.reasoning).toEqual([{ text: "hmm" }]);
  expect(reply.usage).toEqual({ inputTokens: 1, outputTokens: 4, reasoningTokens: 3 });
  const custom = openAICompatibleModel({
    baseURL: "http://x/v1",
    model: "m",
    reasoningParams: () => ({ chat_template_kwargs: { enable_thinking: false } }),
  });
  await custom.complete({ messages: [{ role: "user", content: "q" }], reasoning: "off" }, { signal });
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
});
```

- [ ] **Step 3: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/models.test.ts`
Expected: the sampling test passes already; the OpenAI test FAILS (no `reasoning_effort`, assistant messages sent with taugraph's own fields, no reasoning read).

- [ ] **Step 4: Implement.** In `src/models.ts`:
  - Add `type ReasoningLevel,` to the `taugraph/nodes` import.
  - Add to `samplingModel`'s doc comment: ``MCP sampling has no reasoning setting, so `request.reasoning` is not sent.``
  - Add to `OpenAICompatibleOptions`:

```ts
  /** Request parameters for a reasoning level. Default: `{ reasoning_effort }`, with "off" sent as "none". */
  readonly reasoningParams?: (level: ReasoningLevel) => Record<string, unknown>;
```

- Add above `openAICompatibleModel`:

```ts
const defaultReasoningParams = (level: ReasoningLevel): Record<string, unknown> => ({
  reasoning_effort: level === "off" ? "none" : level,
});
```

- In `complete`, replace the `messages` mapping with:

```ts
const messages = (await resolveImages(request.messages, readImage)).map((m) => {
  if (m.role === "user" && typeof m.content !== "string") {
    return { role: "user", content: m.content.map(toOpenAIPart) };
  }
  // taugraph's own fields (`model`, `reasoning`, `toolCalls`) are not OpenAI's; strict endpoints refuse them
  if (m.role === "system" || m.role === "assistant") return { role: m.role, content: m.content };
  return m;
});
```

add to the body after the `response_format` line:

```ts
          ...(request.reasoning && (options.reasoningParams ?? defaultReasoningParams)(request.reasoning)),
```

change the body type cast so `message` has `reasoning_content?: string | null; reasoning?: string | null` and `usage` has `completion_tokens_details?: { reasoning_tokens?: number }`, and replace the returned object with:

```ts
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
          ...(reasoningTokens !== undefined && { reasoningTokens }),
        },
        ...(thought && { reasoning: [{ text: thought }] }),
      };
```

- [ ] **Step 5: Changelog and checks.** `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add: ``- Reasoning: `openAICompatibleModel` sends `reasoning_effort` (or `reasoningParams`) for `request.reasoning`, reads `reasoning_content` and `reasoning` into `response.reasoning`, and no longer sends taugraph's own message fields. `samplingModel` ignores `reasoning`, which MCP sampling has no field for. Requires taugraph 0.3.0.``

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit without the dependency change.**

```bash
git checkout package.json pnpm-lock.yaml
git add src/models.ts test/models.test.ts CHANGELOG.md
git commit -m "feat: reasoning levels in the OpenAI adapter (needs taugraph 0.3.0)"
```

---

### Task 7: Final verification

- [ ] **Step 1:** In `/Users/mi/2026/claw/github/taugraph`: `pnpm check`. Expected: PASS.
- [ ] **Step 2:** `pnpm example:quickstart && pnpm example:checkout && pnpm example:rag && pnpm example:agent`. Expected: all run; `example:agent` prints `replay equal: true`.
- [ ] **Step 3:** In both siblings: `pnpm check` passes with the local tarball installed; `git status --short` is empty in all three repos; `git diff main --stat -- package.json pnpm-lock.yaml` is empty in both siblings.
