# 可靠性设计：重试、超时、异步 sink

> 2026-11-25 定稿。实现以代码和测试为准。和 trace v2、`taugraph/file` 一起作为 0.4.0 发布。

## 1. 目标

- 重试现在只有 `maxAttempts`：立即重试、不等待；除 4 个内核错误码外什么都重试，包括写操作节点。下单节点抛错后会马上再下一次，和"写操作不会被悄悄重复"矛盾；对 400 这种必然失败的请求白白重试；对 429 立即重试只会更糟。
- 没有节点超时：一个挂住的请求会让整个运行一直等下去。
- `onEvent` 只能是同步的，写数据库、S3 这类异步存储时失去"先写后跑"的保证。
- `taugraph/openai` 抛出的错误不带状态码，内核无从判断能不能重试；请求里用 `max_tokens`，OpenAI 的推理模型要求 `max_completion_tokens`。

和用户确认过的选择：

- 写操作节点配了重试必须显式声明 `idempotent: true`；内核提供幂等键。
- 默认只跳过明确不该重试的错误，其余都重试。
- 重试之间按指数退避等待；`runSync` 里用 `Atomics.wait` 同步阻塞，不能阻塞的环境报错。

## 2. 重试（`src/core`）

### 2.1 API

```ts
export interface RetryPolicy {
  /** Total attempts including the first one. Must be an integer >= 1. */
  readonly maxAttempts: number;
  /** Wait between attempts. Default { initialMs: 500, factor: 2, maxMs: 30_000, jitter: 0.5 }; false retries at once. */
  readonly backoff?:
    | false
    | {
        readonly initialMs?: number;
        readonly factor?: number;
        readonly maxMs?: number;
        readonly jitter?: number;
      };
  /** Whether an error is worth another attempt. Default: isRetryable. */
  readonly retryOn?: (error: unknown) => boolean;
  /** Required on write nodes with retry: repeating the node is safe (for example through ctx.meta.idempotencyKey). */
  readonly idempotent?: boolean;
}
```

- `ctx.meta.idempotencyKey`：`<runId>:<step>`，同一步的每次尝试相同，崩溃后恢复时也相同。
- `isRetryable(error)` 从 `taugraph` 导出。
- `defineNode` 校验：`backoff` 的数值为有限非负数（`factor >= 1`，`jitter` 在 0 到 1 之间）；`retryOn` 是函数；写操作节点（`effect: "write"`）带 `retry` 而 `idempotent` 不为 `true` 时抛 `TypeError`：`defineNode: a write node with retry must set retry.idempotent: true (use ctx.meta.idempotencyKey to make repeats safe)`。`createGraph` 对直接带属性的节点函数做同样的检查（信息以 `createGraph: node "<id>"` 开头）。

### 2.2 判断规则（`isRetryable`）

- 不重试：`TaugraphError` 且错误码是 `INVALID_STATE`、`INVALID_ROUTE`、`INVALID_EVENT`、`WRITE_BLOCKED`、`UNKNOWN_OUTCOME`、`NOT_RESUMABLE`、`ABORTED`、`ASYNC_IN_SYNC_RUN`、`SINK_FAILED` 之一。
- 不重试：错误本身或它的 `cause` 链（最多 5 层）上有数字 `status`，且 `400 <= status < 500`，但 408、409、425、429 除外。
- 其他都重试：429、5xx、`TIMEOUT`、网络错误、`LLMOutputError`、未知错误。
- 内核在节点抛出的原始错误上判断（`NODE_FAILED` 包装之前），`retryOn` 收到的也是原始错误。

### 2.3 等待

- 第 n 次重试之前（n 从 1 开始）等待 `min(maxMs, initialMs × factor^(n-1)) × (1 − jitter × random)`。
- 错误本身或 `cause` 链上有数字 `retryAfterMs` 时，等待取它和上面结果中较大的一个（不受 `maxMs` 限制）。
- `run`：用定时器等待；运行被中止时立即停止等待，报 `ABORTED`。
- `runSync`：用 `Atomics.wait` 阻塞当前线程；环境不允许时（浏览器主线程）报 `ASYNC_IN_SYNC_RUN`：`runSync() cannot wait <ms>ms before retrying here; use run()`。
- `error` 事件的 `meta` 新增 `delayMs`（`willRetry` 为 true 时）。
- 回放复用录制结果时不经过重试，不等待。

### 2.4 插件

- `LLMNode` 的 `retry` 原样传下去（`kind: "llm"`，不是写操作节点）。
- agent 的 `config.retry` 作用于模型调用；工具没有重试。

## 3. 超时

### 3.1 API

- `NodeMeta.timeoutMs?: number`（正整数），`defineNode` / `CodeNode` 的选项可以设。
- `LLMNode` 配置新增 `timeoutMs`。
- `createAgent({ timeoutMs })` 作用于每次模型调用；`tool({ timeoutMs })` 作用于这个工具的每次调用。

### 3.2 语义

- 每个节点得到自己的 `ctx.signal`：运行的中止信号和这个节点的超时信号合并（`AbortSignal.any`）。超时时这个信号被触发，原因为 `TIMEOUT` 错误。
- 节点返回的 Promise 在 `timeoutMs` 内没有完成时，内核不再等它，这一步失败，错误码 `TIMEOUT`，信息 `Node "<id>" (step <n>) timed out after <ms>ms`。`TIMEOUT` 可以重试（写操作节点只在 `idempotent: true` 时）。
- 写操作节点因超时或中止而停下时，`error` 事件的 `meta` 带 `outcome: "unknown"`。
- 超时之后节点才返回的结果被丢弃；它之后追加的 trace 事件照常报"步骤已结束"，不影响运行；它之后的 reject 不会变成未处理的 Promise 拒绝。
- 同步节点无法被打断，`timeoutMs` 只对返回 Promise 的节点生效；`runSync` 里不会触发。

### 3.3 agent 的工具超时

- 只读工具超时：作为错误结果交回模型，内容 `Tool "<name>" timed out after <ms>ms`，循环继续。
- 写操作工具超时：这一步失败，错误码 `TIMEOUT`，`meta` 带 `outcome: "unknown"`，不交回模型。

## 4. 异步 sink

- `onEvent?: (event: TraceEvent) => void | Promise<void>`。
- 按事件顺序调用：上一次返回的 Promise 完成后才调用下一次。
- `run` 里：内核事件（`run_start`、`enter`、`exit`、`pause`、`resume`、`error`、`run_end`）之后等 sink 完成再继续；节点里 `ctx.trace.append` 追加的插件事件排队，内核在这一步写 `exit` 之前等它们写完。写操作步骤的 `enter` 一定在节点开始执行前写完。
- sink 的 Promise 被 reject：运行以 `SINK_FAILED` 停下（同步抛错的语义不变）。在等插件事件时才发现失败，那一步判为失败。
- 运行失败时 `run_end` 仍交给 sink，内核等它完成，但忽略这次的错误。
- 运行被中止时不再等 sink，直接 `ABORTED`。
- `runSync` 里 sink 返回 Promise：`ASYNC_IN_SYNC_RUN`，信息 `onEvent returned a Promise; use run() for an async sink`。同步 sink 的行为完全不变。
- 实现：`TraceLog` 记下未完成的 sink 链；引擎在上述时刻把它交给驱动器等待，复用"同步驱动器遇到 Promise 就报错"的机制。

## 5. `taugraph/openai`

- 响应不是 2xx 时抛 `HTTPError`（新导出）：`status`、`retryAfterMs`（从 `Retry-After` 解析，秒数或 HTTP 日期）、`url`；`message` 和现在一样带响应正文前 500 个字符。
- 新选项 `tokenLimit?: "max_tokens" | "max_completion_tokens"`，默认 `"max_tokens"`。
- 网络错误不特别处理（按未知错误重试）。

## 6. 文档

- README（中英文）："错误与重试"一节重写（判断规则、等待、`idempotent` 和幂等键、超时）；Trace 一节补异步 sink；`taugraph/openai` 的选项表补 `tokenLimit`，并说明 `HTTPError`。
- `docs/design.md`：写操作节点的重试为什么要显式声明；为什么按 `status` 字段判断而不认错误类；异步 sink 为什么按顺序调用、在哪些时刻等待。
- `docs/trace-format.md`：`error.meta` 新增 `delayMs`、`outcome`。
- CHANGELOG：并入 0.4.0 一节。写操作节点重试须声明 `idempotent`、默认开始等待、4xx 不再重试，标为 **Breaking**。

## 7. 测试

- 重试：`isRetryable` 逐类；退避时间（`run` 用假定时器，`runSync` 用很小的等待实测）；`Retry-After`；`backoff: false`；`meta.delayMs`；等待中中止；写操作节点不带 `idempotent` 时 `defineNode` 和 `createGraph` 都报错；`idempotencyKey` 每次尝试相同；回放不等待；`retryOn` 收到原始错误。
- 超时：异步节点超时报 `TIMEOUT`、`ctx.signal` 被触发、能重试；写操作节点超时 `outcome: "unknown"` 且不带 `idempotent` 时不重试；`LLMNode` 的 `timeoutMs`；同步节点不受影响；agent 只读工具超时交回模型、写操作工具超时运行失败；超时后迟到的 reject 不产生未处理拒绝。
- 异步 sink：耗时不同时顺序不乱；写操作节点执行前 `enter` 已写完；插件事件在 `exit` 前写完；reject 报 `SINK_FAILED`；`runSync` 遇到异步 sink 报错；失败时 `run_end` 仍交给 sink；中止时不等 sink。
- 适配器：400、429、503 抛带状态码的 `HTTPError`；`LLMNode` 配重试时 400 不重试、429 重试且等待不短于 `Retry-After`；`tokenLimit`。
- 现有测试里的重试改为 `backoff: false` 或假定时器，保持测试快速。
- 完成标准：`pnpm check` 通过；四个示例照常运行；两个兄弟包用本地打包的 taugraph 跑通 `pnpm check`。

## 8. 不做

- 断路器、全局并发限制、按服务商限速。
- 工具的重试（模型会自己决定是否再调用）。
- 打断同步代码。

## 9. 发布

- 在分支 `feat/reliability` 上做，完成后合并回 main，和 trace v2 一起发 0.4.0（CHANGELOG 的 0.4.0 一节合并、更新日期）。
- 兄弟包依赖改成 `^0.4.0`，各发 0.3.0。
