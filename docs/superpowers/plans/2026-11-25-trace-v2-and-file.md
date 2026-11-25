# Trace Format v2 and `taugraph/file` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Traces grow linearly instead of quadratically, in memory and in JSONL, and can be stored as crash-safe files with `taugraph/file`.

**Architecture:** `freezeJson` reuses values it already froze (and equal parts of a given base), so consecutive states share structure. JSONL format v2 writes each `input`/`output` as a JSON Patch against a base value when that is shorter; `fromJSONL` rebuilds full events, so in-memory traces keep their shape. `taugraph/file` stores one v2 JSONL file per run with a per-run lock file, fsyncs around write steps, and repairs a torn last line before continuing a run.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, Zod in tests only, biome; `node:fs` in `src/file` only.

Spec: `docs/superpowers/specs/2026-11-25-trace-v2-and-file-design.md`.

## Global Constraints

- Zero runtime dependencies. `src/core` may change (this item is a kernel change) but must stay platform-free: only `src/file` imports `node:` modules, and no file outside `src/file` mentions `process` or `Buffer`.
- In-memory trace events keep their shape: `event.input` / `event.output` are full values. Only the JSONL encoding changes.
- `TRACE_VERSION` becomes 2; `assertTrace` and `fromJSONL` accept versions 1 and 2.
- v2 encoding, verbatim rules:
  - Patch operations: `add` (including `/-` to append), `remove`, `replace`; paths per RFC 6901 (`~0`, `~1`).
  - Bases: `run_start.input` has none; `enter.input` and `run_end.output` use the current state (the `run_start` input until the first `exit`, then the latest `exit` output); `exit.output` uses the latest `enter.input` of the same step; every other field uses the same field of the previous event with the same `type` and `nodeId`.
  - With a base, write `inputPatch` / `outputPatch` when its JSON is not longer than the full value's JSON (accept at once when shorter than 4096 characters); otherwise write the full value. Equal to the base: `[]`.
- `taugraph/file` error texts, verbatim:
  - `Invalid runId "<first 40 chars>"`
  - `Run "<runId>" is being written by process <pid>`
  - `Run "<runId>" already exists in <dir>`
  - `Run "<runId>" has no file in <dir> to continue`
  - `Run "<runId>" on disk ends at seq <n>, but the next event is seq <m>`
  - `Run "<runId>" expected seq <n>, got <m>`
- `runId` pattern for files: `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`.
- Library text and code comments in English. `pnpm check` must pass in every repo touched; `pnpm format` fixes formatting; Markdown through `pnpm exec biome check --write <file>`.
- taugraph work is on branch `feat/file` (spec committed as `ab9054d`). Sibling work is on a new branch `feat/trace-v2` in each sibling; their `package.json` and `pnpm-lock.yaml` are not committed.

---

### Task 1: Structural sharing in `freezeJson`

**Files:**

- Modify: `src/core/util.ts` (`freezeJson`, `copy`)
- Modify: `src/core/engine.ts` (`validate`, `toJson`, the live path of `runStep`)
- Test: `test/sharing.test.ts` (new)

**Interfaces:**

- Produces: `freezeJson<T>(value: T, base?: unknown): T` (internal, `src/core/util.ts`). Values it returns are remembered; passing one back returns it unchanged. With `base`, any part of the result that is equal to the part of `base` at the same position, where that part of `base` came from `freezeJson`, is that part of `base`.

- [ ] **Step 1: Write the failing tests.** Create `test/sharing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, tool } from "../src/agent/index.js";
import { createGraph, type TraceEvent } from "../src/index.js";
import type { AgentState } from "../src/agent/index.js";

const enters = (trace: readonly TraceEvent[], nodeId: string) =>
  trace.filter((e) => e.type === "enter" && e.nodeId === nodeId).map((e) => e.input);

describe("structural sharing", () => {
  it("keeps unchanged parts of the state as the same objects from step to step", () => {
    const schema = z.object({ items: z.array(z.object({ n: z.number() })) });
    const add = (s: z.infer<typeof schema>) => ({ items: [...s.items, { n: s.items.length }] });
    const graph = createGraph(schema, {
      start: "a",
      nodes: { a: add, b: add, c: add },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      endNodes: ["c"],
    });
    const { trace } = graph.runSync({ items: [{ n: 0 }] });
    const inputs = trace.filter((e) => e.type === "enter").map((e) => e.input as { items: { n: number }[] });
    // Zod returns fresh objects; the kernel still shares the parts that did not change.
    expect(inputs[2]?.items[0]).toBe(inputs[1]?.items[0]);
    expect(inputs[2]?.items[1]).toBe(inputs[1]?.items[1]);
    expect(Object.isFrozen(inputs[2]?.items[1])).toBe(true);
  });

  it("shares conversation messages across agent steps and model calls", () => {
    const replies = [
      { content: "", toolCalls: [{ id: "c1", name: "read", arguments: {} }] },
      { content: "", toolCalls: [{ id: "c2", name: "read", arguments: {} }] },
      { content: "done" },
    ];
    const model = { id: "mock", complete: () => replies.shift() ?? { content: "done" } };
    const read = tool({ name: "read", run: () => "x".repeat(100) });
    const { trace } = createAgent({ model, tools: [read] }).runSync({ messages: [{ role: "user", content: "go" }] });
    const thinks = enters(trace, "think") as AgentState[];
    expect(thinks[2]?.messages[0]).toBe(thinks[1]?.messages[0]);
    expect(thinks[2]?.messages[2]).toBe(thinks[1]?.messages[2]);
    const calls = trace.filter((e) => e.type === "llm_call").map((e) => e.input as { messages: unknown[] });
    expect(calls[1]?.messages[0]).toBe(thinks[1]?.messages[0]);
  });

  it("still copies values it did not freeze itself", async () => {
    const schema = z.object({ text: z.string() });
    const payload = Object.freeze({ list: [1, 2] });
    const graph = createGraph(schema, {
      start: "a",
      nodes: {
        a: (s: z.infer<typeof schema>, ctx) => {
          ctx.trace.append({ type: "custom.event", input: payload });
          return s;
        },
      },
      endNodes: ["a"],
    });
    const { trace } = await graph.run({ text: "x" });
    const event = trace.find((e) => e.type === "custom.event");
    expect(event?.input).toEqual({ list: [1, 2] });
    expect(event?.input).not.toBe(payload);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/sharing.test.ts`
Expected: the first two tests FAIL (`toBe` fails: every step deep-copies); the third passes.

- [ ] **Step 3: Implement sharing.** In `src/core/util.ts`, replace `freezeJson` and `copy` with:

```ts
/** Values made by `freezeJson`: deeply frozen and checked, so they are reused instead of copied. */
const checked = new WeakSet<object>();

/**
 * Returns a deeply frozen copy of a plain-JSON value.
 *
 * Throws `NotJsonError` for anything that would not survive a JSON round trip
 * (Date, Map, class instances, functions, bigint, NaN, cycles). This is what makes
 * an in-memory trace and a trace loaded from JSONL replay identically.
 * `undefined` object properties are kept (JSON drops them; `jsonEqual` ignores them).
 *
 * Parts that `freezeJson` made earlier are reused as they are, and so is every part of `base`
 * (also made by `freezeJson`) that equals the part at the same position: consecutive states
 * share whatever did not change, which keeps traces linear in memory.
 */
export function freezeJson<T>(value: T, base?: unknown): T {
  return copy(value, "", new Set(), base) as T;
}

const isChecked = (value: unknown): value is object =>
  typeof value === "object" && value !== null && checked.has(value);

function copy(value: unknown, path: string, ancestors: Set<object>, base: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NotJsonError(path, `non-finite number ${value}`);
    return value;
  }
  if (typeof value !== "object") throw new NotJsonError(path, `${typeof value} is not JSON`);
  if (checked.has(value)) return value;
  if (ancestors.has(value)) throw new NotJsonError(path, "circular reference");

  ancestors.add(value);
  const reuse = isChecked(base) ? base : undefined;
  let result: object;
  if (Array.isArray(value)) {
    const old = Array.isArray(reuse) ? (reuse as readonly unknown[]) : undefined;
    const items = value.map((item, i) => {
      if (item === undefined) throw new NotJsonError(`${path}[${i}]`, "undefined in array");
      return copy(item, `${path}[${i}]`, ancestors, old?.[i]);
    });
    result =
      old && old.length === items.length && items.every((item, i) => item === old[i]) ? old : Object.freeze(items);
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new NotJsonError(path, `${name} is not a plain object (use strings / numbers / arrays / objects)`);
    }
    const old = reuse && !Array.isArray(reuse) ? (reuse as Record<string, unknown>) : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        item === undefined ? undefined : copy(item, path === "" ? key : `${path}.${key}`, ancestors, old?.[key]);
    }
    const keys = Object.keys(out);
    result =
      old && keys.length === Object.keys(old).length && keys.every((k) => Object.hasOwn(old, k) && out[k] === old[k])
        ? old
        : Object.freeze(out);
  }
  ancestors.delete(value);
  checked.add(result);
  return result;
}
```

- [ ] **Step 4: Pass the step's input as the base.** In `src/core/engine.ts`:
  - `toJson` gets a fifth parameter `base?: unknown` and calls `freezeJson(value, base)`.
  - `validate` gets a sixth parameter `base?: unknown` and passes it to its `toJson` call.
  - In `runStep`'s live path, pass `state` as the base to both calls: `toJson(output, message, nodeId, step, state)` and the `validate(graph.schema, json, ..., nodeId, step, state)` call right after it.

- [ ] **Step 5: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS, including every existing freezing/copying test (`test/trace.test.ts` "is immutable" and "copies payloads so later mutation cannot rewrite history").

- [ ] **Step 6: Commit.**

```bash
git add src/core/util.ts src/core/engine.ts test/sharing.test.ts
git commit -m "perf(core): share unchanged parts of state between steps instead of copying them"
```

---

### Task 2: JSONL format v2, `createTraceEncoder`, `runStatus`

**Files:**

- Create: `src/core/patch.ts`
- Modify: `src/core/trace.ts` (`TRACE_VERSION`, `assertTrace`, `toJSONL`, `fromJSONL`, new `createTraceEncoder`, `runStatus`, `RunStatus`)
- Modify: `src/index.ts` (exports)
- Modify: `test/trace.test.ts` (version 1 → `TRACE_VERSION`)
- Test: `test/patch.test.ts` (new), `test/format-v2.test.ts` (new)

**Interfaces:**

- Consumes: `freezeJson(value, base)` from Task 1.
- Produces (exported from `taugraph`):
  - `toJSONL(trace: Trace, options?: { readonly from?: number }): string`
  - `fromJSONL(text: string, options?: { readonly tornTail?: "drop" | "error" }): Trace`
  - `createTraceEncoder(prefix?: Trace): { encode(event: TraceEvent): string }` (a line without newline)
  - `type RunStatus = "running" | "paused" | "completed" | "failed"`; `runStatus(trace: Trace): RunStatus`
  - `TRACE_VERSION === 2`
- Internal: `src/core/patch.ts` exports `type PatchOp`, `diffJson(from, to): PatchOp[]`, `applyPatch(base, ops): unknown`.

- [ ] **Step 1: Write the failing tests.**
  - Create `test/patch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyPatch, diffJson } from "../src/core/patch.js";

describe("JSON patch for trace v2", () => {
  const cases: [string, unknown, unknown, unknown[]][] = [
    ["equal", { a: 1 }, { a: 1 }, []],
    ["new key", { a: 1 }, { a: 1, b: 2 }, [{ op: "add", path: "/b", value: 2 }]],
    ["removed key", { a: 1, b: 2 }, { a: 1 }, [{ op: "remove", path: "/b" }]],
    ["changed value", { a: { b: 1 } }, { a: { b: 2 } }, [{ op: "replace", path: "/a/b", value: 2 }]],
    [
      "appended items",
      { m: [1, 2] },
      { m: [1, 2, 3, 4] },
      [
        { op: "add", path: "/m/-", value: 3 },
        { op: "add", path: "/m/-", value: 4 },
      ],
    ],
    ["same length", [1, { x: 1 }], [1, { x: 2 }], [{ op: "replace", path: "/1/x", value: 2 }]],
    ["shorter array", [1, 2, 3], [1, 2], [{ op: "replace", path: "", value: [1, 2] }]],
    [
      "escaped keys",
      { "a/b": 1, "c~d": 1 },
      { "a/b": 2, "c~d": 2 },
      [
        { op: "replace", path: "/a~1b", value: 2 },
        { op: "replace", path: "/c~0d", value: 2 },
      ],
    ],
    ["type change", { a: [1] }, { a: { 0: 1 } }, [{ op: "replace", path: "/a", value: { 0: 1 } }]],
    ["root primitive", "a", "b", [{ op: "replace", path: "", value: "b" }]],
    ["undefined counts as absent", { a: 1, b: undefined }, { a: 1 }, []],
  ];

  for (const [name, from, to, ops] of cases) {
    it(`diffs and applies: ${name}`, () => {
      expect(diffJson(from, to)).toEqual(ops);
      expect(applyPatch(from, diffJson(from, to))).toEqual(JSON.parse(JSON.stringify(to)));
    });
  }

  it("keeps unchanged parts and never changes the base", () => {
    const base = Object.freeze({ keep: Object.freeze({ deep: 1 }), list: Object.freeze([1]) });
    const next = applyPatch(base, [{ op: "add", path: "/list/-", value: 2 }]) as typeof base;
    expect(next.keep).toBe(base.keep);
    expect(next.list).toEqual([1, 2]);
    expect(base.list).toEqual([1]);
  });

  it("refuses paths that do not exist", () => {
    expect(() => applyPatch({ a: 1 }, [{ op: "replace", path: "/a/b", value: 1 }])).toThrow(/patch path \/a\/b/);
  });
});
```

- Create `test/format-v2.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, tool } from "../src/agent/index.js";
import {
  createGraph,
  createTraceEncoder,
  fromJSONL,
  runStatus,
  TRACE_VERSION,
  type Trace,
  toJSONL,
} from "../src/index.js";

const plain = (trace: Trace) => JSON.parse(JSON.stringify(trace));

function agentRun(calls: number, size = 5000) {
  const big = "x".repeat(size);
  const replies = Array.from({ length: calls }, (_, i) => ({
    content: "",
    toolCalls: [{ id: `c${i}`, name: "read", arguments: { i } }],
  }));
  const model = { id: "mock", complete: () => replies.shift() ?? { content: "done" } };
  const read = tool({ name: "read", run: () => big });
  return createAgent({ model, tools: [read], maxRounds: calls + 1 }).runSync({
    messages: [{ role: "user", content: "go" }],
  });
}

function pausingGraph() {
  const schema = z.object({ n: z.number(), answer: z.string().nullable().default(null) });
  return createGraph(schema, {
    start: "count",
    nodes: {
      count: (s: z.infer<typeof schema>) => ({ ...s, n: s.n + 1 }),
      ask: (s: z.infer<typeof schema>, ctx) => ({ ...s, answer: ctx.interrupt<string>({ question: "ok?" }) }),
    },
    edges: [{ from: "count", to: "ask" }],
    endNodes: ["ask"],
  });
}

describe("trace format v2", () => {
  it("writes version 2 and reads back the same events", () => {
    const { trace } = agentRun(3, 50);
    expect(trace[0]?.meta?.version).toBe(TRACE_VERSION);
    expect(TRACE_VERSION).toBe(2);
    const text = toJSONL(trace);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"outputPatch"');
    expect(fromJSONL(text)).toEqual(plain(trace));
  });

  it("round-trips paused, resumed and replayed runs", async () => {
    const graph = pausingGraph();
    const paused = await graph.run({ n: 0 });
    const done = await graph.resume(paused.trace, "yes");
    const replayed = await graph.replay(done.trace);
    for (const trace of [paused.trace, done.trace, replayed.trace]) {
      expect(fromJSONL(toJSONL(trace))).toEqual(plain(trace));
    }
    expect(runStatus(paused.trace)).toBe("paused");
    expect(runStatus(done.trace)).toBe("completed");
    expect(runStatus(done.trace.slice(0, 3))).toBe("running");
  });

  it("writes chunks that concatenate into the whole trace", () => {
    const { trace } = agentRun(4, 50);
    const cut = 7;
    const text =
      toJSONL(trace, { from: 0 }).split("\n").slice(0, cut).join("\n") + "\n" + toJSONL(trace, { from: cut });
    expect(fromJSONL(text)).toEqual(plain(trace));
    expect(toJSONL(trace, { from: trace.length })).toBe("");
    const encoder = createTraceEncoder(trace.slice(0, cut));
    const lines = trace.slice(cut).map((e) => encoder.encode(e));
    expect(`${lines.join("\n")}\n`).toBe(toJSONL(trace, { from: cut }));
  });

  it("reads version 1 text", () => {
    const { trace } = agentRun(2, 50);
    const v1 = trace.map((e, i) => JSON.stringify(i === 0 ? { ...e, meta: { ...e.meta, version: 1 } } : e)).join("\n");
    const read = fromJSONL(v1);
    expect(read[0]?.meta?.version).toBe(1);
    expect(read.slice(1)).toEqual(plain(trace).slice(1));
  });

  it("drops a torn last line only when asked, and never a broken line in the middle", () => {
    const { trace } = agentRun(2, 50);
    const text = toJSONL(trace);
    const torn = text.slice(0, text.length - 15);
    expect(() => fromJSONL(torn)).toThrow(/is not valid JSON/);
    expect(fromJSONL(torn, { tornTail: "drop" })).toEqual(plain(trace.slice(0, -1)));
    const lines = text.split("\n");
    lines[2] = "{broken";
    expect(() => fromJSONL(lines.join("\n"), { tornTail: "drop" })).toThrow(/Line 3/);
  });

  it("grows linearly with the number of steps", () => {
    const run100 = agentRun(100);
    const text100 = toJSONL(run100.trace);
    const conversation = JSON.stringify(run100.state.messages).length;
    expect(text100.length).toBeLessThan(5 * conversation);
    const text50 = toJSONL(agentRun(50).trace);
    expect(text100.length / text50.length).toBeLessThan(2.5);
    const read = fromJSONL(text100);
    const thinks = read.filter((e) => e.type === "enter" && e.nodeId === "think");
    const messages = (i: number) => (thinks[i]?.input as { messages: unknown[] }).messages;
    expect(messages(50)[1]).toBe(messages(49)[1]);
  });
});
```

- In `test/trace.test.ts`, import `TRACE_VERSION` and change the `version: 1` expectation in "records a complete, ordered event stream" to `version: TRACE_VERSION`; in "rejects malformed traces" keep the version-99 case (its message becomes `Unsupported trace version 99 (expected 1 or 2)`; the regex `/Unsupported trace version 99/` still matches).

* [ ] **Step 2: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/patch.test.ts test/format-v2.test.ts`
Expected: FAIL. `src/core/patch.ts` does not exist; `createTraceEncoder`, `runStatus` are not exported; `TRACE_VERSION` is 1.

- [ ] **Step 3: Create `src/core/patch.ts`.**

```ts
// A JSON Patch (RFC 6902) subset for trace format v2: add, remove and replace. Diffs are tuned for
// state that mostly grows, so new object keys and items appended to arrays stay small.
import { jsonEqual } from "./util.js";

export type PatchOp =
  | { readonly op: "add"; readonly path: string; readonly value: unknown }
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string };

const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const unescape = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Operations that turn `from` into `to`; `[]` when they are equal. Object keys set to `undefined` count as absent. */
export function diffJson(from: unknown, to: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  walk(from, to, "", ops);
  return ops;
}

function walk(a: unknown, b: unknown, path: string, ops: PatchOp[]): void {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (b.length >= a.length && a.every((item, i) => jsonEqual(item, b[i]))) {
      for (let i = a.length; i < b.length; i++) ops.push({ op: "add", path: `${path}/-`, value: b[i] });
      return;
    }
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}/${i}`, ops);
      return;
    }
    ops.push({ op: "replace", path, value: b });
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const key of Object.keys(a)) {
      if (a[key] !== undefined && b[key] === undefined) ops.push({ op: "remove", path: `${path}/${escape(key)}` });
    }
    for (const key of Object.keys(b)) {
      if (b[key] === undefined) continue;
      if (a[key] === undefined) ops.push({ op: "add", path: `${path}/${escape(key)}`, value: b[key] });
      else walk(a[key], b[key], `${path}/${escape(key)}`, ops);
    }
    return;
  }
  if (!jsonEqual(a, b)) ops.push({ op: "replace", path, value: b });
}

/** Applies `ops` to `base` without changing it. Parts the operations do not touch keep their identity. */
export function applyPatch(base: unknown, ops: readonly PatchOp[]): unknown {
  let doc = base;
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") throw new Error("patch cannot remove the whole value");
      doc = op.value;
      continue;
    }
    if (!op.path.startsWith("/")) throw new Error(`patch path ${op.path} must start with "/"`);
    doc = setIn(doc, op.path.slice(1).split("/").map(unescape), 0, op);
  }
  return doc;
}

function setIn(node: unknown, tokens: readonly string[], i: number, op: PatchOp): unknown {
  const token = tokens[i] as string;
  const last = i === tokens.length - 1;
  if (Array.isArray(node)) {
    const copy = node.slice();
    if (last && op.op === "add" && token === "-") {
      copy.push(op.value);
      return copy;
    }
    const at = Number(token);
    if (!/^(0|[1-9]\d*)$/.test(token) || at >= copy.length) throw new Error(`patch path ${op.path} does not exist`);
    if (last) {
      if (op.op === "remove") copy.splice(at, 1);
      else copy[at] = op.value;
      return copy;
    }
    copy[at] = setIn(copy[at], tokens, i + 1, op);
    return copy;
  }
  if (isRecord(node)) {
    const copy: Record<string, unknown> = { ...node };
    if (last) {
      if (op.op === "remove") delete copy[token];
      else copy[token] = op.value;
      return copy;
    }
    if (!Object.hasOwn(copy, token)) throw new Error(`patch path ${op.path} does not exist`);
    copy[token] = setIn(copy[token], tokens, i + 1, op);
    return copy;
  }
  throw new Error(`patch path ${op.path} does not exist`);
}
```

- [ ] **Step 4: Encode and decode v2 in `src/core/trace.ts`.**
  - `export const TRACE_VERSION = 2;` and add `const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);`
  - In `assertTrace`, replace the version check with:

```ts
if (!READABLE_VERSIONS.has(meta?.version)) {
  fail(`Unsupported trace version ${String(meta?.version)} (expected 1 or 2)`);
}
```

- Add `import { applyPatch, diffJson, type PatchOp } from "./patch.js";` and add below the Serialization banner:

```ts
type Field = "input" | "output";
const FIELDS: readonly Field[] = ["input", "output"];
const PATCH = { input: "inputPatch", output: "outputPatch" } as const;
const SHORT_PATCH = 4096;

/** Base values for v2 patches, updated event by event in the same way when writing and reading. */
class Bases {
  #state: { readonly value: unknown } | undefined;
  readonly #enters = new Map<number, unknown>();
  readonly #last = new Map<string, unknown>();

  get(event: TraceEvent, field: Field): { readonly value: unknown } | undefined {
    if ((event.type === "enter" && field === "input") || (event.type === "run_end" && field === "output")) {
      return this.#state;
    }
    if (event.type === "exit" && field === "output") {
      return event.step !== undefined && this.#enters.has(event.step)
        ? { value: this.#enters.get(event.step) }
        : undefined;
    }
    const key = `${event.type}\u0000${event.nodeId ?? ""}\u0000${field}`;
    return this.#last.has(key) ? { value: this.#last.get(key) } : undefined;
  }

  update(event: TraceEvent): void {
    for (const field of FIELDS) {
      const value = event[field];
      if (value === undefined) continue;
      if (event.type === "run_start" && field === "input") this.#state = { value };
      else if (event.type === "exit" && field === "output") this.#state = { value };
      else if (event.type === "enter" && field === "input" && event.step !== undefined)
        this.#enters.set(event.step, value);
      else this.#last.set(`${event.type}\u0000${event.nodeId ?? ""}\u0000${field}`, value);
    }
  }
}

function encodeEvent(event: TraceEvent, bases: Bases): string {
  const out: Record<string, unknown> = { ...event };
  if (event.type === "run_start") out.meta = { ...event.meta, version: TRACE_VERSION };
  for (const field of FIELDS) {
    const value = event[field];
    if (value === undefined) continue;
    const base = bases.get(event, field);
    if (!base) continue;
    const ops = diffJson(base.value, value);
    const patch = JSON.stringify(ops);
    if (patch.length < SHORT_PATCH || patch.length <= JSON.stringify(value).length) {
      delete out[field];
      out[PATCH[field]] = ops;
    }
  }
  return JSON.stringify(out);
}

/** Encodes events one by one in format v2. `prefix` holds events already stored, so new ones can use them as bases. */
export function createTraceEncoder(prefix: Trace = []): { encode(event: TraceEvent): string } {
  const bases = new Bases();
  for (const event of prefix) bases.update(event);
  return {
    encode(event) {
      const line = encodeEvent(event, bases);
      bases.update(event);
      return line;
    },
  };
}
```

- Replace `toJSONL` and `fromJSONL` with:

```ts
/** One JSON object per line in format v2. `from` writes the events from that index on, using earlier ones as bases. */
export function toJSONL(trace: Trace, options: { readonly from?: number } = {}): string {
  const from = options.from ?? 0;
  const encoder = createTraceEncoder(trace.slice(0, from));
  const lines = trace.slice(from).map((event) => encoder.encode(event));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Reads format v1 and v2. `tornTail: "drop"` drops a last line that was cut short by a crash: the text does not end
 * with a newline and the line is not valid JSON. Any other broken line is an `INVALID_TRACE` error.
 */
export function fromJSONL(text: string, options: { readonly tornTail?: "drop" | "error" } = {}): Trace {
  const lines = text.split(/\r?\n/);
  let lastLine = lines.length - 1;
  while (lastLine >= 0 && (lines[lastLine] as string).trim() === "") lastLine--;
  const mayDrop = options.tornTail === "drop" && !text.endsWith("\n");
  const raw: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      raw.push(JSON.parse(line));
    } catch (cause) {
      if (mayDrop && index === lastLine) break;
      throw new TaugraphError("INVALID_TRACE", `Line ${index + 1} is not valid JSON`, { cause });
    }
  }
  const bases = new Bases();
  const events = raw.map((event, index) => {
    const decoded = decodeEvent(event, index, bases);
    bases.update(decoded);
    return decoded;
  });
  return assertTrace(events);
}

function decodeEvent(raw: Record<string, unknown>, index: number, bases: Bases): TraceEvent {
  const out: Record<string, unknown> = { ...raw };
  for (const field of FIELDS) {
    const ops = raw[PATCH[field]];
    delete out[PATCH[field]];
    const base = bases.get(out as unknown as TraceEvent, field);
    try {
      if (ops !== undefined) {
        if (!Array.isArray(ops)) throw new Error(`${PATCH[field]} is not an array`);
        if (!base) throw new Error(`${PATCH[field]} has no base`);
        out[field] = freezeJson(applyPatch(base.value, ops as PatchOp[]), base.value);
      } else if (raw[field] !== undefined) {
        out[field] = freezeJson(raw[field], base?.value);
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new TaugraphError("INVALID_TRACE", `Event ${index}: ${reason}`, { cause });
    }
  }
  return out as unknown as TraceEvent;
}
```

    (`freezeJson` is already imported from `./util.js`.)
- Add near `tracePath`:

```ts
export type RunStatus = "running" | "paused" | "completed" | "failed";

/** Where a run stands, from its last event: no `run_end` yet is `"running"` (or interrupted, if nothing is writing it). */
export function runStatus(trace: Trace): RunStatus {
  const last = trace[trace.length - 1];
  if (last?.type !== "run_end") return "running";
  const status = last.meta?.status;
  return status === "paused" || status === "completed" ? status : "failed";
}
```

- [ ] **Step 5: Export them.** In `src/index.ts`, export `createTraceEncoder`, `runStatus` and `type RunStatus` from `./core/trace.js` alongside `toJSONL` / `fromJSONL`.

- [ ] **Step 6: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS. If a test outside the files above compares a raw JSONL line or `meta.version`, update it to v2 and list it in the report.

Run: `pnpm example:quickstart && pnpm example:checkout && pnpm example:rag && pnpm example:agent`
Expected: all run; `example:agent` prints `replay equal: true`.

- [ ] **Step 7: Commit.**

```bash
git add src/core src/index.ts test/patch.test.ts test/format-v2.test.ts test/trace.test.ts
git commit -m "feat(core): trace format v2 writes patches against base values; runStatus; createTraceEncoder"
```

---

### Task 3: `taugraph/file`

**Files:**

- Create: `src/file/index.ts`
- Modify: `package.json` (`exports`), `tsconfig.build.json` (`types`), `test/architecture.test.ts`
- Test: `test/file.test.ts` (new), `test/file-durability.test.ts` (new)

**Interfaces:**

- Consumes: `createTraceEncoder`, `fromJSONL(text, { tornTail: "drop" })`, `runStatus`, `Trace`, `TraceEvent` from `../index.js` (Task 2).
- Produces (entry `taugraph/file`): `fileStore(dir: string, options?: FileStoreOptions): FileStore`; types `FileStore`, `FileStoreOptions`, `StoredRun`, `StoredRunStatus`, `Durability`.

- [ ] **Step 1: Write the failing tests.**
  - Create `test/file.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fileStore } from "../src/file/index.js";
import { createGraph, isTaugraphError, runStatus, type Trace, toJSONL } from "../src/index.js";

const temp = () => mkdtempSync(join(tmpdir(), "taugraph-file-"));
const DEAD_PID = 2147483646;

const schema = z.object({
  n: z.number(),
  sent: z.boolean().default(false),
  answer: z.string().nullable().default(null),
});
type S = z.infer<typeof schema>;
const graph = createGraph(schema, {
  start: "a",
  nodes: {
    a: (s: S) => ({ ...s, n: s.n + 1 }),
    b: (s: S) => ({ ...s, n: s.n + 1 }),
    send: Object.assign((s: S) => ({ ...s, sent: true }), { effect: "write" as const }),
  },
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "send" },
  ],
  endNodes: ["send"],
});
const asking = createGraph(schema, {
  start: "ask",
  nodes: { ask: (s: S, ctx) => ({ ...s, answer: ctx.interrupt<string>("ok?") }) },
  endNodes: ["ask"],
});

/** A file that ends like a crash: the events up to `cut`, then half of the next line, and a dead writer's lock. */
function crashed(dir: string, trace: Trace, cut: number): void {
  const runId = trace[0]?.runId as string;
  const next = toJSONL(trace, { from: cut }).split("\n")[0] as string;
  writeFileSync(join(dir, `${runId}.jsonl`), toJSONL(trace.slice(0, cut)) + next.slice(0, 20));
  writeFileSync(join(dir, `${runId}.lock`), String(DEAD_PID));
}

describe("fileStore", () => {
  it("writes a run as it goes and reads it back", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const result = await graph.run({ n: 0 }, { onEvent: store.sink });
    expect(store.load(result.runId)).toEqual(JSON.parse(JSON.stringify(result.trace)));
    expect(existsSync(join(dir, `${result.runId}.lock`))).toBe(false);
    expect(store.list()).toMatchObject([{ runId: result.runId, status: "completed", events: result.trace.length }]);
    expect(store.load("missing")).toBeUndefined();
  });

  it("continues a run whose last line was torn by a crash", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const cut = trace.findIndex((e) => e.type === "exit" && e.nodeId === "a") + 1;
    crashed(dir, trace, cut);
    const store = fileStore(dir);
    expect(store.list()).toMatchObject([{ runId: trace[0]?.runId, status: "interrupted" }]);
    const loaded = store.load(trace[0]?.runId as string) as Trace;
    expect(loaded).toHaveLength(cut);
    const done = await graph.resume(loaded, undefined, { onEvent: store.sink });
    expect(done.state).toMatchObject({ n: 2, sent: true });
    expect(runStatus(store.load(done.runId) as Trace)).toBe("completed");
    expect(readFileSync(join(dir, `${done.runId}.jsonl`), "utf8").endsWith("\n")).toBe(true);
  });

  it("will not restart a write step that was running when the process died", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const cut = trace.findIndex((e) => e.type === "enter" && e.nodeId === "send") + 1;
    crashed(dir, trace, cut);
    const store = fileStore(dir);
    const error = await graph
      .resume(store.load(trace[0]?.runId as string) as Trace, undefined, { onEvent: store.sink })
      .catch((e: unknown) => e);
    expect(isTaugraphError(error) && error.code).toBe("UNKNOWN_OUTCOME");
  });

  it("pauses, releases the lock, and resumes later", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const paused = await asking.run({ n: 0 }, { onEvent: store.sink });
    expect(existsSync(join(dir, `${paused.runId}.lock`))).toBe(false);
    expect(store.list()).toMatchObject([{ status: "paused" }]);
    const done = await asking.resume(store.load(paused.runId) as Trace, "yes", { onEvent: fileStore(dir).sink });
    expect(done.state.answer).toBe("yes");
    expect(store.list()).toMatchObject([{ status: "completed" }]);
  });

  it("refuses a run another live process is writing, and takes over a dead one's lock", async () => {
    const dir = temp();
    const { trace } = await graph.run({ n: 0 });
    const runId = trace[0]?.runId as string;
    crashed(dir, trace, 3);
    writeFileSync(join(dir, `${runId}.lock`), String(process.pid));
    const store = fileStore(dir);
    expect(store.list()).toMatchObject([{ status: "running" }]);
    const error = await graph.resume(store.load(runId) as Trace, undefined, { onEvent: store.sink }).catch((e) => e);
    expect(String(error)).toContain(`Run "${runId}" is being written by process ${process.pid}`);
    writeFileSync(join(dir, `${runId}.lock`), String(DEAD_PID));
    const done = await graph.resume(store.load(runId) as Trace, undefined, { onEvent: store.sink });
    expect(done.status).toBe("completed");
  });

  it("refuses gaps, duplicate runs and runIds that are not file names", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const { trace } = await graph.run({ n: 0 }, { onEvent: store.sink });
    const runId = trace[0]?.runId as string;
    expect(() => store.sink(trace[0] as Trace[number])).toThrow(`Run "${runId}" already exists in ${dir}`);
    expect(() => store.sink({ ...(trace[5] as Trace[number]), runId: "fresh" })).toThrow(
      `Run "fresh" has no file in ${dir} to continue`,
    );
    const short = temp();
    crashed(short, trace, 3);
    expect(() => fileStore(short).sink(trace[5] as Trace[number])).toThrow(
      `Run "${runId}" on disk ends at seq 2, but the next event is seq 5`,
    );
    expect(() => store.load("../etc/passwd")).toThrow('Invalid runId "../etc/passwd"');
    await expect(graph.run({ n: 0 }, { runId: "a/b", onEvent: store.sink })).rejects.toThrow(/Invalid runId "a\/b"/);
  });

  it("lists every status, oldest first, and skips files it cannot read", async () => {
    const dir = temp();
    const store = fileStore(dir);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 15)); // distinct mtimes
    await graph.run({ n: 0 }, { runId: "done-1", onEvent: store.sink });
    await tick();
    await asking.run({ n: 0 }, { runId: "paused-1", onEvent: store.sink });
    await tick();
    const failing = createGraph(schema, {
      start: "a",
      nodes: {
        a: () => {
          throw new Error("boom");
        },
      },
      endNodes: ["a"],
    });
    await failing.run({ n: 0 }, { runId: "failed-1", onEvent: store.sink }).catch(() => undefined);
    await tick();
    const { trace } = await graph.run({ n: 0 }, { runId: "crashed-1" });
    crashed(dir, trace, 3);
    writeFileSync(join(dir, "junk.jsonl"), "not a trace\n");
    expect(store.list().map((r) => [r.runId, r.status])).toEqual([
      ["done-1", "completed"],
      ["paused-1", "paused"],
      ["failed-1", "failed"],
      ["crashed-1", "interrupted"],
    ]);
  });
});
```

- Create `test/file-durability.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, fsyncSync: vi.fn(real.fsyncSync) };
});

const { fileStore } = await import("../src/file/index.js");
const { createGraph } = await import("../src/index.js");

const schema = z.object({ n: z.number() });
type S = z.infer<typeof schema>;
const graph = createGraph(schema, {
  start: "a",
  nodes: {
    a: (s: S) => ({ n: s.n + 1 }),
    send: Object.assign((s: S) => s, { effect: "write" as const }),
  },
  edges: [{ from: "a", to: "send" }],
  endNodes: ["send"],
});

async function fsyncs(durability?: "writes" | "every" | "none"): Promise<{ count: number; events: number }> {
  const spy = vi.mocked(fs.fsyncSync);
  spy.mockClear();
  const store = fileStore(mkdtempSync(join(tmpdir(), "taugraph-durability-")), durability ? { durability } : {});
  const { trace } = await graph.run({ n: 0 }, { onEvent: store.sink });
  return { count: spy.mock.calls.length, events: trace.length };
}

describe("fileStore durability", () => {
  it("fsyncs the directory once, then around the write step and at the end by default", async () => {
    expect((await fsyncs()).count).toBe(3); // directory, enter of "send", run_end
  });

  it("fsyncs every event, or never", async () => {
    const every = await fsyncs("every");
    expect(every.count).toBe(every.events + 1); // plus the directory
    expect((await fsyncs("none")).count).toBe(0);
  });
});
```

- In `test/architecture.test.ts`, add:

```ts
it("keeps node: modules and Node globals inside taugraph/file", () => {
  for (const { file, imports } of sources("src")) {
    const inFile = file.startsWith(join("src", "file"));
    for (const spec of imports) {
      if (spec.startsWith("node:")) expect(inFile, `${file} imports ${spec}`).toBe(true);
    }
    if (!inFile) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, `${file} mentions process or Buffer`).not.toMatch(/\b(process|Buffer)\b/);
    }
  }
  for (const { file, imports } of sources("src/file")) {
    for (const spec of imports) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\.\/index\.js|node:(fs|path)|\.\/[\w-]+\.js)$/);
    }
  }
});
```

    (`src/core/types.ts:63` has a comment "(e.g. the process crashed)"; change it to "(e.g. after a crash)" so the rule holds.)

- [ ] **Step 2: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/file.test.ts test/file-durability.test.ts test/architecture.test.ts`
Expected: FAIL. `src/file/index.ts` does not exist; the comment in `src/core/types.ts` trips the new rule.

- [ ] **Step 3: Create `src/file/index.ts`.**

```ts
// taugraph/file: one append-only JSONL file per run (format v2), written before each step goes on, with a lock per
// run and a repair for the half-written last line a crash leaves. Uses node:fs, so it runs on Node, Bun and Deno;
// the kernel itself stays platform-free.
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createTraceEncoder, fromJSONL, runStatus, type Trace, type TraceEvent } from "../index.js";

/** When to fsync: around write steps, pauses and the end of a run (default), after every event, or never. */
export type Durability = "writes" | "every" | "none";

export interface FileStoreOptions {
  readonly durability?: Durability | undefined;
}

/** `running`: a live process holds the run's lock. `interrupted`: no `run_end` and nobody is writing it. */
export type StoredRunStatus = "running" | "interrupted" | "paused" | "completed" | "failed";

export interface StoredRun {
  readonly runId: string;
  readonly status: StoredRunStatus;
  readonly events: number;
  /** Last change of the file, in ms since epoch. */
  readonly updatedAt: number;
}

export interface FileStore {
  readonly dir: string;
  /** Pass as `onEvent`. Appends each event before the run continues. */
  readonly sink: (event: TraceEvent) => void;
  /** The stored trace, without a half-written last line. Never changes the file. */
  load(runId: string): Trace | undefined;
  /** Every run in the directory, oldest change first. Files that cannot be read are skipped. */
  list(): StoredRun[];
}

const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

function checkRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new TypeError(`Invalid runId "${runId.slice(0, 40)}"`);
}

/** Whether a process with this id exists. EPERM means it does, under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** The live process holding a lock file, if any. */
function holder(lock: string): number | undefined {
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Lock files this process holds; released if the process exits while a run is still open. */
const held = new Set<string>();
let releaseOnExit = false;

function hold(lock: string): void {
  held.add(lock);
  if (releaseOnExit) return;
  releaseOnExit = true;
  process.once("exit", () => {
    for (const path of held) unlinkQuietly(path);
  });
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Makes a new file's directory entry durable. Not every system can fsync a directory. */
function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // not supported here
  }
}

interface Writing {
  readonly fd: number;
  readonly lock: string;
  readonly encoder: { encode(event: TraceEvent): string };
  next: number;
}

export function fileStore(dir: string, options: FileStoreOptions = {}): FileStore {
  const durability = options.durability ?? "writes";
  const writing = new Map<string, Writing>();
  const fileOf = (runId: string) => join(dir, `${runId}.jsonl`);
  const lockOf = (runId: string) => join(dir, `${runId}.lock`);

  function acquire(runId: string): string {
    const lock = lockOf(runId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, "wx");
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        hold(lock);
        return lock;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        const pid = holder(lock);
        if (pid !== undefined) throw new Error(`Run "${runId}" is being written by process ${pid}`);
        unlinkQuietly(lock); // left by a process that died
      }
    }
    throw new Error(`Run "${runId}" is being written by another process`);
  }

  function release(runId: string, w: Writing): void {
    writing.delete(runId);
    closeSync(w.fd);
    unlinkQuietly(w.lock);
    held.delete(w.lock);
  }

  function open(event: TraceEvent): Writing {
    checkRunId(event.runId);
    mkdirSync(dir, { recursive: true });
    const path = fileOf(event.runId);
    const lock = acquire(event.runId);
    try {
      if (event.seq === 0) {
        if (existsSync(path)) throw new Error(`Run "${event.runId}" already exists in ${dir}`);
        const fd = openSync(path, "a");
        if (durability !== "none") syncDir(dir);
        return { fd, lock, encoder: createTraceEncoder(), next: 0 };
      }
      if (!existsSync(path)) throw new Error(`Run "${event.runId}" has no file in ${dir} to continue`);
      const fd = openSync(path, "a");
      const bytes = readFileSync(path);
      const end = bytes.lastIndexOf(10) + 1; // after the last newline: a torn line after it never took effect
      if (end < bytes.length) ftruncateSync(fd, end);
      const prefix = fromJSONL(new TextDecoder().decode(bytes.subarray(0, end)));
      const last = (prefix[prefix.length - 1] as TraceEvent).seq;
      if (last !== event.seq - 1) {
        closeSync(fd);
        throw new Error(`Run "${event.runId}" on disk ends at seq ${last}, but the next event is seq ${event.seq}`);
      }
      return { fd, lock, encoder: createTraceEncoder(prefix), next: event.seq };
    } catch (error) {
      unlinkQuietly(lock);
      held.delete(lock);
      throw error;
    }
  }

  const sink = (event: TraceEvent): void => {
    let w = writing.get(event.runId);
    if (!w) {
      w = open(event);
      writing.set(event.runId, w);
    }
    if (event.seq !== w.next) throw new Error(`Run "${event.runId}" expected seq ${w.next}, got ${event.seq}`);
    writeSync(w.fd, `${w.encoder.encode(event)}\n`);
    w.next++;
    const critical =
      event.type === "pause" || event.type === "run_end" || (event.type === "enter" && event.meta?.effect === "write");
    if (durability === "every" || (durability === "writes" && critical)) fsyncSync(w.fd);
    if (event.type === "run_end") release(event.runId, w);
  };

  return {
    dir,
    sink,
    load(runId) {
      checkRunId(runId);
      const path = fileOf(runId);
      return existsSync(path) ? fromJSONL(readFileSync(path, "utf8"), { tornTail: "drop" }) : undefined;
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl") && RUN_ID.test(name.slice(0, -".jsonl".length)))
        .flatMap((name): StoredRun[] => {
          const runId = name.slice(0, -".jsonl".length);
          const path = join(dir, name);
          try {
            const trace = fromJSONL(readFileSync(path, "utf8"), { tornTail: "drop" });
            const status = runStatus(trace);
            const stored: StoredRunStatus =
              status !== "running" ? status : holder(lockOf(runId)) !== undefined ? "running" : "interrupted";
            return [{ runId, status: stored, events: trace.length, updatedAt: statSync(path).mtimeMs }];
          } catch {
            return [];
          }
        })
        .sort((a, b) => a.updatedAt - b.updatedAt);
    },
  };
}
```

- [ ] **Step 4: Build config and exports.**
  - `tsconfig.build.json`: change `"types": []` to `"types": ["node"]`.
  - `package.json` `exports`, after `"./openai"`:

```json
    "./file": {
      "types": "./dist/file/index.d.ts",
      "import": "./dist/file/index.js"
    },
```

- [ ] **Step 5: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS.

Run: `pnpm build && test -f dist/file/index.js && echo ok`
Expected: `ok`.

- [ ] **Step 6: Commit.**

```bash
git add src/file src/core/types.ts package.json tsconfig.build.json test/file.test.ts test/file-durability.test.ts test/architecture.test.ts
git commit -m "feat(file): taugraph/file stores runs as crash-safe JSONL files with a lock per run"
```

---

### Task 4: Documentation and the rag example

**Files:**

- Modify: `README.md`, `README.zh-CN.md`, `docs/trace-format.md`, `docs/design.md`, `CHANGELOG.md`, `examples/rag-retry.ts`

**Interfaces:**

- Consumes: names from Tasks 1–3 exactly as written there.

- [ ] **Step 1: README.md.**
  - In `### Trace`, after the paragraph that starts with "`enter` carries the input state", add: "Consecutive snapshots share whatever did not change, in memory and on disk: `toJSONL` writes format v2, which stores each snapshot as a patch against the one before, so a trace grows with what changed rather than with the size of the state."
  - Insert a new section right after the `## Reasoning models` section, before `## Integrations`:

````md
## Saving to files (`taugraph/file`)

`fileStore(dir)` keeps one JSONL file per run and appends every event before the run takes its next step. After a crash, find the runs that did not finish and continue them:

```ts
import { fileStore } from "taugraph/file";

const store = fileStore("./runs");
await graph.run(input, { onEvent: store.sink });

// after a restart
for (const run of store.list()) {
  if (run.status === "interrupted") await graph.resume(store.load(run.runId)!, undefined, { onEvent: store.sink });
}
```

- `list()` reports `running` (a live process holds the run's lock), `interrupted` (no end and nobody writing it), `paused`, `completed` or `failed`.
- A crash can leave the last line half-written. `load` ignores it, and the store cuts it off before it continues the run. A write step that was running stops with `UNKNOWN_OUTCOME` instead of running again.
- `durability` decides when to `fsync`: `"writes"` (default) before a write step runs, at a pause and at the end, so a power cut can lose only read steps, which are safe to run again; `"every"` after each event; `"none"` never.
- Each run has a lock file while it is written, so two processes cannot append to the same run. A lock left by a process that died is taken over.
- It uses `node:fs` (Node, Bun, Deno) and adds no dependencies. Run ids must be plain file names.
````

- [ ] **Step 2: README.zh-CN.md.** The same two changes:
  - In `### Trace` (the matching paragraph about `enter`/`exit`), add: "相邻的快照共享没有变化的部分，内存里如此，写到磁盘上也如此：`toJSONL` 写出 v2 格式，每个快照存成相对上一个快照的改动，所以 trace 随变化的多少增长，而不是随状态的大小增长。"
  - New section right after `## 思考型模型`, before `## 集成`:

````md
## 存成文件（`taugraph/file`）

`fileStore(dir)` 给每个 run 存一个 JSONL 文件，每个事件都在 run 走下一步之前追加写入。崩溃后找出没跑完的 run，接着跑：

```ts
import { fileStore } from "taugraph/file";

const store = fileStore("./runs");
await graph.run(input, { onEvent: store.sink });

// 重启以后
for (const run of store.list()) {
  if (run.status === "interrupted") await graph.resume(store.load(run.runId)!, undefined, { onEvent: store.sink });
}
```

- `list()` 给出五种状态：`running`（有活着的进程持有这个 run 的锁）、`interrupted`（没有结束，也没有进程在写）、`paused`、`completed`、`failed`。
- 崩溃可能留下写了一半的最后一行。`load` 会忽略它，接着跑之前存储会把它截掉。正在执行的写操作步骤会以 `UNKNOWN_OUTCOME` 停下，不会再跑一遍。
- `durability` 决定什么时候 `fsync`：`"writes"`（默认）在写操作步骤开始前、暂停时和结束时，断电最多丢掉只读步骤，重跑它们是安全的；`"every"` 每个事件之后；`"none"` 从不。
- 写入期间每个 run 有一个锁文件，两个进程不能同时追加同一个 run。已经退出的进程留下的锁会被接管。
- 只用 `node:fs`（Node、Bun、Deno），不引入依赖。run id 必须是普通的文件名。
````

- [ ] **Step 3: docs/trace-format.md.** Replace the `## Versioning` section with these two sections:

```md
## Encoding (version 2)

`toJSONL` writes one event per line. Events keep their shape in memory; on disk, an `input` or `output` field may be written as `inputPatch` / `outputPatch`, a JSON Patch (RFC 6902, only `add`, `remove` and `replace`, with `/-` to append to an array) against a base value:

| field                           | base                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `run_start.input`               | none, always written in full                                                                   |
| `enter.input`, `run_end.output` | the current state: the `run_start` input until the first `exit`, then the latest `exit` output |
| `exit.output`                   | the latest `enter.input` of the same step                                                      |
| any other field                 | the same field of the previous event with the same `type` and `nodeId`                         |

A writer uses the patch when it is not longer than the full value; `[]` means equal to the base. `fromJSONL` applies patches in order and returns full events. `toJSONL(trace, { from })` writes the events from `from` on with earlier events as bases, so chunks written that way concatenate into a valid file; `createTraceEncoder(prefix)` does the same one event at a time for a store. `fromJSONL(text, { tornTail: "drop" })` drops a last line that a crash cut short (no final newline, not valid JSON); any other broken line is `INVALID_TRACE`.

## Versioning

`meta.version` on `run_start` is bumped on any breaking change to this format. Version 2 added patches; `fromJSONL` reads versions 1 and 2, and `replay` and `resume` accept both. A file started by an older writer and continued by a newer one may mix full and patched lines; readers handle patch fields wherever they appear. Additive changes, such as new event types or new `meta` fields, do not bump the version; consumers should ignore what they do not know.
```

- [ ] **Step 4: docs/design.md.** Add this section right after `## The log is written ahead`:

```md
## Traces grow with what changed

Every step records its full input and output state, which makes replay and resume simple. Stored naively, that grows with the square of the run: an agent that appends one message per step stores the whole conversation twice per step, and every model call stores its request again. Two layers keep it linear without changing how traces are read. In memory, `freezeJson` reuses what it froze before, and equal parts of the previous state, so consecutive snapshots share structure. On disk, format v2 writes each snapshot as a JSON Patch against its base, and `fromJSONL` rebuilds full events. Making events themselves hold patches would be smaller still, but every reader of `event.input` would need a helper.

`taugraph/file` locks each run with a file holding the writer's process id, so a crashed process's lock can be told apart from a live one and a restart knows which runs to continue. It fsyncs before a write step runs, at pauses and at the end, but not after read steps: losing a read step to a power cut only means running it again, while losing the record of a started write could repeat it.
```

- [ ] **Step 5: CHANGELOG.md.** Under `## [Unreleased]` (currently empty), add:

```md
### Changed

- Trace format version 2: `toJSONL` writes each `input` / `output` as a JSON Patch against a base value when that is shorter, so traces grow with what changed instead of with the square of the run. `fromJSONL`, `resume` and `replay` read versions 1 and 2. In memory, events keep their shape, and consecutive states share the parts that did not change.

### Added

- `taugraph/file`: `fileStore(dir, { durability })` stores one JSONL file per run, appended before each step continues; `load` ignores a half-written last line, and continuing a run cuts it off; a lock file per run keeps two processes from writing the same run; `list()` reports `running`, `interrupted`, `paused`, `completed` or `failed`. `durability` is `"writes"` (default: fsync before write steps, at pauses and at the end), `"every"` or `"none"`.
- `runStatus(trace)`, `createTraceEncoder(prefix)`, `toJSONL(trace, { from })` and `fromJSONL(text, { tornTail: "drop" })`.
```

- [ ] **Step 6: examples/rag-retry.ts.** Replace the hand-written file sink with `fileStore`:
  - Imports: drop `appendFileSync` and `mkdirSync`; keep `readFileSync` only if still used; add `import { fileStore } from "../src/file/index.js";`.
  - Replace the run block with:

```ts
// --- Run, streaming the append-only log to disk.
const store = fileStore(join(import.meta.dirname, "out"));
const result = await graph.run({ question: "What is agent orchestration?" }, { onEvent: store.sink });

console.log("path:   ", result.path.join(" -> "));
console.log("answer: ", result.state.answer);
console.log("trace:  ", join(store.dir, `${result.runId}.jsonl`));

// --- Load the trace back from disk and replay it with a different model.
const recorded = store.load(result.runId);
if (!recorded) throw new Error("the trace was not stored");
```

    and keep the rest of the example as it is (it uses `recorded`). Remove imports that become unused (`fromJSONL`, `readFileSync`).

- [ ] **Step 7: Format, check, run the examples, commit.**

```bash
pnpm exec biome check --write README.md README.zh-CN.md docs/trace-format.md docs/design.md CHANGELOG.md && pnpm format && pnpm check
pnpm example:rag && pnpm example:quickstart && pnpm example:checkout && pnpm example:agent
git add README.md README.zh-CN.md docs/trace-format.md docs/design.md CHANGELOG.md examples/rag-retry.ts
git commit -m "docs: trace format v2 and taugraph/file; the rag example stores its trace with fileStore"
```

Expected: checks pass; `example:rag` prints a trace path under `examples/out/` and the replay diff as before.

---

### Task 5: `taugraph-mcp` stores runs with `taugraph/file`

Repo: `/Users/mi/2026/claw/github/taugraph-mcp`, new branch `feat/trace-v2` from `main`.

**Files:**

- Modify: `src/store.ts` (`fileStore`, `runState`)
- Test: `test/store.test.ts` (new)
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `fileStore` (as `runFiles`), `FileStore` from `taugraph/file`; `runStatus`, `toJSONL` from `taugraph`.
- Produces: same exports as before (`RunStore`, `fileStore`, `memoryStore`, `runState`, `RunState`, `assertRunId`), same behavior plus crash safety.

- [ ] **Step 1: Branch and install this taugraph.**

```bash
cd /Users/mi/2026/claw/github/taugraph && pnpm build && rm -rf /tmp/tg-pack && pnpm pack --pack-destination /tmp/tg-pack
cd /Users/mi/2026/claw/github/taugraph-mcp && git checkout main && git checkout -b feat/trace-v2 && rm -rf node_modules/.pnpm/taugraph@file* && pnpm add /tmp/tg-pack/taugraph-0.3.0.tgz
```

(The tarball is still named 0.3.0; the version bump happens at release.)

- [ ] **Step 2: Write the failing test.** Create `test/store.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph } from "taugraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fileStore, runState } from "../src/store.js";

const schema = z.object({ n: z.number() });
const graph = createGraph(schema, {
  start: "a",
  nodes: { a: (s: z.infer<typeof schema>) => ({ n: s.n + 1 }), b: (s: z.infer<typeof schema>) => ({ n: s.n + 1 }) },
  edges: [{ from: "a", to: "b" }],
  endNodes: ["b"],
});

describe("fileStore", () => {
  it("keeps one v2 file per run under the flow's directory and survives a torn last line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const store = fileStore(dir);
    const { trace, runId } = await graph.run({ n: 0 }, { onEvent: (e) => store.append("count", e) });
    const path = join(dir, "count", `${runId}.jsonl`);
    expect(readFileSync(path, "utf8")).toContain('"version":2');
    expect(store.load("count", runId)).toEqual(JSON.parse(JSON.stringify(trace)));
    expect(store.list()).toEqual([{ flow: "count", runId }]);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":`);
    expect(store.load("count", runId)).toHaveLength(trace.length);
    expect(runState(trace.slice(0, 3))).toBe("interrupted");
    expect(runState(trace)).toBe("completed");
  });
});
```

- [ ] **Step 3: Run it to see it fail.**

Run: `pnpm exec vitest run test/store.test.ts`
Expected: FAIL. The current store writes v1 lines (no `"version":2`) and `fromJSONL` throws on the torn line.

- [ ] **Step 4: Implement.** In `src/store.ts`:
  - Imports: `import { type FileStore, fileStore as runFiles } from "taugraph/file";` and `import { runStatus, type Trace, type TraceEvent } from "taugraph";` (drop `appendFileSync`, `fromJSONL` and other unused imports).
  - Replace `fileStore` with:

```ts
/** One append-only JSONL file per run: `<dir>/<flow>/<runId>.jsonl`, through `taugraph/file`. Survives restarts and crashes. */
export function fileStore(dir: string): RunStore {
  const stores = new Map<string, FileStore>();
  const forFlow = (flow: string): FileStore => {
    let store = stores.get(flow);
    if (!store) {
      store = runFiles(join(dir, flow));
      stores.set(flow, store);
    }
    return store;
  };
  return {
    append(flow, event) {
      assertRunId(event.runId);
      forFlow(flow).sink(event);
    },
    load(flow, runId) {
      assertRunId(runId);
      return forFlow(flow).load(runId);
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) =>
          readdirSync(join(dir, d.name))
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ flow: d.name, runId: f.slice(0, -".jsonl".length) })),
        );
    },
  };
}
```

- Replace the body of `runState` with:

```ts
  const status = runStatus(trace);
  if (status !== "running") return status;
  return trace[trace.length - 1]?.type === "pause" ? "paused" : "interrupted";
```

- [ ] **Step 5: Changelog and checks.** `CHANGELOG.md`, add an `## [Unreleased]` → `### Changed` bullet: ``- `fileStore` now stores runs through `taugraph/file`: trace format v2 (much smaller files), a half-written last line after a crash no longer breaks loading or resuming, a lock file per run, and fsync around write steps. Existing v1 files are still read.``

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit without the dependency change.**

```bash
git checkout package.json pnpm-lock.yaml
git add src/store.ts test/store.test.ts CHANGELOG.md
git commit -m "feat: fileStore through taugraph/file (trace v2, crash-safe, locked)"
```

---

### Task 6: `taugraph-pi` stores chunks in format v2

Repo: `/Users/mi/2026/claw/github/taugraph-pi`, new branch `feat/trace-v2` from `main`.

**Files:**

- Modify: `src/store.ts` (`storeChunk`, `RunStatus`)
- Test: `test/flow-tool.test.ts` (one new case)
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `toJSONL(trace, { from })`, `type RunStatus` from `taugraph`.

- [ ] **Step 1: Branch and install this taugraph.**

```bash
cd /Users/mi/2026/claw/github/taugraph-pi && git checkout main && git checkout -b feat/trace-v2 && rm -rf node_modules/.pnpm/taugraph@file* && pnpm add /tmp/tg-pack/taugraph-0.3.0.tgz
```

- [ ] **Step 2: Write the failing test.** In `test/flow-tool.test.ts`, inside `describe("registerFlowTool without UI")`, add after "stores the trace as contiguous chunks that rebuild the full run":

```ts
it("writes later chunks as patches against events in earlier chunks", async () => {
  const t = setup();
  const first = await t.call("buy", { item: "pen" });
  await t.call("buy_resume", { runId: first.details.runId, answer: "yes" });
  const [, ...later] = t.chunks();
  expect(later.length).toBeGreaterThan(0);
  for (const c of later) {
    for (const line of c.jsonl.trim().split("\n")) {
      if (/"type":"(enter|exit)"/.test(line)) expect(line).toMatch(/"(input|output)Patch"/);
    }
  }
  const run = loadRun(t.ctx, first.details.runId);
  expect(run?.trace.every((e, i) => e.seq === i)).toBe(true);
  expect(run?.trace.at(-1)?.meta).toMatchObject({ status: "completed" });
});
```

- [ ] **Step 3: Run it to see it fail.**

Run: `pnpm exec vitest run test/flow-tool.test.ts`
Expected: the new test FAILS: chunks after the first are written without bases (full values).

- [ ] **Step 4: Implement.** In `src/store.ts`:
  - `storeChunk`: replace `jsonl: toJSONL(trace.slice(saved))` with `jsonl: toJSONL(trace, { from: saved })`.
  - Replace the local `RunStatus` type with `export type { RunStatus } from "taugraph";` and import it as a type where it is used (`import { ..., type RunStatus } from "taugraph";`).

- [ ] **Step 5: Changelog and checks.** `CHANGELOG.md`, `## [Unreleased]` → `### Changed`: `- Trace chunks in the Pi session use trace format v2 and earlier chunks as bases, so stored runs are much smaller.`

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit without the dependency change.**

```bash
git checkout package.json pnpm-lock.yaml
git add src/store.ts test/flow-tool.test.ts CHANGELOG.md
git commit -m "feat: store trace chunks in format v2 against earlier chunks"
```

---

### Task 7: Final verification

- [ ] **Step 1:** In `/Users/mi/2026/claw/github/taugraph`: `pnpm check` and `pnpm build`. Expected: PASS; `dist/file/index.js` exists.
- [ ] **Step 2:** `pnpm example:quickstart && pnpm example:checkout && pnpm example:rag && pnpm example:agent`. Expected: all run; `example:agent` prints `replay equal: true`.
- [ ] **Step 3:** In both siblings, with the latest local tarball installed: `pnpm check` passes; `git status --short` is empty in all three repos; `git diff main --stat -- package.json pnpm-lock.yaml` is empty in both siblings.
