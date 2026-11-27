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

## 工作方式

模型只是节点的一种。它把一个值写进状态，下一步做什么由代码读这个值来决定。

```mermaid
flowchart LR
  reply(["用户回复<br/>resume(trace, value)"]) --> ask
  ask["confirm<br/>HumanNode · ctx.interrupt"] --> classify
  classify["classify<br/>LLMNode<br/>只能输出 4 个命令之一"] --> route{"条件边<br/>纯代码"}
  route -->|confirm| place["下单<br/>effect: write"]
  route -->|modify| quote["重新报价<br/>代码"]
  route -->|explore| explain["回答问题<br/>代码"]
  route -->|cancel| cancelled["取消<br/>代码"]
  quote -.-> ask
  explain -.-> ask
  classDef human fill:#fef3c7,stroke:#d97706,color:#111
  classDef model fill:#ede9fe,stroke:#7c3aed,color:#111
  classDef code fill:#e0f2fe,stroke:#0284c7,color:#111
  classDef write fill:#fee2e2,stroke:#dc2626,color:#111
  class reply,ask human
  class classify model
  class route,quote,explain,cancelled code
  class place write
```

<sub>[`examples/checkout.ts`](./examples/checkout.ts) 的流程图。黄色等人回复；紫色是唯一调用模型的地方，输出必须是四个命令之一；蓝色是可以单元测试的代码；红色会改变外部世界，回放时默认被拦截，除非你显式允许。</sub>

一次运行之后能做的所有事，都从同一条只追加的日志算出来，没有第二份存储需要同步。

```mermaid
flowchart LR
  exec["run · resume"] -- "追加，先写日志" --> trace[("trace · JSONL<br/>每一步的状态<br/>LLM 与工具调用<br/>人工回答")]
  trace -- "resume(trace, value)" --> pause["暂停与恢复<br/>不需要 checkpointer"]
  trace -- "resume(trace)" --> recover["崩溃恢复<br/>未完成的写操作: UNKNOWN_OUTCOME"]
  trace -- "replay(trace, overrides)" --> cf["反事实回放<br/>拦截写操作"]
  trace -- "diffTraces · 导出" --> evals["回归评测"]
  classDef log fill:#f1f5f9,stroke:#475569,color:#111
  class trace log
```

## 设计上的创新

1. **trace 就是 checkpoint。** 暂停、恢复、崩溃恢复都从只追加的日志推出来，内核里没有 checkpointer、线程存储或存储接口，JSONL 存在哪里都行。（LangGraph 的 `interrupt()` 需要 checkpointer 和 thread id。）
2. **反事实回放。** 回放时，一个步骤只有在收到的输入状态和录制时完全一致时才复用录制结果；看到不同状态的步骤都会实际执行。"如果第 2 步换个模型会怎样"只需要一次调用，第一个变化之前的步骤不产生任何调用开销。（LangGraph 回放会重新执行 checkpoint 之后的所有节点，包括 LLM 和 API 调用；Temporal 这类持久化执行引擎把偏离历史当作不确定性错误。）

```mermaid
flowchart LR
  s0["第 0 步 · quote<br/>复用录制"] --> s1["第 1 步 · confirm<br/>复用人工回答: make it 2"] --> s2["第 2 步 · classify<br/>新模型判断为 confirm"] --> s3["第 3 步 · 下单<br/>WRITE_BLOCKED"]
  classDef rec fill:#f1f5f9,stroke:#94a3b8,color:#111
  classDef new fill:#ede9fe,stroke:#7c3aed,color:#111
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#111
  class s0,s1 rec
  class s2 new
  class s3 stop
```

<sub>用一个过于激进的分类模型回放 checkout 对话。第 0、1 步来自 trace，包括用户当时的回答。新模型把 "make it 2" 当成了确认，这次运行本来会下单，回放在这里停下，没有真的下单。</sub>

3. **回放默认不会重复副作用。** `effect: "write"` 是节点的一部分，不是约定。回放以及恢复中的回放都不会实际执行写节点，除非你覆盖它或传 `allowWrites: true`。进程崩溃时正在执行的写操作会变成 `UNKNOWN_OUTCOME`，不会被悄悄重试；失败的写操作只有声明了幂等才会重试。
4. **对话直接变成测试用例。** 人工回答作为输入记在 trace 里。回放带人工交互的运行不需要有人在场：只要步骤看到的状态和录制时一致，每个 `ctx.interrupt` 都拿到当时的回答。（LangGraph 回放时会重新触发 interrupt。）
5. **模型只做选择，路由交给代码。** 路由是基于状态的同步函数，异步路由在运行时会被拒绝。模型只能往状态里写一个经过 schema 校验的值，比如四个命令之一，再由边读取这个值。路由里没法 await 模型调用，所以模型的决策只能发生在节点里，并由 trace 记录下来。

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
7. 零运行时依赖。支持 Node ≥ 22、Bun、Deno 和浏览器（CI 覆盖 Node 22 和 24；0.4.1 发布时手工验证过 Bun，0.2.0 发布时手工验证过 Deno 和 Chrome）。

这些规则由测试（`test/architecture.test.ts`）强制执行，不只是约定。

## 快速开始

```ts
import { createGraph, diffTraces, toJSONL } from "taugraph";
import { CodeNode, LLMNode, type LLMModel, textOf } from "taugraph/nodes";
import { z } from "zod";

const State = z.object({
  question: z.string(),
  raw: z.string().nullable().default(null),
  final: z.string().nullable().default(null),
});

// 任何模型提供方都能适配这个契约；OpenAI 兼容接口直接用 taugraph/openai
const model: LLMModel = {
  id: "mock:echo",
  complete: (req) => ({ content: `echo: ${textOf(req.messages.at(-1)?.content ?? "")}` }),
};

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

TypeScript 5.9 以下的版本中，如果节点返回字面量值（例如联合类型字段里的 `outcome: "ordered"`），类型推断会失败，需要写成 `CodeNode<State>(...)`。TypeScript 5.9 和 7 不需要标注。

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
  meta: { runId: string; nodeId: string; step: number; attempt: number; recovered: boolean; idempotencyKey: string };
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

相邻的快照共享没有变化的部分。内存里总是如此；用 `toJSONL`、`createTraceEncoder` 或 `fileStore` 写到磁盘上时也如此。它们写出 v2 格式，每个快照存成相对上一个快照的改动，所以 trace 随变化的多少增长，而不是随状态的大小增长。这一点对往数组末尾追加元素和修改对象的键成立；在长数组开头插入元素，或者调换对象键的顺序，仍然会把那个数组或对象整个重写一遍。

`run(input, { onEvent })` 会在运行继续之前把每个事件交给你的 sink。sink 可以返回 Promise：`run` 在每个内核事件之后等它完成，所以写操作步骤的 `enter` 在节点执行前就已存好，节点追加的事件在这一步结束前存好。对 sink 的调用不会重叠。sink 抛错或 reject 时运行以 `SINK_FAILED` 停止，保证没有哪一步是在没写日志的情况下执行的。`runSync` 只接受同步的 sink。完整格式见 [docs/trace-format.md](./docs/trace-format.md)。

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

所有失败都是 `TaugraphError`，带 `code`（`INVALID_GRAPH`、`INVALID_STATE`、`INVALID_ROUTE`、`NODE_FAILED`、`MAX_STEPS`、`ABORTED`、`TIMEOUT`、`ASYNC_IN_SYNC_RUN`、`INVALID_TRACE`、`INVALID_EVENT`、`WRITE_BLOCKED`、`UNKNOWN_OUTCOME`、`NOT_RESUMABLE`、`SINK_FAILED`），以及 `nodeId`、`step`、schema `issues`、原始 `cause`，还有截至失败时的 `trace`。

```ts
CodeNode(fetchPrices, { retry: { maxAttempts: 4 }, timeoutMs: 10_000 });
```

- **哪些错误会重试。** 默认由 `isRetryable(error)` 判断。重试也修不好的内核错误（`INVALID_STATE`、`ABORTED`、`SINK_FAILED` 等）不重试；HTTP 4xx 也不重试，但 408、409、425、429 除外，状态码取自错误本身或它的 `cause` 链上的数字 `status`。其他错误都重试，包括它不认识的错误。想自己判断就传 `retryOn(error)`，它收到的是节点抛出的原始错误。
- **等多久。** 指数退避：先等 500 毫秒，之后每次翻倍，最多 30 秒，再随机减去最多一半（`backoff: { initialMs, factor, maxMs, jitter }`，设为 `false` 则立即重试）。错误上带 `retryAfterMs` 时至少等这么久，`taugraph/openai` 会从 `Retry-After` 读出它。它不受 `maxMs` 限制；如果服务端可能要求很长的等待，用 `retryOn` 自己判断，或者中止运行（`runSync` 会在整个等待期间阻塞线程）。`run` 用定时器等待，运行被中止时立即停止；`runSync` 会阻塞线程，在不允许阻塞的地方（浏览器主线程）报 `ASYNC_IN_SYNC_RUN`。每次失败都记为一条 `error` 事件，带 `willRetry`；要重试时还带 `delayMs`。
- **写操作节点。** `write` 节点配了 `retry` 就必须写 `idempotent: true`，否则 `defineNode` 报错：重复下单就是第二笔订单。`ctx.meta.idempotencyKey`（`<runId>:<step>`）在同一步的每次尝试里都相同，崩溃后恢复时也相同；把它传给外部接口（比如作为 `Idempotency-Key` 请求头），重复执行就是安全的。
- **超时。** 节点上的 `timeoutMs` 让 Promise 没有按时完成的这次尝试以 `TIMEOUT` 失败，并中止 `ctx.signal`。`TIMEOUT` 和其他错误一样会重试。同步代码无法被打断。`write` 节点因超时或中止停下时，它的 `error` 事件带 `outcome: "unknown"`：副作用可能发生了，也可能没有。

## 插件节点（`taugraph/nodes`）

| 节点        | 作用                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| `CodeNode`  | 确定性的状态转换                                                                        |
| `LLMNode`   | 调用 `LLMModel`（含工具调用），记录 `llm_call` 事件，可选用 schema 解析 JSON 结构化输出 |
| `HumanNode` | 通过 `ctx.interrupt` 暂停等待回答，用 schema 校验，不合法就再问一次                     |

`LLMNode` 只定义调用契约（`{ id, complete(request, { signal }) }`），其他服务商通过小适配器接入。[`taugraph/openai`](#openai-兼容模型taugraphopenai) 负责对接 OpenAI 兼容接口。消息可以带图片，见[图片](#图片)。

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

## Agent（`taugraph/agent`）

`createAgent` 把"模型 ↔ 工具"循环变成一张普通的 taugraph 图。每次模型调用、每次工具调用都是单独的一步，所以上面说的保证落到每一次调用上：都在 trace 里，回放时复用，回放不重复写操作，写到一半崩溃会停在 `UNKNOWN_OUTCOME`，也能停下来等人批准。

```ts
import { createAgent, tool } from "taugraph/agent";
import { z } from "zod";

const weather = tool({
  name: "weather",
  description: "Today's weather for a city",
  input: z.object({ city: z.string() }), // 校验参数，也变成模型看到的 JSON Schema
  run: ({ city }) => `${city}: cloudy, -2~5°C`,
});

const addTodo = tool({
  name: "add_todo",
  effect: "write", // 在写步骤里执行
  input: z.object({ text: z.string() }),
  run: ({ text }) => `added "${text}"`,
});

const agent = createAgent({
  model, // 任何适配器支持工具调用的 LLMModel
  tools: [weather, addTodo],
  system: "You help with the day.",
  approve: (call, t) => (t.effect === "write" ? "ask" : "run"),
});

const result = await agent.run({ messages: [{ role: "user", content: "今天穿什么？" }] });
// 停在 add_todo：result.pending.request 是 { type: "tool_approval", call, effect: "write" }
const done = await agent.resume(result.trace, true); // 或 false，或 { approved: false, reason }
console.log(done.state.final);
```

```
think ──读的调用──▶ act ────────┐
  ▲   ──写的调用──▶ act_write ──┤  还有调用：act / act_write
  └─────────────────────────────┘  没有了：think
think ──没有调用，或到了 maxRounds──▶ finish
```

- 状态是 `{ messages, pending, rounds, final, stop }`，用内置的 Standard Schema 校验，不需要装校验库。
- 工具定义沿用 MCP 的字段（`name`、`description`，`inputSchema` 是 JSON Schema）。给了 `inputSchema` 就用它，否则通过 [Standard JSON Schema](https://standardschema.dev/json-schema) 从 `input` 生成（Zod 4、Valibot、ArkType）。
- 参数不合 schema、工具不存在、参数读不懂、工具抛错，都作为错误结果交回模型，循环继续。
- `maxRounds`（默认 8）限制模型调用次数；一次回复最多执行 32 个调用。每次工具执行是一条 `tool_call` 事件。
- `lastRound: "answer"`：`maxRounds` 允许的最后一次模型调用要求模型用文字作答：工具仍留在请求里，同时发 `toolChoice: "none"`，前面有工具结果时，请求末尾再加一条用户消息，告诉模型工具次数已经用完（`lastRoundNote`，按你的提示词的语言写，默认是 `AGENT_DEFAULTS.lastRoundNote`）。这条提示只在这次请求和它的 `llm_call` 事件里，不进 `state.messages`。并不是每个服务都遵守 `"none"`（Ollama 会忽略），所以模型仍返回的工具调用会被忽略。这时运行以 `stop: "done"` 结束，`final` 可能为空；`rounds === maxRounds` 说明用满了轮数。默认 `"tools"`。
- `createAgent` 的 `timeoutMs` 限制每次模型调用（超时报 `TIMEOUT`，`retry` 会重试）。工具的 `timeoutMs` 限制它的每次执行：只读工具超时时，错误结果交回模型，循环继续；写操作工具超时时，运行以 `TIMEOUT` 失败，因为副作用是否发生无从知道。
- 模型接口新增可选的 `tools`、`toolChoice`、`toolCalls`，以及 `tool` 消息（自己转换 `role` 的适配器要补一个 `tool` 分支）；[OpenAI 兼容适配器](#openai-兼容模型taugraphopenai) 负责转换。`pnpm example:agent` 能把整套跑一遍。工具结果可以带图片（见[图片](#图片)）。

## OpenAI 兼容模型（`taugraph/openai`）

`openAICompatible` 把任何 OpenAI 兼容的 `/chat/completions` 接口变成一个 `LLMModel`：OpenAI、DeepSeek、Qwen、Kimi、Ollama、vLLM、LM Studio 等。它负责转换工具调用、图片和思考，用全局的 `fetch`，不引入任何依赖。内核和 `taugraph/nodes` 不带任何服务商代码；这个入口和 `taugraph/agent` 一样是可选插件。

```ts
import { openAICompatible } from "taugraph/openai";

const model = openAICompatible({
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: process.env.DEEPSEEK_API_KEY,
});
```

| 选项              | 作用                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `baseURL`         | `/chat/completions` 之前的部分，例如 `https://api.openai.com/v1` 或 `http://localhost:11434/v1` |
| `model`           | 接口要求的模型名                                                                                |
| `apiKey`          | 可选，作为 Bearer token 发送                                                                    |
| `resolveImage`    | 发请求时读取 `media:abc` 这类图片引用，见[图片](#图片)                                          |
| `reasoningParams` | 把思考档位换成请求参数，见[思考型模型](#思考型模型)                                             |
| `sendReasoning`   | 设为 `false` 时不再把模型自己的思考发回，用于拒收这个字段的接口                                 |
| `tokenLimit`      | OpenAI 的推理模型要用 `"max_completion_tokens"`；默认 `"max_tokens"`                            |
| `fetch`           | 代替全局的 `fetch`，用于代理或测试                                                              |

模型的 `id` 是 `openai-compatible:<model>`。它会记进每条 `llm_call` 事件；`model` 等于它的 assistant 消息算作这个模型自己的，回传思考时据此判断。

响应不是 2xx 时抛 `HTTPError`，带 `status`、`url` 和 `retryAfterMs`（从 `Retry-After` 读出），所以配了 `retry` 的 `LLMNode` 会重试 408、409、425、429 和 5xx，等待时间不短于 `Retry-After` 的要求，遇到其他 4xx 立即放弃。

其他服务商写一个小适配器就能接入同一个契约：`LLMModel` 就是 `{ id, complete(request, { signal }) }`。

## 图片

用户消息和工具结果可以带图片，这时 `content` 是按顺序排列的片段数组；`system` 和 `assistant` 消息仍然只有文字。

```ts
const question: ChatMessage = {
  role: "user",
  content: [
    { type: "text", text: "哪一张是小票？" },
    { type: "image", data: base64, mimeType: "image/png" }, // 图片内容，base64
    { type: "image", url: "media:9f2c" }, // 或者一个引用，适配器调用模型时再读取
  ],
};
```

- 地址可以是 `https:`、`data:`，也可以是你自己定的引用。trace 会记下每一步的状态和每次请求。`toJSONL` 和 `fileStore` 会把工具返回的 base64 图片写三次（`tool_call` 的输出、把它加进状态的 `exit` 补丁、下一次请求），把用户发送的图片写两次（进入状态时、第一次发送它的请求里）；自己写的 sink 如果每个事件写一次 `JSON.stringify(event)`，每一步都会再存一遍。引用无论哪种方式都只占几个字节。`recorded` 模式回放时，状态和录制一致的步骤直接复用录制结果，引用只在需要重新执行的步骤里才要能读取。
- 工具用同样的方式返回图片：`run: () => ({ content: [{ type: "text", text: "the page" }, { type: "image", url: "media:shot1" }] })`。
- MCP 工具的结果只含文字和图片块时可以原样返回；音频、资源等其他块会让运行失败，要先转换。
- 写适配器时，`resolveImages(messages, resolve)` 把 `data:` 地址拆成 base64，其他地址换成 `resolve` 的返回值。只能发文字的适配器用 `textOf(m.content)`；遇到图片它会报错，除非传了 `{ imagePlaceholder }`，这样模型不会对一张没收到的图作答。
- [OpenAI 兼容适配器](#openai-兼容模型taugraphopenai) 原样发送 http(s) 和 `data:` 地址，其他地址交给 `resolveImage` 读取。OpenAI 的 `tool` 消息只能放文字，所以工具返回的图片会放进紧跟其后的一条 `user` 消息。

```ts
const model = openAICompatible({
  baseURL: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  resolveImage: async (url) => {
    const id = /^media:([\w-]+)$/.exec(url)?.[1];
    if (!id) throw new Error(`Unknown image reference: ${url}`);
    return { type: "image", mimeType: "image/png", data: (await readFile(`media/${id}.png`)).toString("base64") };
  },
});
```

## 思考型模型

请求上的 `reasoning` 决定模型先想多少：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"` 或 `"max"`。不填时适配器什么都不发，由模型用默认值。适配器把档位换成各家的设置；知道模型有哪些档的适配器就近取档，对接按 token 预算控制的服务时把档位换算成预算。

```ts
const agent = createAgent({ model, tools, reasoning: "high" }); // 这次运行里的每一次模型调用
```

- 回复里，模型想了什么在 `response.reasoning`（`{ text, signature?, redacted? }[]`），思考用掉的 token 数在 `usage.reasoningTokens`，已经算在 `outputTokens` 里。两者都会记进 `llm_call` 事件。
- 有几家要求工具循环的下一次请求原样带回模型之前的思考，否则拒绝请求：DeepSeek V4（`reasoning_content`）、Claude（带签名的思考块）、Gemini 3（一步里第一个工具调用上的 `thoughtSignature`，存在 `ToolCall.signature`）。agent 把思考和签名存进它写的 assistant 消息，下一轮自动带上。
- 签名只对写它的模型有效，所以 agent 写的每条 assistant 消息都记下 `model`，也就是 `LLMModel.id`。适配器只在 `m.model` 等于自己的 `id` 时发回思考和签名，回放时换了模型也不会把一个模型的签名发给另一个模型。
- assistant 消息记有 `model`，所以换模型回放时，从第一次重新执行的模型调用起状态就和录制不同，哪怕新模型回答一样；之后的步骤实时执行，写操作步骤会以 `WRITE_BLOCKED` 停下。
- [OpenAI 兼容适配器](#openai-兼容模型taugraphopenai) 把档位原样作为 `reasoning_effort` 发出（`"off"` 写成 `"none"`），从回复里读 `reasoning_content` 或 `reasoning`，并把自己的 `reasoning_content` 发回；对不接受这个字段的服务（如 Groq 和 Cerebras）设 `sendReasoning: false`。服务有自己的开关、或不接受某一档时，在 `reasoningParams` 里换算档位：

```ts
// DeepSeek V4：一个思考开关，档位由它自己换算
const deepseek = (level: ReasoningLevel) =>
  level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: level };
// 部署在 vLLM 或 SGLang 上的 Qwen
const qwen = (level: ReasoningLevel) => ({ chat_template_kwargs: { enable_thinking: level !== "off" } });

const model = openAICompatible({
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  reasoningParams: deepseek,
});
```

## 存成文件（`taugraph/file`）

`fileStore(dir)` 给每个 run 存一个 JSONL 文件，每个事件都在 run 走下一步之前追加写入。崩溃后找出没跑完的 run，接着跑：

```ts
import { fileStore } from "taugraph/file";

const store = fileStore("./runs");
await graph.run(input, { onEvent: store.sink });

// 重启以后
for (const run of store.list()) {
  if (run.status !== "interrupted") continue;
  try {
    await graph.resume(store.load(run.runId)!, undefined, { onEvent: store.sink });
  } catch (error) {
    // UNKNOWN_OUTCOME：写操作步骤当时正在执行。先核实外部系统，再用 { allowWrites: true } 恢复。
    console.error(run.runId, error);
  }
}
```

- 一个图用一个目录：上面的恢复循环会用同一个图恢复目录里所有中断的 run。
- `list()` 给出五种状态：`running`（有活着的进程持有这个 run 的锁）、`interrupted`（没有结束，也没有进程在写）、`paused`、`completed`、`failed`。它会跳过无法当作 trace 读取的文件；对这些文件，`load` 会抛出 `INVALID_TRACE`。
- `remove(runId)` 删除一个 run 的文件，返回原来有没有这个文件。如果别的活着的进程或这个存储自己正在写这个 run，它会抛错。
- 崩溃可能留下写了一半的最后一行。`load` 会忽略它，接着跑之前存储会把它截掉。对当时正在执行的写操作步骤，`resume` 会抛出 `UNKNOWN_OUTCOME`，不会再跑一遍。
- `durability` 决定什么时候 `fsync`：`"writes"`（默认）在写操作步骤开始前、暂停时和结束时；`"every"` 每个事件之后；`"none"` 从不。用 `"writes"` 时，断电可能丢掉只读步骤，重跑它们是安全的，但不会让写操作步骤跑两遍。一个新 run 如果还没走到写操作步骤、暂停或结束，断电可能让它整个丢失。
- 写入期间每个 run 有一个锁文件，两个进程不能同时追加同一个 run。已经退出的进程留下的锁会被接管。
- 锁只在同一台机器（同一个 pid 命名空间）的进程之间有效。共享同一个卷的容器看不到彼此的进程，所以不要让两个容器写同一个目录。
- 同一个线程里的两个存储不能写同一个 run；在 Node 上，跨 worker 线程也是如此。Bun 和 Deno 上锁没法区分 worker 线程，所以在那里一个目录只从一个线程写。用 `worker.terminate()` 停掉的 worker 会一直占着它的锁，直到进程退出。
- 进程如果死在不巧的时刻，可能留下 `<runId>.lock.takeover`。报错里写明了是哪个文件；确认没有进程在写这个 run 后删掉它。在不支持硬链接的文件系统上，这样的进程或者断电还可能留下一个空的 `<runId>.lock`：`list()` 会把这个 run 报成 `running`，存储会拒绝这个锁，直到它写入后满 10 秒，然后接管它。崩溃还可能留下 `<runId>.lock.<pid>.<random>` 临时文件，它们无害，可以放心删掉。
- 只用 `node:fs`（Node、Bun、Deno），不引入依赖。run id 只能包含英文字母、数字、`_`、`-` 和 `.`（不能打头），最长 128 个字符。

## 集成

| 包                                                          | 用途                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [taugraph-mcp](https://github.com/wangcao-hub/taugraph-mcp) | 把流程作为 MCP 工具提供给任意 MCP 客户端：Claude、Cursor、Kiro、AgentScope Java 等。`npx -y taugraph-mcp ./flows` |
| [taugraph-pi](https://github.com/wangcao-hub/taugraph-pi)   | 在 [Pi](https://pi.dev) 编程 agent 里把流程作为工具运行。`pi install npm:taugraph-pi`                             |

两者都沿用同一种 trace 格式，通过它们录下的运行可以直接用本包回放和对比。

## 内核刻意不做

持久化后端、分布式 worker、并行节点、嵌套子图、内置工具、记忆、向量库、可视化画布、事件路由、触发器和调度器。同一步里的并发调用没问题：在节点里用 `Promise.all`。其中一部分会以独立插件包出现，但都不会进入内核。`taugraph/file` 和 `taugraph/agent` 一样，是内核之外的可选入口。

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
