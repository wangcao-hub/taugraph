# 思考型模型设计（第 3 条）

> 2026-11-24 定稿。实现以代码和测试为准。

## 1. 目标

让调用方能控制模型想多少，能看到模型想了什么，并且在带工具的多轮对话里把思考内容原样交回模型。最后一点是硬性要求：

- DeepSeek V4 思考模式下调用工具后，后续请求里那条助手消息必须带上当时的 `reasoning_content`，否则返回 400（[DeepSeek 文档](https://api-docs.deepseek.com/guides/thinking_mode)）。
- Claude 的思考块带签名，后续请求必须原样发回（[Anthropic 文档](https://platform.claude.com/cookbook/extended-thinking-extended-thinking-with-tool-use)）。
- Gemini 3 的每个工具调用带 `thoughtSignature`，后续请求必须原样带上，否则返回 400（[Gemini 文档](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)）。

和用户确认过的选择：

- 三部分都做：请求里的思考档位、回复里的思考内容和 token 数、多轮回传。
- 档位只用一个字段，七档，和 Pi 一致；按 token 预算控制的服务由适配器换算。
- 思考内容存成可读文字加可选签名；Gemini 的签名挂在工具调用上。
- 签名按模型区分：assistant 消息记下写它的模型，适配器只把签名发回同一个模型。
- 全部是可选字段，不是不兼容改动。

## 2. 模型接口（`src/nodes/llm.ts`，从 `taugraph/nodes` 导出）

```ts
/** How much a model should think first. Adapters map it to the provider's setting and round to the nearest level it has. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** What a model thought before answering. `signature` is the provider's opaque proof; send it back unchanged. */
export interface ReasoningPart {
  readonly text: string;
  readonly signature?: string;
  /** The provider hid the text (safety filter); `signature` holds the encrypted payload. */
  readonly redacted?: boolean;
}
```

新增字段：

| 位置                | 字段                                   | 说明                                         |
| ------------------- | -------------------------------------- | -------------------------------------------- |
| `LLMRequest`        | `reasoning?: ReasoningLevel`           | 不填时适配器不发任何思考参数，由模型用默认值 |
| `LLMResponse`       | `reasoning?: readonly ReasoningPart[]` | 按模型给出的顺序                             |
| `LLMResponse.usage` | `reasoningTokens?: number`             | 已经算在 `outputTokens` 里                   |
| `ToolCall`          | `signature?: string`                   | Gemini 的 `thoughtSignature`                 |
| assistant 消息      | `reasoning?: readonly ReasoningPart[]` | 这一轮的思考                                 |
| assistant 消息      | `model?: string`                       | 写这条消息的 `LLMModel.id`                   |

回传规则（写进 `ReasoningPart` 和 assistant 消息的注释）：

- 签名只对产生它的模型有效。适配器只在 `m.model` 等于自己的 `id` 时发回签名、`redacted` 片段和 `ToolCall.signature`。
- 来自别的模型（或没有 `model`）的思考，适配器只发文字，或者不发，由适配器按服务的要求决定。
- 这样回放时换一个模型对比，旧模型的签名不会被发给新模型。

`LLMNode` 不变：`update(state, text, response)` 可以从 `response.reasoning` 读到思考。`llm_call` 事件照常记下整个回复，所以 trace 里能读到思考文字。

## 3. Agent（`src/agent/`）

- `AgentConfig` 新增 `reasoning?: ReasoningLevel`，每一次模型请求都带上。
- agent 写的 assistant 消息一律带 `model: config.model.id`。回复里有思考时带 `reasoning`（空数组不写）。工具调用连同 `signature` 原样存进 `toolCalls` 和 `pending`。
- 状态 schema 新增检查，错误带路径：
  - assistant 消息的 `reasoning`：数组；每项的 `text` 是字符串，`signature` 可选、是字符串，`redacted` 可选、是布尔。
  - assistant 消息的 `model`：可选、是字符串。
  - 工具调用的 `signature`：可选、是字符串（`toolCalls` 和 `pending` 两处）。
- 现有测试里 agent 写的 assistant 消息多了 `model`，同步更新期望值。

## 4. 适配器

### 4.1 示例 OpenAI 适配器（`examples/adapters/openai-compatible.ts`）

- 选项新增 `reasoningParams?: (level: ReasoningLevel) => Record<string, unknown>`，返回值合进请求体（在 `extra` 之前，`extra` 仍可覆盖）。默认是 `{ reasoning_effort: level === "off" ? "none" : level }`。
- 回复：`message.reasoning_content`（DeepSeek、Qwen、Kimi）或 `message.reasoning`（OpenRouter、Ollama）是非空字符串时，变成 `reasoning: [{ text }]`。`usage.completion_tokens_details.reasoning_tokens` 变成 `usage.reasoningTokens`。
- 回传：assistant 消息有 `reasoning` 且 `m.model` 等于适配器的 `id` 时，把各段 `text` 用 `\n` 拼起来，作为 `reasoning_content` 发出（`redacted` 片段跳过）。别的模型写的不发，因为 OpenAI 官方接口遇到不认识的字段会拒绝请求。
- README 给出两个 `reasoningParams` 写法：
  - DeepSeek V4：`off` 发 `{ thinking: { type: "disabled" } }`；其他档发 `{ thinking: { type: "enabled" }, reasoning_effort }`，档位就近取 `low`（minimal、low）、`high`（medium、high）、`max`（xhigh、max）。
  - Qwen 和 vLLM：发 `{ chat_template_kwargs: { enable_thinking: level !== "off" } }`。

### 4.2 `taugraph-pi`（在已有的 `feat/images` 分支上继续）

- Pi 的档位参数只在它的通用接口上：设了 `request.reasoning` 时，`complete` 改为调用 `ctx.modelRegistry.streamSimple(model, context, { signal, temperature, maxTokens, reasoning })` 并等待 `.result()`；`off` 时不传 `reasoning`（Pi 在这条路径上不传就是不思考）。没设 `request.reasoning` 时照旧用 `ctx.modelRegistry.complete`，行为不变。
- 回复：Pi 的 `ThinkingContent` 转成 `ReasoningPart`（`thinking` 对应 `text`，`thinkingSignature` 对应 `signature`，`redacted` 照抄）；`usage.reasoning` 转成 `usage.reasoningTokens`。
- 回传：`m.model` 等于 `piModel` 当前的 `id` 时，assistant 消息的 `reasoning` 变成 Pi 的思考块，放在文字前面；否则不发。

### 4.3 `taugraph-mcp`（在已有的 `feat/images` 分支上继续）

- `samplingModel`：MCP sampling 没有思考相关的字段，`reasoning` 不发也不报错，文档写明。
- 包里的 `openAICompatibleModel`：和 4.1 一样做请求档位（同样的 `reasoningParams` 选项和默认值）和回复读取；它不支持工具调用，所以不做回传。

## 5. 文档

- README（中英文）：新增"思考型模型"一节：七档、就近取档、回传规则和为什么记 `model`，以及 4.1 的两个 `reasoningParams` 写法。
- `docs/trace-format.md`：`llm_call.output.reasoning`、`usage.reasoningTokens`，以及 assistant 消息上的 `reasoning` 和 `model`。
- `docs/design.md`：新增一节，写为什么用档位而不是 token 预算，以及为什么签名按模型区分。
- `CHANGELOG.md` 的 Unreleased：在 `### Added` 下加一条。两个兄弟包的 CHANGELOG 各加一条。

## 6. 测试

- 类型（`test/types.test.ts`）：七档都能用，`"ultra"` 编译报错；`LLMRequest.reasoning`、`LLMResponse.reasoning`、`ToolCall.signature`、assistant 消息的 `reasoning` 和 `model` 都能用。
- agent（`test/agent.test.ts`）：
  - `reasoning: "high"` 出现在每一轮请求里；不设时请求里没有 `reasoning`。
  - 回复里的思考和工具调用的签名存进 assistant 消息，第二轮请求里原样出现；assistant 消息带 `model`。
  - 回复里 `reasoning: []` 时 assistant 消息不带 `reasoning`。
  - 状态 schema 拒绝格式不对的思考片段、`model` 和签名，路径正确。
  - 换一个模型回放（override）时，新模型收到的 assistant 消息仍带旧模型的 `model`，由适配器据此决定不发签名。
- 示例适配器（`test/adapter.test.ts`）：
  - 默认发 `reasoning_effort`，`off` 写成 `"none"`；没设 `reasoning` 时不发；自定义 `reasoningParams` 生效。
  - `reasoning_content` 和 `reasoning` 两种回复字段都能读出来；`reasoning_tokens` 读成 `reasoningTokens`。
  - 同一个模型写的 assistant 消息发回 `reasoning_content`，别的模型写的、没有 `model` 的都不发。
- 兄弟包：
  - Pi：设了档位走 `streamSimple`，没设走 `complete`，`off` 不传 `reasoning`；`ThinkingContent` 转成 `ReasoningPart`；同一模型的思考发回、别的模型的不发。
  - MCP：自带 OpenAI 适配器的档位和回复读取；sampling 收到 `reasoning` 时照常工作。
- 完成标准：三个仓库 `pnpm check` 通过，taugraph 的四个示例照常运行。

## 7. 不做

- 按单次请求精确指定 token 预算（需要时用 `extra`）。
- 流式输出思考过程。
- OpenAI Responses API 的加密推理项（示例适配器只对接 Chat Completions）。
- 兄弟包适配器支持工具调用：本条做完后单独做，在发 0.3.0 之前。
- 思考文字的脱敏（第 10 条）。

## 8. 发布

- taugraph：在分支 `feat/reasoning` 上做，完成后合并回 main。
- 兄弟包：继续用各自的 `feat/images` 分支，依赖等 0.3.0 发布后再改。
- 顺序：本条 → 兄弟包支持工具调用 → taugraph 发 0.3.0 → 兄弟包改依赖、合并、发布。
