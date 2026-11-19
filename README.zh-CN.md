# taugraph (τ)

[![CI](https://github.com/wangcao-hub/taugraph/actions/workflows/ci.yml/badge.svg)](https://github.com/wangcao-hub/taugraph/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/taugraph)](https://www.npmjs.com/package/taugraph) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**最小的带类型状态的 Agent 图编排底座（Minimal typed agent graph harness）。**

> Pi 是循环，τ 是轨迹。

一个很小的内核：在一个经过 schema 校验、不可变的状态上运行节点图，并把每一步写进只追加、可回放的 transcript。LLM 调用、工具、子 Agent、人工审批都是插件节点，内核对它们一无所知。

[English](./README.md) · [设计说明](./docs/design.md) · [Trace 格式](./docs/trace-format.md)

```
npm install taugraph zod     # 也可以用任何 Standard Schema 库：valibot、arktype ...
```

## 为什么叫 τ

在强化学习里，τ 是"轨迹"（trajectory）的标准符号，指 Agent 依次经历的状态和动作序列。taugraph 的一次运行正是这样一条轨迹：在图中走过的路径，每一步都带状态快照，并完整记录下来以便回放。这个名字也是向 [Pi](https://pi.dev) 致意：taugraph 沿用了它极简、只追加的设计（顺便一提，τ = 2π）。

## 为什么把流程写进代码

如果每一步都由模型决定，且每步正确率是 95%，三步流程全程不出错的概率约 86%，五步约 77%。提示词优化能把 95% 提到 97%，但到不了 100%。taugraph 把能事先写清楚的事（下一步跑什么、什么时候停下来问人、哪些调用会改变外部世界）从模型手里拿出来，放进类型化的图；模型只做只有它能做的事，比如理解一句回复、从几个允许的命令里选一个。

## 定位

|              | Pi                              | LangGraph                     | taugraph                             |
| ------------ | ------------------------------- | ----------------------------- | ------------------------------------ |
| 内核         | 单 Agent 思考循环（LLM ↔ 工具） | 带 channel / reducer 的状态图 | 图调度 + 类型化状态                  |
| 编排         | 扩展                            | 内核                          | 内核                                 |
| 状态         | 消息 transcript                 | channel，每步一个 checkpoint  | 一个经 schema 校验、冻结的 JSON 对象 |
| 暂停等待输入 | 对话本身                        | `interrupt()` + checkpointer  | `ctx.interrupt()`，从 trace 恢复     |
| 日志         | 只追加的 session                | 持久化后端里的 checkpoint     | 只追加的事件流，附带状态快照         |
| LLM / 工具   | 内置                            | 自带，常用 LangChain          | 插件节点，内核里没有                 |
| 运行时依赖   | 各家模型 SDK                    | LangChain core 等             | **无**                               |

## 内核戒律

1. 内核只做三件事：跑图、校验状态、追加日志。**不内置 LLM、工具、RAG、记忆**。
2. 状态必须有 schema（[Standard Schema](https://standardschema.dev)：Zod ≥ 3.24、Valibot ≥ 1、ArkType ≥ 2）。
3. 日志只追加，事件冻结，永不原地修改。
4. 一次执行就是一条可序列化的 trace，随时 replay，可替换任意节点或模型。
5. 没有隐式魔法：副作用都以显式事件记录；会改变外部世界的节点声明 `effect: "write"`，回放永远不会重复执行它。
6. 同步优先，异步可选。`runSync` 全程不碰 Promise，内核不绑定任何异步运行时。
7. 零运行时依赖。支持 Node ≥ 22、Bun、Deno 和浏览器（CI 覆盖 Node 22 和 24；0.2.0 发布时手工验证过 Bun、Deno 和 Chrome）。

这些规则由测试（`test/architecture.test.ts`）强制执行，不只是约定。

## 快速开始

```ts
import { createGraph, diffTraces, toJSONL } from "taugraph";
import { CodeNode, LLMNode, type LLMModel } from "taugraph/nodes";
import { z } from "zod";

const State = z.object({
  question: z.string(),
  raw: z.string().nullable().default(null),
  final: z.string().nullable().default(null),
});

// 任何模型提供方都能适配这个契约，参见 examples/adapters/openai-compatible.ts
const model: LLMModel = { id: "mock:echo", complete: (req) => ({ content: `echo: ${req.messages.at(-1)?.content}` }) };

const graph = createGraph(State, {
  start: "fetch",
  nodes: {
    fetch: CodeNode((s) => ({ ...s, raw: `关于 ${s.question} 的参考信息` })),
    answer: LLMNode({
      model,
      prompt: (s) => `参考：${s.raw}\n问题：${s.question}`,
      update: (s, text) => ({ ...s, final: text }),
    }),
  },
  edges: [{ from: "fetch", to: "answer" }],
  endNodes: ["answer"],
});

const { state, trace } = await graph.run({ question: "什么是 Agent 编排" });
const jsonl = toJSONL(trace); // 每行一个事件，可直接落盘或喂给评测

// 回放：answer 换成 mock，fetch 复用录制的输出，不会重新执行
const replay = await graph.replay(trace, {
  overrides: { answer: CodeNode((s) => ({ ...s, final: "mock答案" })) },
});
console.log(diffTraces(trace, replay.trace)); // { equal: false, firstDivergence: { step: 1, ... }, changedKeys: ["final"] }
```

状态类型、输入类型、节点 id 全部从 schema 和 `nodes` 推断。边里写错节点名、节点返回结构不对，都是编译错误。

## 核心概念

### State

一个对象，由 schema 描述。每个节点拿到的是**深度冻结**的当前状态，返回一个**新**状态。内核校验每次输出，失败时给出明确错误：

```ts
error.code; // "INVALID_STATE"
error.message; // Node "answer" (step 1) returned invalid state:
//   - final: Invalid input: expected string, received number
```

状态必须是纯 JSON（不能有 `Date`、`Map`、类实例）。正因如此，从磁盘加载的 trace 和内存中的 trace 回放结果完全一致。

### Node

```ts
type Node<S> = (state: S, ctx: RunContext) => S | Promise<S>;

interface RunContext {
  meta: { runId: string; nodeId: string; step: number; attempt: number; recovered: boolean };
  signal: AbortSignal; // 传给 fetch / 模型客户端
  trace: { append(event: PluginEvent): void }; // 记录一次副作用
  interrupt<T>(request?: unknown): T; // 暂停运行，直到 resume(trace, value)
}
```

任何符合这个签名的函数都是节点。ctx 里刻意不放模型、工具、向量库，这些由节点自己注入。

### Graph

起始节点、普通边、条件边、终止节点，仅此而已。

```ts
conditionalEdges: [{ from: "search", route: (s) => (s.docs ? "answer" : "rewrite"), targets: ["answer", "rewrite"] }];
```

图在构建时就做静态检查：未知节点、死胡同、带出边的终止节点、扇出（一个节点两条出边）都会被拒绝。路由函数必须是纯同步函数；如果路由需要 LLM 判断，就在节点里做，把结果写进状态再路由。`maxSteps`（默认 100）防止死循环。

### Trace

只追加的冻结事件列表：

```
run_start → enter → [llm_call | tool_call | ...] → exit → enter → pause → run_end(paused)
          → resume → enter → exit → ... → run_end
```

`enter` 携带输入状态，`exit` 携带输出状态，所以事件流同时也是快照序列（兼顾 Pi 的事件流和 LangGraph 的 snapshot）。节点用 `ctx.trace.append` 追加自己的事件，内核事件类型是保留的。

`run(input, { onEvent })` 会在运行继续之前把每个事件交给你的 sink。sink 抛错时运行以 `SINK_FAILED` 停止，保证没有哪一步是在没写日志的情况下执行的。完整格式见 [docs/trace-format.md](./docs/trace-format.md)。

### 暂停与恢复

节点调用 `ctx.interrupt(request)` 等待外部输入：人工确认、按钮点击、webhook 回调。运行返回 `{ status: "paused", pending: { nodeId, step, request } }`。trace 存到哪里都行，进程可以退出，之后：

```ts
const result = await graph.resume(trace, value); // 同一个 runId，追加到同一条 trace
```

恢复时，等待中的节点从头再跑一次，`ctx.interrupt` 返回 `value`；调用之前的代码会执行两次，所以那部分不要有副作用。一个节点里第 n 次 `interrupt` 拿到第 n 个值；循环中多次经过同一个节点，每次都有各自的值。**trace 本身就是 checkpoint**，不需要数据库或 checkpointer。一条暂停的 trace 只恢复一次；要拦住过期的回答（比如旧按钮被点了两次），拿 `pending.step` 和你存的最新 trace 对比。

不带值调用 `resume(trace)` 还能恢复中途中断的 trace（比如进程崩溃）：从最后一个完成的步骤继续。如果中断时正在执行 `write` 节点，它的结果未知，resume 会以 `UNKNOWN_OUTCOME` 停下。先去外部系统查证，再调用 `resume(trace, undefined, { allowWrites: true })`，节点会看到 `ctx.meta.recovered === true`。

### 副作用声明

```ts
CodeNode(placeOrder, { effect: "write" });
```

`write` 标记调用会改变外部世界的节点。它会记录在 `enter` 事件里；回放时内核拒绝实际执行它（`WRITE_BLOCKED`），除非用 mock 覆盖它，或者显式传 `allowWrites: true`。恢复一条停在半路的回放 trace 时同样如此。没声明的节点按 `read` 处理。

### Replay

```ts
graph.replay(trace, { overrides?, mode?: "recorded" | "live", allowWrites? })
```

以新的 runId 从录制的输入重新开始。`recorded` 模式（默认）下，未被覆盖、且收到的输入状态与录制完全一致的节点直接复用录制输出，没有副作用；一旦状态出现分歧，后续节点实时执行。`live` 模式全部重跑。只要某一步看到的状态和录制时一致，通过 `resume` 送进来的值会再次交给 `ctx.interrupt`，所以带人工交互的对话回放时不需要有人再回答一遍。`write` 节点按上一节的规则拦截。`diffTraces(a, b)` 给出第一个分歧步骤和变化的状态字段。

典型用途：换模型对比回答、mock 不稳定的工具、修复后在本地重跑失败的线上 trace、用录制的 trace 做回归评测（如 τ²-bench 一类基准）。

### 错误与重试

所有失败都是 `TaugraphError`，带 `code`（`INVALID_GRAPH`、`INVALID_STATE`、`INVALID_ROUTE`、`NODE_FAILED`、`MAX_STEPS`、`ABORTED`、`ASYNC_IN_SYNC_RUN`、`INVALID_TRACE`、`INVALID_EVENT`、`WRITE_BLOCKED`、`UNKNOWN_OUTCOME`、`NOT_RESUMABLE`、`SINK_FAILED`），以及 `nodeId`、`step`、schema `issues`、原始 `cause`，还有截至失败时的 `trace`。节点可以声明重试：`CodeNode(fn, { retry: { maxAttempts: 3 } })`，每次失败都记录为一条 `error` 事件。

## 插件节点（`taugraph/nodes`）

| 节点        | 作用                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `CodeNode`  | 确定性的状态转换                                                          |
| `LLMNode`   | 调用 `LLMModel`，记录 `llm_call` 事件，可选用 schema 解析 JSON 结构化输出 |
| `HumanNode` | 通过 `ctx.interrupt` 暂停等待回答，用 schema 校验，不合法就再问一次       |

`LLMNode` 只定义调用契约（`{ id, complete(request, { signal }) }`），OpenAI、Ollama 等通过小适配器接入。[`examples/adapters`](./examples/adapters/openai-compatible.ts) 里有一个 40 行的 OpenAI 兼容适配器。

自定义节点类型只需要一次 `defineNode`：

```ts
import { defineNode } from "taugraph";

interface Tool {
  name: string;
  run(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export const ToolNode = <S>(tool: Tool, apply: (s: S, out: unknown) => S) =>
  defineNode<S>(
    async (state, ctx) => {
      const output = await tool.run(state, ctx.signal);
      ctx.trace.append({ type: "tool_call", input: { tool: tool.name }, output });
      return apply(state, output);
    },
    { kind: "tool" },
  );
```

## 内核刻意不做

持久化后端、分布式 worker、并行节点、嵌套子图、内置工具、记忆、向量库、可视化画布、事件路由、触发器和调度器。同一步里的并发调用没问题：在节点里用 `Promise.all`。其中一部分会以独立插件包出现，但都不会进入内核。

## 路线图

- `taugraph/tools`：shell、文件系统等工具节点
- `taugraph/subagent`：委派外部 Agent（ACP、Pi 实例）
- `taugraph/compact`：trace 与状态压缩
- `taugraph/tui`：终端 trace 查看器

## 开发

```
pnpm install
pnpm check          # 类型检查 + lint + 测试
pnpm build
pnpm example:rag       # 检索 → 回答，带重试分支、JSONL trace 和回放
pnpm example:checkout  # 人工交互：暂停/恢复、LLM 只选命令、回放不会重复下单
```

设置 `TAUGRAPH_BASE_URL`、`TAUGRAPH_MODEL`（需要时加 `TAUGRAPH_API_KEY`）即可让示例连接真实的 OpenAI 兼容接口，例如 Ollama：`http://localhost:11434/v1`。

参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
