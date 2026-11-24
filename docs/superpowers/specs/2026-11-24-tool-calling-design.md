# 工具调用设计（第 1 条）

> 2026-11-24 定稿。实现以代码和测试为准。

## 1. 目标

让 taugraph 能做"模型 ↔ 工具"循环的 agent，而且每一次工具调用都享有 taugraph 已有的保证：写进 trace、能回放、回放不重复写操作、崩溃后能接着跑、能暂停等人批准。

和用户确认过的选择：

- 接口沿用业界已有的格式：工具定义用 MCP 的字段名（`name`、`description`、`inputSchema`，JSON Schema），工具调用的参数是解析好的 JSON（和 MCP、Anthropic 一致），OpenAI 的字符串参数由适配器转换。
- 只加可选字段，现有适配器（含 `taugraph-mcp`、`taugraph-pi`）不用改也能编译、能跑。
- 工具循环做成一张图，每次工具调用是一步；不做成一个包住整个循环的节点。
- 状态 schema 基于 Standard Schema 手写，仍然零运行时依赖。

## 2. 模型接口（`src/nodes/llm.ts`，从 `taugraph/nodes` 导出）

```ts
export interface ToolSpec {
  readonly name: string; // ^[A-Za-z0-9_-]{1,64}$
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>; // JSON Schema，type: "object"
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** 适配器读不懂模型给的参数（不是 JSON 对象）时填原因，此时 arguments 为 {}。agent 不执行，把原因交回模型。 */
  readonly parseError?: string;
}

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string; readonly isError?: boolean };

export interface LLMRequest {
  // 原有字段不变：messages、temperature、maxTokens、responseFormat、extra
  readonly tools?: readonly ToolSpec[];
  readonly toolChoice?: "auto" | "none" | "required" | { readonly name: string };
}

export interface LLMResponse {
  // 原有字段不变：content、model、finishReason、usage
  readonly toolCalls?: readonly ToolCall[];
}
```

- `ChatMessage` 从一个接口改成按 `role` 区分的联合类型。所有变体都有 `role` 和 `content`，读这两个字段的代码不受影响。
- `LLMNode` 行为不变；`update(state, text, response)` 能从 `response.toolCalls` 读到工具调用。
- 交给模型的错误结果和其他库内文字都用英文，和 taugraph 现有的错误信息一致。
- 第 2 条（图片）会让 `user` 和 `tool` 消息的内容可以是多段；第 3 条（思考型模型）会在请求和回复里加思考相关的字段。这两条到时单独设计，本条不预留空字段。

## 3. Agent（新入口 `taugraph/agent`，目录 `src/agent/`）

和 `src/nodes` 一样是插件：只能从 `../index.js`、`../nodes/index.js` 和自己目录里导入（架构测试加一条规则）。`package.json` 的 `exports` 加 `"./agent"`。

### 3.1 工具

```ts
export interface Tool<A = Readonly<Record<string, unknown>>> {
  readonly name: string;
  readonly description?: string;
  /** 校验参数；也用来生成交给模型的 JSON Schema（Standard JSON Schema）。 */
  readonly input?: StandardSchemaV1<unknown, A>;
  /** 直接给 JSON Schema 时用它，优先于 input 生成的。 */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** 默认 "read"。"write" 的调用在 act_write 节点里执行。 */
  readonly effect?: Effect;
  run(args: A, ctx: ToolContext): MaybePromise<ToolResult>;
}

export interface ToolContext {
  readonly call: ToolCall;
  readonly signal: AbortSignal;
  /** 这次调用是崩溃后重新开始的（只可能是 read 工具，或带 allowWrites 接着跑的 write 工具）。 */
  readonly recovered: boolean;
}

export type ToolResult = string | { readonly content: string; readonly isError?: boolean };

export function tool<A>(definition: Tool<A>): Tool<A>; // 只为类型推断，原样返回
```

- 交给模型的 JSON Schema：有 `inputSchema` 就用它；否则 `input["~standard"].jsonSchema.input({ target: "draft-2020-12" })`，去掉 `$schema`；都没有就是 `{ type: "object" }`。
- 名字不合 `^[A-Za-z0-9_-]{1,64}$`、重名，在 `createAgent` 时抛 `TypeError`。

### 3.2 `createAgent`

```ts
export interface AgentConfig {
  readonly model: LLMModel;
  readonly tools?: readonly Tool<any>[];
  readonly system?: string;
  /** 最多调几次模型。默认 8。 */
  readonly maxRounds?: number;
  readonly toolChoice?: LLMRequest["toolChoice"];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** 每次调用前问一次：执行、拒绝，还是暂停问人。必须是纯函数：接着跑时会再调用一次。默认都执行。 */
  readonly approve?: (call: ToolCall, tool: Tool<any>, state: AgentState) => "run" | "deny" | "ask";
}

export interface AgentState {
  readonly messages: readonly ChatMessage[]; // 不含 system，system 每次从配置拼上
  readonly pending: readonly ToolCall[]; // 上一条助手消息里还没执行的调用
  readonly rounds: number;
  readonly final: string | null;
  readonly stop: null | "done" | "max_rounds";
}

export function createAgent(
  config: AgentConfig,
): Graph<AgentState, AgentInput, "think" | "act" | "act_write" | "finish">;
// AgentInput: { messages: readonly ChatMessage[] } 加上其余字段的可选形式
```

图的结构：

```
think ──有调用，第一个是 read──> act ─┐
  │  ──有调用，第一个是 write─> act_write ─┤ 还有待执行的调用 → act / act_write
  │                                   └ 没有了 → think
  └──没有调用，或达到 maxRounds──> finish
```

- `think`：用 `LLMNode` 实现（`llm_call` 事件和 `LLMNode` 完全一致）。请求是 `[system?, ...messages]`、`tools`（全部工具的 `ToolSpec`）、`toolChoice`、`temperature`、`maxTokens`。回复追加成一条助手消息；`pending` 是回复里的调用，最多取 32 个，多出的立即以错误结果回给模型（`Too many tool calls in one reply; at most 32 run`）；缺 `id` 的补成 `call_<轮次>_<序号>`。没有调用时 `final` 是回复文字，`stop` 是 `"done"`。调用前 `rounds` 已到 `maxRounds` 时不调模型，`stop` 记 `"max_rounds"`，`final` 是最后一条助手消息的文字（没有就是空串）。
- `act` 和 `act_write`：一样的逻辑，`act_write` 声明 `effect: "write"`。每一步只处理 `pending[0]`：
  1. 找工具，没有就回错误结果 `No tool named "x"`。`parseError` 有值时回 `Invalid arguments: <原因>`。
  2. 有 `input` 时校验参数，不过就回错误结果 `Invalid arguments: <问题>`，不执行。
  3. `approve`：`"deny"` 回错误结果 `The user did not allow this call`；`"ask"` 调用 `ctx.interrupt({ type: "tool_approval", call, effect })`，接着跑时传 `true`/`false`，或 `{ approved, reason? }`（拒绝时 reason 附在错误结果后面）；不是这几种值就按拒绝处理。
  4. 执行，写一条 `tool_call` 事件：`input: { id, name, arguments }`，`output: { content, isError }`，`meta: { effect, durationMs }`。工具抛错时把错误信息作为错误结果回给模型，`meta.error: true`；循环继续。
  5. 追加一条 `tool` 消息，`pending` 去掉第一个。
- `finish`：原样返回。
- 返回的图把 `maxSteps` 的默认值设为 `1000`（`maxRounds` 才是真正的上限），调用方传了就用调用方的。实现方式是包一层，转发 `run`、`runSync`、`resume`、`resumeSync`、`replay`。
- 状态 schema：手写的 Standard Schema，同步校验 `messages` 里每条消息的形状、`pending`、`rounds`（非负整数）、`final`、`stop`，补默认值（`pending: []`、`rounds: 0`、`final: null`、`stop: null`），错误带 `path`。

### 3.3 保证从哪来

- 回放：工具结果在 `exit` 的状态里，`recorded` 模式下同样的输入直接复用，不再调用模型和工具。
- 不重复写：`act_write` 是 write 节点，回放时状态一旦偏离就 `WRITE_BLOCKED`，除非 `allowWrites` 或覆盖。
- 崩溃：`act_write` 执行到一半崩溃，接着跑时 `UNKNOWN_OUTCOME`；`act` 直接重跑。
- 等人批准：`interrupt` 之前只有校验和 `approve`，都是纯的，接着跑时重跑没有副作用。

## 4. 示例和文档

- `examples/adapters/openai-compatible.ts`：请求里转换 `tools`（`{ type: "function", function: { name, description, parameters } }`）、`toolChoice`、助手消息的 `tool_calls`（参数转成 JSON 字符串）、`tool` 消息（`tool_call_id`）；回复里把 `tool_calls` 转成 `ToolCall`，参数不是 JSON 对象时 `arguments: {}`、`parseError` 写明原因。
- `examples/agent.ts`：一个 read 工具（查天气，假数据）和一个 write 工具（加待办，要批准），跑一遍、暂停、批准、回放。`pnpm example:agent`。
- README（中英文）：新增"Agent（`taugraph/agent`）"一节；"插件节点"表格补工具调用字段；Roadmap 不动。
- `docs/trace-format.md`：`tool_call` 一行写明 agent 的 `input`、`output`、`meta`。
- `docs/design.md`：新增"工具循环是一张图"一节，写明没选"一个节点包住循环"的原因。
- `CHANGELOG.md` 的 Unreleased 加一条。

## 5. 测试（`test/agent.test.ts`，类型在 `test/types.test.ts`）

- 不调工具时一轮结束：`final`、`stop: "done"`、`llm_call` 的请求里带 `tools`。
- 调一个 read 工具并把结果交回模型：`tool_call` 事件、`tool` 消息、第二轮模型看到结果。
- JSON Schema：从 Zod schema 生成（去掉 `$schema`）；`inputSchema` 优先。
- 参数不合 schema、工具不存在、工具抛错：都变成错误结果，循环继续，工具没执行（前两种）。
- write 工具走 `act_write`（`enter` 的 `meta.effect` 是 `write`）；换模型回放时到 write 步 `WRITE_BLOCKED`；`allowWrites` 时能过。
- `approve` 返回 `"ask"`：暂停，`pending.request` 是 `{ type: "tool_approval", call, effect }`；接着跑传 `true` 执行、`false` 拒绝；`"deny"` 直接拒绝。
- 达到 `maxRounds`：`stop: "max_rounds"`，不再调用模型。
- 一次回复超过 32 个调用：多出的变成错误结果。
- `parseError`：不执行，错误结果带原因。
- trace 在 `act_write` 中途截断后接着跑：`UNKNOWN_OUTCOME`。
- 同步模型和同步工具能用 `runSync`。
- 工具名不合法、重名：`createAgent` 抛错。
- 状态 schema：坏的消息被拒绝，错误带路径。
- 类型：`tool({ input: z.object(...) , run })` 里 `args` 的类型来自 schema；`createAgent` 返回的图的状态类型是 `AgentState`。
- 适配器（`test/adapter.test.ts`）：`tools`、`tool_calls`、`tool` 消息的双向转换，参数不是 JSON 时的处理。
- 架构：`src/agent` 只从允许的地方导入。
- 兄弟包：在 `taugraph-mcp`、`taugraph-pi` 里用本地构建的 taugraph 跑一遍它们的 `pnpm check`。
- 完成标准：`pnpm check` 全部通过，`pnpm example:agent` 跑通。

## 6. 不做

- 并行执行同一回复里的多个调用（第 9 条再说）。
- 流式输出。
- 把 agent 嵌进别的图当子图（第 9 条）。
- 图片和思考型模型（第 2、3 条）。
