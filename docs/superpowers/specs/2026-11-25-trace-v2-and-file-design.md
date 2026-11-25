# trace v2 与 `taugraph/file` 设计（第 4 条，合并第 10 条的"更小的快照"）

> 2026-11-25 定稿。实现以代码和测试为准。

## 1. 目标

- trace 不再按平方增长。实测（`createAgent`、假模型）：100 次工具调用、每次 5KB，对话 503KB，trace 126MB；原因是每步 `enter` / `exit` 各存一份完整状态，`llm_call` 再存一份完整请求，内存里还为每个事件深拷贝一次。
- trace 能安全地存成文件，崩溃后接着跑。现在 `fromJSONL` 遇到写了一半的最后一行就抛 `INVALID_TRACE`，正好在崩溃后最常见的情况下接不上；moqi、taugraph-mcp 各写了一份文件存储，处理程度不一。

和用户确认过的选择：

- 第 4 条和第 10 条的"更小的快照"合并做，`TRACE_VERSION` 升到 2，能读 v1。
- 内存和文件两层都变小，读 trace 的方式（`event.input`、`event.output`）不变。
- 新插件入口 `taugraph/file`；默认只在写操作步骤前后、暂停、结束时 `fsync`；每个 run 一个锁文件。

## 2. 内核

### 2.1 内存：共享没变的部分（`src/core/util.ts`）

- `freezeJson` 把它产出的每个对象和数组记进一个模块级 `WeakSet`。再遇到其中的对象时直接返回原引用，不再校验和复制。
- 用户自己冻结、但不是 `freezeJson` 产出的对象不在集合里，照常校验并复制。
- 效果：节点返回 `{ ...s, messages: [...s.messages, m] }` 时，只有新消息和外层对象、数组是新的；内存和拷贝耗时随步数线性增长。

### 2.2 文件：v2 编码（`src/core/trace.ts`）

内存里事件的结构不变；v2 是写成 JSONL 时的编码。

- `run_start.meta.version` 为 2。`assertTrace` 接受版本 1 和 2。
- 每个事件的 `input` / `output` 字段有一个基准值：
  - `enter.input`：上一个 `exit` 的 `output`（还没有 `exit` 时没有基准）。
  - `exit.output`：同一步最近一个 `enter` 的 `input`。
  - 其他事件（`llm_call`、`tool_call`、`pause`、`resume`、`error` 等）：同一 `type`、同一 `nodeId` 的上一个事件里的同一个字段。
- 有基准时写 `inputPatch` / `outputPatch`（JSON Patch 操作数组），条件是它的 JSON 不比完整值的 JSON 长；否则写完整的 `input` / `output`。与基准相同时写 `[]`。
- JSON Patch 只用 `add`（含 `/-` 追加到数组末尾）、`remove`、`replace`，路径按 RFC 6901 转义（`~0`、`~1`）。
- 计算改动：引用相同或深度相等时为 `[]`；两个普通对象按键比较（新增 `add`、删除 `remove`、都有则递归）；新数组以旧数组为前缀时逐个 `add` 到 `/-`；长度相同的数组逐个元素递归；其他情况整体 `replace`。
- 解码时应用改动生成新值，没变的部分沿用基准的引用，结果用 `freezeJson` 冻结。

### 2.3 接口

```ts
/** One event per line in format v2. `from` writes events from that index on, using earlier ones as bases. */
export function toJSONL(trace: Trace, options?: { readonly from?: number }): string;

/** Reads v1 and v2. `tornTail: "drop"` drops a last line that was cut short (no final newline and not valid JSON). */
export function fromJSONL(text: string, options?: { readonly tornTail?: "drop" | "error" }): Trace;

/** Encodes events one by one for a store. `prefix` holds events already stored, so new ones can use them as bases. */
export function createTraceEncoder(prefix?: Trace): { encode(event: TraceEvent): string };

export type RunStatus = "running" | "paused" | "completed" | "failed";
/** From the last event: no `run_end` is "running"; otherwise `run_end.meta.status`. */
export function runStatus(trace: Trace): RunStatus;
```

- `toJSONL` 的结果以换行结尾。`encode` 返回不带换行的一行。
- `fromJSONL` 的 `tornTail` 默认 `"error"`。`"drop"` 只针对最后一行，而且只在文本不以换行结尾、这一行解析失败时丢弃；中间的坏行始终报 `INVALID_TRACE`。
- `{ from }`：`from` 之前的事件只用来建立基准，不写出。`from` 为 0 或不给时写出全部。

## 3. `taugraph/file`（`src/file/index.ts`）

### 3.1 用法

```ts
import { fileStore } from "taugraph/file";

const store = fileStore("./runs"); // durability 默认 "writes"
await graph.run(input, { onEvent: store.sink });

for (const run of store.list()) {
  if (run.status === "interrupted") await graph.resume(store.load(run.runId)!, undefined, { onEvent: store.sink });
}
```

```ts
export interface FileStoreOptions {
  /** When to fsync: around write steps, pauses and the end of a run (default), after every event, or never. */
  readonly durability?: "writes" | "every" | "none";
}
export type StoredRunStatus = "running" | "interrupted" | "paused" | "completed" | "failed";
export interface StoredRun {
  readonly runId: string;
  readonly status: StoredRunStatus;
  readonly events: number;
  readonly updatedAt: number; // file mtime, ms
}
export interface FileStore {
  readonly dir: string;
  readonly sink: (event: TraceEvent) => void;
  load(runId: string): Trace | undefined;
  list(): StoredRun[];
}
export function fileStore(dir: string, options?: FileStoreOptions): FileStore;
```

### 3.2 文件和锁

- 每个 run 一个 `<dir>/<runId>.jsonl`（v2），写入期间有 `<dir>/<runId>.lock`，内容是进程号。目录不存在时创建。
- `runId` 必须匹配 `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`，否则抛 `TypeError`：`Invalid runId "<前 40 个字符>"`。
- 拿锁：用独占方式创建锁文件。已存在时读出进程号：
  - 进程还活着（`process.kill(pid, 0)` 不抛错，包括当前进程）：抛错 `Run "<runId>" is being written by process <pid>`。
  - 进程不在了或内容不是进程号：删掉后重新创建。
- 释放：收到 `run_end`（任何状态，包括 `paused`）时关闭文件、删掉锁。进程退出时（`process.once("exit")`）释放本进程持有的所有锁。

### 3.3 `sink`

- 这个 store 第一次见到某个 `runId` 的事件时：
  - `seq` 为 0：拿锁；文件已存在时抛错 `Run "<runId>" already exists in <dir>`；否则新建文件。
  - `seq` 大于 0（恢复后续写）：拿锁；文件不以换行结尾时截到最后一个换行；读出已有事件；最后一个 `seq` 不是新事件的前一个时抛错 `Run "<runId>" on disk ends at seq <n>, but the next event is seq <m>`；用已有事件创建编码器。
- 之后每个事件：检查 `seq` 连续（同一个 store 里同一个 run 被两处同时写时会在这里报错），编码，同步写一行，再按 `durability` 决定是否 `fsync`：
  - `"writes"`：`enter` 且 `meta.effect === "write"`、`pause`、`run_end` 之后。
  - `"every"`：每个事件之后。
  - `"none"`：从不。
- 新建文件时，`"writes"` 和 `"every"` 还会对目录做一次 `fsync`；系统不支持时忽略错误。
- `sink` 抛出的错误由内核变成 `SINK_FAILED`，运行停下。

### 3.4 读取

- `load(runId)`：读文件，`fromJSONL(text, { tornTail: "drop" })`；不存在返回 `undefined`；从不修改文件。
- `list()`：目录里每个 `.jsonl` 读出 trace 和 `mtime`。`runStatus` 为 `"running"` 时，锁的持有者还活着记为 `"running"`，否则为 `"interrupted"`；其他状态照抄。按 `updatedAt` 从早到晚排序。读不出的文件跳过。

### 3.5 平台与架构

- 只用 `node:fs`、`node:path` 和 `process`；Bun、Deno 能用；浏览器不导入这个入口即可。零依赖。
- `tsconfig.build.json` 加上 Node 类型。`test/architecture.test.ts` 新增规则：只有 `src/file` 能导入 `node:` 开头的模块；`src/file` 以外的文件不能出现 `process` 和 `Buffer`。`src/file` 只能从 `../index.js` 导入 taugraph。
- `package.json` 的 `exports` 加 `"./file"`。

## 4. 兄弟包

- **taugraph-mcp**：`fileStore` 改用 `taugraph/file`，每个 flow 一个目录（`<dir>/<flow>/`），目录和文件名不变，旧的 v1 文件能读。状态改用 `runStatus`。`RunStore` 接口和 `memoryStore` 保留。
- **taugraph-pi**：分段存储改为 `toJSONL(trace, { from: saved })`；状态改用 `runStatus`。
- 两边依赖改成 `^0.4.0`，各发 0.3.0。

## 5. 测试

- 内存共享：一步之后新状态里的旧消息与上一步是同一个对象；不是 `freezeJson` 产出的冻结对象仍被复制；原有的冻结、校验测试全部通过。
- 编解码：
  - 现有测试里产生的每条 trace 经 v2 编码再解码后与原来深度相等。
  - v1 文本（`TRACE_VERSION` 为 1 的 run_start）照常读出。
  - `{ from }` 分段拼接后能解码成完整 trace。
  - 改动规则逐条有用例；改动更长时写完整值。
- 写了一半的最后一行：`"drop"` 丢弃，默认报 `INVALID_TRACE`；中间坏行两种都报错。
- 体积验收：100 次工具调用 × 5KB 的 agent，序列化后的 trace 不超过对话 JSON 的 5 倍；调用次数从 50 翻到 100 时 trace 大小增长不超过 2.5 倍。内存里的 trace 用 `JSON.stringify` 以外的方式衡量：解码后旧消息与上一步共享引用。
- `taugraph/file`（临时目录）：
  - 模拟崩溃：截掉最后一行的一半，`load` 后 `resume`，run 跑完，文件可再读。
  - 写操作步骤中途中断后接着跑报 `UNKNOWN_OUTCOME`。
  - 活进程的锁报错（用当前进程号造一个锁）；死进程的锁被接管（用一个不存在的进程号）；`run_end` 后锁被删除。
  - `seq` 不连续、`runId` 重复、`runId` 不合法都报错。
  - `list()` 给出五种状态。
  - 三档 `durability` 的 `fsync` 次数正确（注入 fs 计数）。
- 架构：两条新规则。
- 兄弟包：taugraph-mcp 的存储测试和 taugraph-pi 的分段测试继续通过，并各加一条 v2 分段 / 旧 v1 文件的用例。
- 完成标准：三个仓库 `pnpm check` 通过，taugraph 四个示例照常运行。

## 6. 文档

- README（中英文）：新增"存成文件（`taugraph/file`）"一节：用法、五种状态、三档 `durability`、锁的规则。`examples/rag-retry.ts` 改用 `fileStore`。
- `docs/trace-format.md`：v2 编码规则、改动操作、各字段的基准、v1 兼容。
- `docs/design.md`：为什么内存和文件分两层变小；为什么锁用文件；为什么默认只在写操作前后 `fsync`。
- CHANGELOG：`### Changed` 写 `TRACE_VERSION` 2 和 v1 兼容；`### Added` 写 `taugraph/file`、`runStatus`、`createTraceEncoder`、`toJSONL` / `fromJSONL` 的新选项。

## 7. 不做

- 自动清理旧 run、保留策略。
- 异步 sink（可靠性那一项再做）。
- 跨机器的锁。
- 内存里的 trace 改成只存改动（读法会变）。

## 8. 发布

- taugraph：在分支 `feat/file` 上做，完成后合并回 main，发 0.4.0。
- 兄弟包：各自新分支，依赖改成 `^0.4.0`，发 0.3.0。
- 之后 moqi：升级到 taugraph 0.4.0，watch 图的 trace 用 `taugraph/file` 存下来，chat 循环改用 `taugraph/agent`。
