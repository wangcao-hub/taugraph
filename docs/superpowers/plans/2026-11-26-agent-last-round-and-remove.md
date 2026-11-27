# taugraph 0.4.1: `lastRound` and `FileStore.remove` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two additive features moqi needs: `createAgent({ lastRound: "answer" })` makes the last model call go without tools, and `fileStore(dir).remove(runId)` deletes a finished run's file.

**Architecture:** `lastRound` is decided inside the agent's `LLMNode` prompt and update functions from `rounds` and `maxRounds`; nothing changes in the graph. `remove` takes the run's lock with the store's existing `acquire`, so the lock rules (live holder refused, stale lock taken over) are the same as for writing.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, Zod in tests only, biome (formats TS code blocks in Markdown too).

Spec: `/Users/mi/2026/claw/github/moqi/docs/superpowers/specs/2026-11-26-taugraph-agent-design.md`, section 5.

## Global Constraints

- Additive only: without `lastRound`, the agent behaves exactly as in 0.4.0; existing tests pass unchanged.
- Zero runtime dependencies; `src/agent` imports only `../index.js`, `../nodes/index.js` and its own files; only `src/file` may use `node:` modules and the words `process` / `Buffer`.
- Error texts, verbatim:
  - `createAgent: lastRound must be "tools" or "answer", got <x>` (`TypeError`)
  - `remove` on a run a live holder is writing: the existing `acquire` text, `Run "<runId>" is being written by process <pid> (<lock path>)`
  - `remove` with a bad runId: the existing `Invalid runId "<first 40 chars>"`
- Library text and code comments in English. `pnpm check` must pass after every task; `pnpm format` fixes formatting.
- Work on branch `feat/agent-last-round` from `main` (11ed0ce, v0.4.0).

---

### Task 1: `lastRound` in `createAgent`

**Files:**

- Modify: `src/agent/index.ts`
- Test: `test/agent.test.ts`

**Interfaces:**

- Produces (public): `AgentConfig.lastRound?: "tools" | "answer"`.

- [ ] **Step 1: Write the failing tests.** Append to `test/agent.test.ts`:

```ts
describe("lastRound", () => {
  it("sends no tools on the last round and takes its words as the answer", async () => {
    const model = scripted([
      { content: "", toolCalls: [call("c1", "weather", { city: "南京" })] },
      { content: "南京晴", toolCalls: [call("c2", "weather", { city: "上海" })] },
    ]);
    const agent = createAgent({ model, tools: [weather], toolChoice: "auto", maxRounds: 2, lastRound: "answer" });
    const { state, path, trace } = await agent.run(ask("天气"));
    expect(model.requests[0]).toMatchObject({
      toolChoice: "auto",
      tools: [expect.objectContaining({ name: "weather" })],
    });
    expect(model.requests[1]).not.toHaveProperty("tools");
    expect(model.requests[1]).not.toHaveProperty("toolChoice");
    expect(path).toEqual(["think", "act", "think", "finish"]);
    expect(state).toMatchObject({ final: "南京晴", stop: "done", rounds: 2, pending: [] });
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "南京晴", model: "mock:agent" });
    expect(trace.filter((e) => e.type === "llm_call")).toHaveLength(2);
    expect(trace.filter((e) => e.type === "tool_call")).toHaveLength(1);
  });

  it("asks without tools when maxRounds allows one call", async () => {
    const model = scripted([{ content: "好" }]);
    const { state } = await createAgent({ model, tools: [weather], maxRounds: 1, lastRound: "answer" }).run(ask("hi"));
    expect(model.requests[0]).not.toHaveProperty("tools");
    expect(state).toMatchObject({ final: "好", stop: "done" });
  });

  it("keeps the tools on every round by default", async () => {
    const model = scripted([
      { content: "", toolCalls: [call("c1", "weather", { city: "南京" })] },
      { content: "", toolCalls: [call("c2", "weather", { city: "上海" })] },
    ]);
    const { state } = await createAgent({ model, tools: [weather], maxRounds: 2 }).run(ask("天气"));
    expect(model.requests[1]?.tools).toHaveLength(1);
    expect(state.stop).toBe("max_rounds");
  });

  it("refuses other values", () => {
    expect(() => createAgent({ model: scripted([]), lastRound: "none" as never })).toThrow(
      'createAgent: lastRound must be "tools" or "answer", got none',
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm exec vitest run test/agent.test.ts -t lastRound`
Expected: FAIL (the last request still has `tools`; `lastRound: "none"` is accepted).

- [ ] **Step 3: Implement.** In `src/agent/index.ts`:

Add to `AgentConfig`, after `maxRounds`:

```ts
  /**
   * `"answer"`: the last model call that `maxRounds` allows gets no tools, so the model has to answer in words; tool
   * calls it returns anyway are ignored. Default `"tools"`: every call gets the tools.
   */
  readonly lastRound?: "tools" | "answer";
```

In `createAgent`, after the `maxRounds` check, add:

```ts
const lastRound = config.lastRound ?? "tools";
if (lastRound !== "tools" && lastRound !== "answer") {
  throw new TypeError(`createAgent: lastRound must be "tools" or "answer", got ${String(config.lastRound)}`);
}
/** Whether the call made from this state is the last one allowed and must be answered in words. */
const answerOnly = (s: AgentState) => lastRound === "answer" && s.rounds === maxRounds - 1;
```

In `callModel`'s `prompt`, replace the two lines

```ts
      ...(specs.length > 0 && { tools: specs }),
      ...(config.toolChoice && { toolChoice: config.toolChoice }),
```

with

```ts
      ...(!answerOnly(s) && specs.length > 0 && { tools: specs }),
      ...(!answerOnly(s) && config.toolChoice && { toolChoice: config.toolChoice }),
```

In `callModel`'s `update`, replace

```ts
const calls = (response.toolCalls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
```

with

```ts
// On the answer-only round the model was given no tools; calls it makes anyway are dropped.
const asked = answerOnly(s) ? [] : (response.toolCalls ?? []);
const calls = asked.map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
```

(`s` in `update` is the state before the call, so `answerOnly(s)` is the same test as in `prompt`.)

- [ ] **Step 4: Run the tests.**

Run: `pnpm exec vitest run test/agent.test.ts test/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/agent/index.ts test/agent.test.ts
git commit -m "feat(agent): lastRound: \"answer\" makes the last call go without tools"
```

---

### Task 2: `FileStore.remove`

**Files:**

- Modify: `src/file/index.ts`
- Test: `test/file.test.ts`

**Interfaces:**

- Produces (public): `FileStore.remove(runId: string): boolean`.

- [ ] **Step 1: Write the failing tests.** In `test/file.test.ts`, add `resolve` to the `node:path` import (`import { join, relative, resolve } from "node:path";`) and append:

```ts
describe("fileStore.remove", () => {
  it("removes a finished run's file and nothing else", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const first = await graph.run({ n: 0 }, { onEvent: store.sink });
    const second = await graph.run({ n: 5 }, { onEvent: store.sink });
    expect(store.remove(first.runId)).toBe(true);
    expect(store.load(first.runId)).toBeUndefined();
    expect(store.list().map((r) => r.runId)).toEqual([second.runId]);
    expect(readdirSync(dir)).toEqual([`${second.runId}.jsonl`]);
    expect(store.remove(first.runId)).toBe(false);
  });

  it("refuses a run another live process is writing, and removes one whose writer died", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const runId = trace[0]?.runId as string;
    crashed(dir, trace, 3);
    const lock = join(dir, `${runId}.lock`);
    writeFileSync(lock, String(process.ppid));
    const store = fileStore(dir);
    expect(() => store.remove(runId)).toThrow(`Run "${runId}" is being written by process ${process.ppid} (${lock})`);
    expect(existsSync(join(dir, `${runId}.jsonl`))).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.ppid));
    writeFileSync(lock, String(DEAD_PID));
    expect(store.remove(runId)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a run it is writing itself", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const { trace } = await graph.run({ n: 0 });
    const runId = trace[0]?.runId as string;
    for (const event of trace.slice(0, 3)) store.sink(event);
    expect(() => store.remove(runId)).toThrow(
      `Run "${runId}" is being written by process ${process.pid} (${resolve(dir, `${runId}.lock`)})`,
    );
    expect(store.load(runId)).toHaveLength(3);
  });

  it("checks the runId", () => {
    expect(() => fileStore(temp()).remove("a/b")).toThrow('Invalid runId "a/b"');
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm exec vitest run test/file.test.ts -t remove`
Expected: FAIL (`store.remove is not a function`; typecheck also reports it).

- [ ] **Step 3: Implement.** In `src/file/index.ts`, add to the `FileStore` interface after `list()`:

```ts
  /**
   * Deletes a run's file; false if there is none. Refuses a run that a live process, or this store, is writing;
   * a lock left by a process that died is taken over first, as for writing.
   */
  remove(runId: string): boolean;
```

and add to the object returned by `fileStore`, after `list()`:

```ts
    remove(runId) {
      checkRunId(runId);
      const path = fileOf(runId);
      if (!existsSync(path)) return false;
      // Holding the lock keeps a writer from opening the run between the check above and the unlink.
      const lock = acquire(runId);
      try {
        unlinkSync(path);
        return true;
      } catch (error) {
        if (codeOf(error) === "ENOENT") return false;
        throw error;
      } finally {
        releaseLock(lock);
      }
    },
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm exec vitest run test/file.test.ts test/file-durability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/file/index.ts test/file.test.ts
git commit -m "feat(file): FileStore.remove deletes a finished run"
```

---

### Task 3: Documentation and CHANGELOG

**Files:**

- Modify: `README.md`, `README.zh-CN.md`, `CHANGELOG.md`

**Interfaces:** documentation only.

- [ ] **Step 1: READMEs.** In `README.md`, section "Agent (`taugraph/agent`)", after the bullet that starts with "- `maxRounds` (default 8)", add:

```
- `lastRound: "answer"` makes the last model call that `maxRounds` allows go without tools, so the model has to answer in words; tool calls it returns anyway are ignored. Default `"tools"`.
```

In section "Saving to files (`taugraph/file`)", after the bullet that starts with "- `list()` reports", add:

```
- `remove(runId)` deletes a run's file and returns whether there was one. It refuses a run that a live process, or this store, is writing.
```

In `README.zh-CN.md`, section "Agent（`taugraph/agent`）", after the bullet that starts with "- `maxRounds`（默认 8）", add:

```
- `lastRound: "answer"`：`maxRounds` 允许的最后一次模型调用不带工具，模型只能用文字回答；它仍返回的工具调用会被忽略。默认 `"tools"`。
```

In section "存成文件（`taugraph/file`）", after the bullet that starts with "- `list()` 给出五种状态", add:

```
- `remove(runId)` 删除一个 run 的文件，返回原来有没有这个文件。别的活着的进程或这个存储自己正在写的 run，它拒绝删除。
```

- [ ] **Step 2: CHANGELOG.** Under `## [Unreleased]`, add:

```
### Added

- `createAgent({ lastRound: "answer" })`: the last model call that `maxRounds` allows gets no `tools` and no `toolChoice`, so the model answers in words; tool calls it returns anyway are ignored. Default `"tools"`, the 0.4.0 behavior.
- `fileStore(dir).remove(runId)` deletes a run's file and returns whether there was one; it refuses a run that a live process or the store itself is writing.
```

- [ ] **Step 3: Check and commit.**

Run: `pnpm format && pnpm check`
Expected: PASS.

```bash
git add README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs: lastRound and FileStore.remove"
```

---

### Task 4: Final verification

**Files:** none changed, unless a check fails.

- [ ] **Step 1:** `pnpm check && pnpm build` passes; `pnpm example:agent` prints `replay equal: true`.
- [ ] **Step 2:** `rm -rf /tmp/tg-pack && mkdir -p /tmp/tg-pack && pnpm pack --pack-destination /tmp/tg-pack` writes `/tmp/tg-pack/taugraph-0.4.0.tgz` (the version is bumped at release, after merging). This pack is what moqi develops against.
