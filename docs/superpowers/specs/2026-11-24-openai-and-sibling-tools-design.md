# `taugraph/openai` 与兄弟包工具调用设计

> 2026-11-24 定稿。实现以代码和测试为准。这是发 0.3.0 前的最后一项。

## 1. 目标

- 第 1 条加了工具调用，但 `taugraph-pi` 和 `taugraph-mcp` 的适配器还不支持：Pi 适配器丢掉 `tool` 消息，MCP 的 sampling 适配器把它们当成别的角色发出。用这两个包跑 `taugraph/agent` 的工具循环会出错。
- 同一个 OpenAI 兼容适配器有三份：taugraph 的示例、taugraph-mcp 的 `openAICompatibleModel`、moqi 的 `src/core/model.ts`。

和用户确认过的选择：

- taugraph 把示例适配器正式发布为插件入口 `taugraph/openai`，taugraph-mcp 直接用它。
- 适配器表达不了某个 `toolChoice` 时：能等价翻译的就翻译，翻译不了的报错，不悄悄降级。

## 2. `taugraph/openai`（`src/openai/index.ts`）

- 内容就是现在的 `examples/adapters/openai-compatible.ts`（工具调用、图片、思考），去掉 `modelFromEnv`。导出：`openAICompatible`、`OpenAICompatibleOptions`、`toOpenAIMessages`、`toOpenAITools`、`toOpenAIToolChoice`、`fromOpenAIToolCalls`、`OpenAIToolCall`。名字和行为不变。
- 新选项 `fetch?: typeof fetch`：不给时用全局 `fetch`。用于代理、测试、加重试。
- 是插件：只从 `../index.js` 和 `../nodes/index.js` 导入；`test/architecture.test.ts` 加一条规则。`package.json` 的 `exports` 加 `"./openai"`，`pnpm build` 产出 `dist/openai`。
- `examples/adapters/openai-compatible.ts` 改成 `export * from "../../src/openai/index.js"`，再加上原来的 `modelFromEnv`（读 `process.env`，只适合 Node，所以留在示例里）。四个示例不用改。
- 测试：`test/adapter.test.ts` 改名为 `test/openai.test.ts`，从 `../src/openai/index.js` 导入，原有测试全部保留；加一条 `fetch` 选项的测试（传入的 `fetch` 被调用，全局 `fetch` 不被调用）。

## 3. `taugraph-pi` 的工具调用（`src/model.ts`）

- 工具定义：`request.tools` 变成 Pi `context.tools`：`{ name, description: t.description ?? "", parameters: t.inputSchema }`。
- `toolChoice`：
  - `"auto"`：不传（有工具时 Pi 默认就是 auto），仍走 `complete`。
  - `"none"`：走 `streamSimple`，传 `toolChoice: "none"`。
  - `"required"` 或 `{ name }`：抛 `TypeError`：`Pi supports toolChoice "auto" and "none" only, got <JSON>`。
  - `streamSimple` 路径上照旧处理 `reasoning`（第 3 条的规则不变）。
- 回复：Pi 的 `toolCall` 块变成 `toolCalls`：`{ id, name, arguments }`，`thoughtSignature` 变成 `signature`，`argumentsError` 变成 `parseError`。
- assistant 消息发回 Pi：内容依次是思考块（同一模型时）、文字块（`content` 不为空时）、`toolCall` 块（`{ type: "toolCall", id, name, arguments }`，同一模型时加 `thoughtSignature`）。有工具调用时 `stopReason` 是 `"toolUse"`，否则 `"stop"`。
- tool 消息发回 Pi：`{ role: "toolResult", toolCallId, toolName, content, isError, timestamp }`。`content` 是字符串时变成一个文字块，是片段时用现有的 `toPiPart`（图片照样支持）。`toolName` 从前面 assistant 消息里 id 相同的调用找；找不到时抛 `TypeError`：`Tool result "<id>" answers no call in an earlier assistant message`。

## 4. `taugraph-mcp`

### 4.1 `samplingModel` 的工具调用（`src/models.ts`）

- 请求带了 `tools`，或者消息里有 assistant 的 `toolCalls` 或 `tool` 消息时，客户端必须声明 `sampling.tools`，否则抛错：`This flow uses tools, but the MCP client does not support tools in sampling (sampling.tools).` 没有工具的请求和现在一样。
- 工具定义：`{ name, description, inputSchema }` 原样传。
- `toolChoice`：`"auto"`、`"required"`、`"none"` 变成 `{ mode }`；`{ name }` 变成只发送那一个工具加 `{ mode: "required" }`，名字不在 `tools` 里时抛 `TypeError`。
- assistant 消息：文字块（不为空时）加 `{ type: "tool_use", id, name, input: arguments }`。只有一个块时照旧发单个块。
- tool 消息：连续几条合成一条 `user` 消息，里面只有 `{ type: "tool_result", toolUseId, content, isError? }` 块；`content` 是内容块数组（字符串变成一个文字块，片段按现有规则转换）。
- 回复：`tool_use` 块变成 `toolCalls`（`input` 变成 `arguments`），文字块拼成 `content`，`stopReason` 作为 `finishReason`。

### 4.2 `openAICompatibleModel`

- 改为调用 `taugraph/openai` 的 `openAICompatible`，`openAICompatibleModel` 这个名字和 `OpenAICompatibleOptions` 保留（从 `taugraph/openai` 转出）。原来在本包写的消息、图片、思考转换代码删除。
- `modelFromEnv` 不变，仍返回 `openAICompatibleModel(...)`。
- 测试改为验证转发后的行为：工具、图片、思考都能用。

## 5. 文档

- taugraph README（中英文）：
  - 新增一节 "`taugraph/openai`"：用法，选项 `resolveImage`、`reasoningParams`、`sendReasoning`、`fetch`。
  - 所有指向 `examples/adapters/openai-compatible.ts` 的链接改为这一节或 `taugraph/openai`。
  - "不带服务商代码"的说法改为：内核和 `taugraph/nodes` 不带；`taugraph/openai` 是可选插件，用全局 `fetch` 对接所有 OpenAI 兼容接口，零依赖。
- `docs/design.md`：新增一节，写为什么从示例变成插件（三份拷贝，零依赖，只依赖 `fetch`）。
- CHANGELOG：taugraph 的 `### Added` 加 `taugraph/openai`；两个兄弟包各加一条工具调用，并写明限制（Pi 只支持 `auto` 和 `none`；MCP 需要支持 sampling 工具的客户端）。
- 兄弟包 README：各加一句工具调用的支持情况。

## 6. 测试

- taugraph：第 2 节的测试；架构规则；`pnpm build` 后 `dist/openai/index.js` 存在。
- Pi（`test/model.test.ts`）：
  - 工具定义进 `context.tools`，`description` 缺省为空字符串。
  - `toolChoice: "auto"` 走 `complete`，`"none"` 走 `streamSimple` 并传 `toolChoice`，`"required"` 和 `{ name }` 报错。
  - 回复里的 `toolCall` 块转成 `toolCalls`，带 `signature` 和 `parseError`。
  - assistant 消息转换顺序正确（思考、文字、调用），`thoughtSignature` 只发给同一模型，`stopReason` 正确。
  - tool 消息转成 `toolResult`，工具名对，图片保留；孤立的结果报错。
  - 用 `createAgent` 和假的 Pi 跑一次两轮的工具循环，第二轮请求里有工具结果。
- MCP（`test/models.test.ts`）：
  - 客户端没有 `sampling.tools` 时用工具报错；没有工具时照常。
  - 工具定义和三种 `mode` 透传；`{ name }` 只发送那一个工具；名字不存在时报错。
  - `tool_use`、`tool_result` 转换正确，连续工具结果合成一条 `user` 消息。
  - 用 `createAgent` 和假的客户端跑一次两轮的工具循环。
  - `openAICompatibleModel` 转发后，工具、图片、思考都能用。
- 完成标准：三个仓库 `pnpm check` 通过，taugraph 四个示例照常运行。

## 7. 不做

- 并行执行同一回复里的多个工具调用（第 9 条）。
- moqi 切到 `taugraph/openai`（0.3.0 发布之后另做）。
- MCP sampling 的 `includeContext` 等其他能力。

## 8. 发布

1. taugraph：在分支 `feat/openai` 上做，完成后合并回 main。
2. 兄弟包：继续用各自的 `feat/images` 分支。
3. taugraph 发 0.3.0：我改版本号、打 tag、写发布说明，用户执行 `npm publish --auth-type=web`。
4. 兄弟包把依赖改成 `^0.3.0`，README 里的 "taugraph 0.2" 一起改，合并回各自的 main，再发布。
