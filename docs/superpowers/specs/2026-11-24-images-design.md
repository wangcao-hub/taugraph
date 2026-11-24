# 消息里的图片设计（第 2 条）

> 2026-11-24 定稿。实现以代码和测试为准。

## 1. 目标

让 `user` 消息和工具结果可以带图片，并且图片可以只以引用的形式出现在 trace 和状态里，不必每轮都存一份 base64。

和用户确认过的选择：

- `content` 改成 `string | 片段数组`（OpenAI、Anthropic 的形状），文字和图片可以穿插。这是不兼容改动，只放宽 `user` 和 `tool` 两个角色；`system`、`assistant` 仍然只是字符串。
- 图片可以是 base64（`data` + `mimeType`，MCP 和 Pi 的字段名），也可以是地址（`url`：`https:`、`data:` 或应用自己的引用）。适配器在调用模型时再把引用读成图片内容。
- 只能发文字的适配器遇到图片时默认报错，不悄悄丢掉。
- 顺带修第 1 条留下的三个小问题（第 5 节）。

## 2. 模型接口（`src/nodes/llm.ts`，从 `taugraph/nodes` 导出）

```ts
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export type ImagePart =
  | { readonly type: "image"; readonly data: string; readonly mimeType: string } // base64, no "data:" prefix
  | { readonly type: "image"; readonly url: string; readonly mimeType?: string };

export type ContentPart = TextPart | ImagePart;

/** What a user message or a tool result may carry. */
export type MessageContent = string | readonly ContentPart[];

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: MessageContent }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: MessageContent;
      readonly isError?: boolean;
    };
```

- `LLMRequest`、`LLMResponse` 不变。`LLMResponse.content` 仍是字符串，模型生成图片不在本条范围。
- 各家独有的图片选项（OpenAI 的 `detail` 等）不进契约，需要的人用 `extra`。
- `LLMNode` 不检查片段，交给适配器。字符串 `prompt` 仍然变成一条文字 `user` 消息。

## 3. 辅助函数（`src/nodes/content.ts`，从 `taugraph/nodes` 导出）

### 3.1 `textOf(content, options?)`

```ts
export function textOf(content: MessageContent, options?: { readonly imagePlaceholder?: string }): string;
```

- 字符串原样返回；片段数组把文字直接拼接，不加分隔符。
- 有图片且没给 `imagePlaceholder`：抛 `TypeError`，信息是 `textOf: the content has images and this adapter sends text only; pass { imagePlaceholder } to replace them`。
- 给了 `imagePlaceholder`：每张图换成这段文字。

### 3.2 `resolveImages(messages, resolve?)`

```ts
export type ImageResolver = (url: string) => MaybePromise<ImagePart>;
export function resolveImages(messages: readonly ChatMessage[], resolve?: ImageResolver): MaybePromise<ChatMessage[]>;
```

- 只看 `user` 和 `tool` 消息里的片段；其他消息、字符串内容、文字片段、带 `data` 的图片都原样保留。没有图片要处理的消息保持同一个对象。
- `data:` 地址自己拆成 `{ type: "image", data, mimeType }`，不调用 `resolve`。只接受 `data:<mime>;base64,<data>`，其他写法抛 `TypeError`。
- 其他地址交给 `resolve`，用它的返回值替换。返回值必须是 `ImagePart`（可以是另一个地址，比如原样返回 https），否则抛 `TypeError`。
- 遇到需要 `resolve` 的地址但没给：抛 `TypeError`，信息带上地址（超过 100 个字符时截断）。
- 所有 `resolve` 都同步返回时，整个函数同步返回；有一个返回 Promise，就返回 Promise。多个地址按出现顺序依次处理。

## 4. Agent（`src/agent/`）

- `ToolResult` 改为 `string | { content: MessageContent; isError?: boolean }`。工具返回的片段原样进入 `tool` 消息和 `tool_call` 事件的 `output.content`。
- 片段校验用一个内部函数，状态 schema 和工具返回值共用：
  - 文字片段：`text` 是字符串。
  - 图片片段：要么 `data` 和 `mimeType` 都是字符串，要么 `url` 是字符串（`mimeType` 可选且是字符串）。
  - 状态 schema 的错误带路径，例如 `["messages", 2, "content", 1, "url"]`。`system`、`assistant` 消息的 `content` 仍然必须是字符串。
- 工具返回值格式不对时和现在一样抛 `TypeError`，信息改为 `Tool "x" returned neither a string nor { content: string | ContentPart[] }`；片段本身不对时说明第几个片段哪里不对。

## 5. 顺带修的三个问题

1. **超出 32 个的调用的答复排在最后**。现在 `think` 把多出的调用的错误答复紧跟在助手消息后面，排在前 32 个调用的结果前面。改为：`act` 答完 `pending` 里最后一个调用时，找出上一条助手消息里还没有答复的调用，按原顺序补上 `TOO_MANY` 错误答复。状态形状不变。
2. **示例适配器补的 id 不再每轮重复**。`fromOpenAIToolCalls` 现在用 `call_${i}`。改为 `fromOpenAIToolCalls(calls, round)`，id 是 `call_${round}_${i}`；适配器里 `round` 是请求中已有的助手消息数加 1。`round` 默认为 1，单独调用的旧写法仍然能用。
3. **示例适配器不再丢掉 `isError`**。OpenAI 的 `tool` 消息没有这个字段，所以 `isError` 为真且文字不以 `Error` 开头时，在文字前加 `Error: `。

## 6. 适配器

### 6.1 示例 OpenAI 适配器（`examples/adapters/openai-compatible.ts`）

- 选项新增 `resolveImage?: ImageResolver`。`complete` 先调用 `resolveImages`：`http:`、`https:` 地址原样返回，其他地址交给 `resolveImage`。没有 `resolveImage` 时遇到其他地址就报错。
- `user` 消息：字符串原样发；片段转成 `{ type: "text", text }` 和 `{ type: "image_url", image_url: { url } }`，base64 拼成 `data:<mimeType>;base64,<data>`。
- `tool` 消息：OpenAI 的 `tool` 消息只能放文字。文字片段拼起来留在 `tool` 消息里（没有文字时写 `(image)`）；连续几条 `tool` 消息里的图片收集起来，放进紧跟在这组 `tool` 消息后面的一条 `user` 消息，每个调用先写一段 `Images from tool call <id>:` 再放它的图片。没有图片就不加这条消息。
- `toOpenAIMessages` 保持同步，遇到还没读成内容的引用地址（不是 `http:`、`https:`、`data:`）时报错。

### 6.2 `taugraph-pi`（独立分支）

- `piModel(ctx, { resolveImage })`：`complete` 先调用 `resolveImages(request.messages, options.resolveImage)`。
- `toPiContext`：`user` 的字符串原样传；片段转成 Pi 的 `TextContent` 和 `ImageContent`（字段和我们的 base64 图片一致）。还是地址的图片报错，提示传 `resolveImage`。`system` 照旧合并成系统提示。
- `tool` 消息的处理不在本条范围（见第 9 节）。

### 6.3 `taugraph-mcp`（独立分支）

- `samplingModel(server, { resolveImage })`：先 `resolveImages`，再把 `user` 片段转成 MCP 的内容数组（`{ type: "text", text }`、`{ type: "image", data, mimeType }`）。还是地址的图片报错。
- 包里的 `openAICompatible`：不再原样发 `request.messages`，至少把 `user` 片段转成 OpenAI 格式（同 6.1），支持 `resolveImage`。

## 7. 文档

- README（中英文）：新增"图片"一节，写片段形状、引用地址的用法和一段 `resolveImage` 示例；"插件节点"表格补上片段类型和两个辅助函数。
- `docs/trace-format.md`：`llm_call.input.messages` 和 `tool_call.output.content` 里可能有片段；建议用引用地址控制 trace 体积，并说明重放不调用模型，引用失效不影响重放。
- `docs/design.md`：新增一节，写明为什么选 `string | 片段数组`，以及放弃"并列 `images` 字段"和"另加 `parts`"的原因。
- `CHANGELOG.md` 的 Unreleased：在 `### Changed` 下加一条，以 `**Breaking:**` 开头，迁移方法写成一句话：只发文字的适配器把 `m.content` 换成 `textOf(m.content)`。`### Added` 写片段、两个辅助函数、工具返回图片、适配器的 `resolveImage`。`### Fixed` 写第 5 节三项。

## 8. 测试

- 类型（`test/types.test.ts`）：`user`、`tool` 接受字符串和片段数组；`system`、`assistant` 传片段数组编译报错；`textOf`、`resolveImages` 和新类型能从 `taugraph/nodes` 导入。
- `textOf`（`test/content.test.ts`）：字符串、多段文字、有图片默认报错、`imagePlaceholder`。
- `resolveImages`（`test/content.test.ts`）：
  - `resolve` 同步时结果同步，异步时返回 Promise。
  - `data:` 地址自己拆开、不调用 `resolve`；格式不对报错。
  - base64 图片、`system`、`assistant`、字符串内容原样保留，没变的消息是同一个对象。
  - `tool` 消息里的图片也处理。
  - 需要 `resolve` 但没给时报错，地址出现在信息里；`resolve` 返回的不是图片时报错。
- agent（`test/agent.test.ts`）：
  - 带图的 `user` 消息原样进入模型请求。
  - 工具返回片段，变成 `tool` 消息和 `tool_call` 事件里的片段。
  - 工具返回坏片段时报错，信息里有工具名。
  - 状态 schema 拒绝坏片段，路径正确；`assistant` 的片段数组被拒绝。
  - 一次回复 33 个调用：前 32 个的结果在前，第 33 个的错误答复在最后。
- 适配器（`test/adapter.test.ts`）：
  - `user` 片段转换，base64 拼成 `data:` 地址。
  - 工具图片搬进紧跟一组 `tool` 消息之后的 `user` 消息，没有图片时不加。
  - `media:` 地址交给 `resolveImage`，`https:` 原样发；没有 `resolveImage` 时报错。
  - 缺 id 时第 2 轮补的是 `call_2_0`。
  - `isError` 的结果前面加了 `Error: `，已经以 `Error` 开头的不重复加。
- 兄弟包：`toPiContext` 带图、MCP sampling 带图、MCP 自带 OpenAI 适配器带图，各一组测试；用 `pnpm pack` 打出的本地 taugraph 跑它们的 `pnpm check`。
- 完成标准：`pnpm check` 全部通过，现有四个示例照常运行。

## 9. 不做

- 模型回复里的图片（生成图片）。
- 音频、PDF 等其他类型的片段。
- 兄弟包适配器支持第 1 条的工具调用。现在 Pi 适配器丢掉 `tool` 消息，MCP sampling 适配器把它们当成别的角色发出。本条做完后单独补一个小任务。
- trace 自动瘦身（第 10 条）。

## 10. 发布

- taugraph：在分支 `feat/images` 上做，完成后合并回 main；第 1 到 3 条都完成后一起发 0.3.0。
- 兄弟包：各自的分支先用本地打包的 taugraph 验证；0.3.0 发布后把依赖改成 `^0.3.0`，再合并、发布。
