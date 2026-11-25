# `taugraph/openai` and Tool Calling in the Sibling Adapters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the OpenAI-compatible adapter as the plugin entry `taugraph/openai`, and give the Pi and MCP sampling adapters full tool calling, so `taugraph/agent` runs on all of them.

**Architecture:** `examples/adapters/openai-compatible.ts` moves to `src/openai/index.ts` (plus a `fetch` option); the example file re-exports it and keeps `modelFromEnv`. taugraph-mcp's `openAICompatibleModel` forwards to it. The Pi adapter maps tools, tool calls and tool results to Pi's types; the MCP sampling adapter maps them to MCP 2025-11-25 sampling tools (`tool_use` / `tool_result`).

**Tech Stack:** TypeScript (NodeNext, strict), vitest, biome; `@earendil-works/pi-ai` types (Pi 1.5.2); `@modelcontextprotocol/sdk` 1.32.

Spec: `docs/superpowers/specs/2026-11-24-openai-and-sibling-tools-design.md`.

## Global Constraints

- taugraph: zero runtime dependencies; `src/core` untouched; `src/openai` imports only `../index.js`, `../nodes/index.js` and `./*.js`; no `process` in `src/` (the build has no Node types).
- `taugraph/openai` keeps every existing name and behavior of the example adapter: `openAICompatible`, `OpenAICompatibleOptions`, `toOpenAIMessages`, `toOpenAITools`, `toOpenAIToolChoice`, `fromOpenAIToolCalls`, `OpenAIToolCall`, id `openai-compatible:<model>`.
- A `toolChoice` an adapter cannot express exactly is an error, never a silent fallback.
- Error texts, verbatim:
  - `Pi supports toolChoice "auto" and "none" only, got <JSON.stringify(toolChoice)>`
  - `Tool result "<id>" answers no call in an earlier assistant message`
  - `This flow uses tools, but the MCP client does not support tools in sampling (sampling.tools).`
  - `toolChoice names "<name>", which is not one of the request's tools`
- Library text and code comments in English.
- `pnpm check` must pass in every repo touched; `pnpm format` fixes formatting; Markdown through `pnpm exec biome check --write <file>`.
- taugraph work is on branch `feat/openai` (spec committed as `2e2023c`). Sibling work continues on each sibling's `feat/images` branch; their `package.json` and `pnpm-lock.yaml` are not committed.

---

### Task 1: `taugraph/openai`

**Files:**

- Move: `examples/adapters/openai-compatible.ts` → `src/openai/index.ts` (then edit)
- Create: `examples/adapters/openai-compatible.ts` (re-export + `modelFromEnv`)
- Move: `test/adapter.test.ts` → `test/openai.test.ts` (then edit)
- Modify: `package.json` (`exports`), `test/architecture.test.ts`

**Interfaces:**

- Produces: entry `taugraph/openai` exporting `openAICompatible`, `OpenAICompatibleOptions` (now with `fetch?: typeof fetch`), `toOpenAIMessages`, `toOpenAITools`, `toOpenAIToolChoice`, `fromOpenAIToolCalls`, `OpenAIToolCall`. `examples/adapters/openai-compatible.ts` exports all of that plus `modelFromEnv()`.

- [ ] **Step 1: Move the files.**

```bash
git mv examples/adapters/openai-compatible.ts src/openai/index.ts
git mv test/adapter.test.ts test/openai.test.ts
```

- [ ] **Step 2: Write the failing tests.**
  - In `test/openai.test.ts`, change the import to
    `import { fromOpenAIToolCalls, openAICompatible, toOpenAIMessages } from "../src/openai/index.js";`
    and add inside the `describe`:

```ts
it("uses the fetch it is given instead of the global one", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("global fetch used");
  });
  const urls: string[] = [];
  const model = openAICompatible({
    baseURL: "http://x/v1/",
    model: "m",
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    },
  });
  const response = await model.complete(
    { messages: [{ role: "user", content: "q" }] },
    { signal: new AbortController().signal },
  );
  expect(response.content).toBe("ok");
  expect(urls).toEqual(["http://x/v1/chat/completions"]);
});
```

- In `test/architecture.test.ts`, add after "builds the agent on the public API only":

```ts
it("builds the OpenAI-compatible adapter on the public API only", () => {
  for (const { file, imports } of sources("src/openai")) {
    for (const spec of imports) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\.\/index\.js|\.\.\/nodes\/index\.js|\.\/[\w-]+\.js)$/);
    }
  }
});
```

- [ ] **Step 3: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/openai.test.ts test/architecture.test.ts`
Expected: FAIL. The architecture rule rejects the `../../src/...` imports still in `src/openai/index.ts`, and there is no `fetch` option yet.

- [ ] **Step 4: Make `src/openai/index.ts` a plugin.**
  - Replace the three header comment lines with:

```ts
// taugraph/openai: the LLMModel contract on any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, Qwen,
// Kimi, Ollama, vLLM, LM Studio, ...), with tool calling, images and reasoning. A plugin like taugraph/agent: it uses
// the global fetch, or the one you pass, and adds no dependencies.
```

- Change the imports to `from "../index.js"` (for `MaybePromise`) and `from "../nodes/index.js"` (everything else).
- Add to `OpenAICompatibleOptions`:

```ts
  /** Used instead of the global `fetch`, e.g. for a proxy, retries or tests. */
  readonly fetch?: typeof fetch;
```

- In `complete`, change `const response = await fetch(url, {` to `const response = await (options.fetch ?? fetch)(url, {`.
- Delete `modelFromEnv` and its doc comment (it reads `process.env`).

* [ ] **Step 5: Recreate the example file.** Create `examples/adapters/openai-compatible.ts`:

```ts
// The OpenAI-compatible adapter ships as `taugraph/openai`. The examples import it from here, together with a helper
// that reads the endpoint from the environment.
import type { LLMModel } from "../../src/nodes/index.js";
import { openAICompatible } from "../../src/openai/index.js";

export * from "../../src/openai/index.js";

/** Uses TAUGRAPH_BASE_URL / TAUGRAPH_MODEL / TAUGRAPH_API_KEY when set, otherwise returns undefined. */
export function modelFromEnv(): LLMModel | undefined {
  const { TAUGRAPH_BASE_URL: baseURL, TAUGRAPH_MODEL: model, TAUGRAPH_API_KEY: apiKey } = process.env;
  if (!baseURL || !model) return undefined;
  return openAICompatible({ baseURL, model, ...(apiKey && { apiKey }) });
}
```

- [ ] **Step 6: Export the entry.** In `package.json` `exports`, add after `"./agent"`:

```json
    "./openai": {
      "types": "./dist/openai/index.d.ts",
      "import": "./dist/openai/index.js"
    },
```

- [ ] **Step 7: Run the checks.**

Run: `pnpm format && pnpm check`
Expected: PASS (all earlier adapter tests unchanged, plus the two new ones).

Run: `pnpm build && test -f dist/openai/index.js && test -f dist/openai/index.d.ts && echo ok`
Expected: `ok`.

Run: `pnpm example:quickstart && pnpm example:checkout && pnpm example:rag && pnpm example:agent`
Expected: all run as before; `example:agent` prints `replay equal: true`.

- [ ] **Step 8: Commit.**

```bash
git add -A src/openai examples/adapters test/openai.test.ts test/adapter.test.ts test/architecture.test.ts package.json
git commit -m "feat(openai): ship the OpenAI-compatible adapter as taugraph/openai, with a fetch option"
```

---

### Task 2: Documentation for `taugraph/openai`

**Files:**

- Modify: `README.md`, `README.zh-CN.md`, `docs/design.md`, `CHANGELOG.md`

**Interfaces:**

- Consumes: the names from Task 1.

- [ ] **Step 1: README.md.**
  - Insert a new section right after the Agent section, before `## Images`:

````md
## OpenAI-compatible models (`taugraph/openai`)

`openAICompatible` turns any OpenAI-compatible `/chat/completions` endpoint into an `LLMModel`: OpenAI, DeepSeek, Qwen, Kimi, Ollama, vLLM, LM Studio and others. It translates tool calls, images and reasoning, uses the global `fetch`, and adds no dependencies. The kernel and `taugraph/nodes` contain no provider code; this entry is an optional plugin, like `taugraph/agent`.

```ts
import { openAICompatible } from "taugraph/openai";

const model = openAICompatible({
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: process.env.DEEPSEEK_API_KEY,
});
```

| Option            | What it does                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `resolveImage`    | Reads image references such as `media:abc` when a request is sent; see [Images](#images)  |
| `reasoningParams` | Maps a reasoning level to request parameters; see [Reasoning models](#reasoning-models)   |
| `sendReasoning`   | `false` stops sending the model's own reasoning back, for endpoints that refuse the field |
| `fetch`           | Used instead of the global `fetch`, e.g. for a proxy, retries or tests                    |

Any other provider fits the same contract through a small adapter of your own: an `LLMModel` is `{ id, complete(request, { signal }) }`.
````

- Line 124 (quick-start comment): `// Any provider fits this contract; taugraph/openai covers OpenAI-compatible endpoints.`
- The paragraph under the plugin-nodes table that starts with `` `LLMNode` only defines the call contract ``: replace the sentence that points to `examples/adapters` with ``[`taugraph/openai`](#openai-compatible-models-taugraphopenai) covers OpenAI-compatible endpoints.``
- Every other link to `./examples/adapters/openai-compatible.ts` (Agent, Images and Reasoning sections) points to `#openai-compatible-models-taugraphopenai` instead; keep the link text.

* [ ] **Step 2: README.zh-CN.md.** The same changes:
  - New section right after the Agent section, before `## 图片`:

````md
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

| 选项              | 作用                                                            |
| ----------------- | --------------------------------------------------------------- |
| `resolveImage`    | 发请求时读取 `media:abc` 这类图片引用，见[图片](#图片)          |
| `reasoningParams` | 把思考档位换成请求参数，见[思考型模型](#思考型模型)             |
| `sendReasoning`   | 设为 `false` 时不再把模型自己的思考发回，用于拒收这个字段的接口 |
| `fetch`           | 代替全局的 `fetch`，用于代理、重试或测试                        |

其他服务商写一个小适配器就能接入同一个契约：`LLMModel` 就是 `{ id, complete(request, { signal }) }`。
````

- Line 124: `// 任何模型提供方都能适配这个契约；OpenAI 兼容接口直接用 taugraph/openai`
- The paragraph under the plugin-nodes table: replace the sentence that points to `examples/adapters` with ``[`taugraph/openai`](#openai-兼容模型taugraphopenai) 负责对接 OpenAI 兼容接口。``
- Every other link to `./examples/adapters/openai-compatible.ts` points to `#openai-兼容模型taugraphopenai` instead; keep the link text.

* [ ] **Step 3: docs/design.md.** Add this section right after `## Reasoning: levels, and signatures per model`:

```md
## `taugraph/openai` is a plugin, not an example

The OpenAI-compatible adapter started in `examples/` so the kernel would stay free of provider code. It was then copied into taugraph-mcp and into an app built on taugraph: three copies of the same tool-call, image and reasoning translation to keep in step. It needs nothing but `fetch`, so it now ships as an optional entry point next to `taugraph/agent`. The kernel and `taugraph/nodes` still contain no provider code, and an app that talks to another provider never loads it.
```

- [ ] **Step 4: CHANGELOG.md.** Under `## [Unreleased]`:
  - In `### Added`, add: ``- `taugraph/openai`: the OpenAI-compatible adapter, formerly an example, as a plugin entry point. `openAICompatible({ baseURL, model, apiKey?, resolveImage?, reasoningParams?, sendReasoning?, fetch? })` covers tool calls, images and reasoning and uses the global `fetch` unless given one. No dependencies.``
  - In the other Unreleased bullets, replace "The OpenAI-compatible example adapter" with "`taugraph/openai`" and "OpenAI-compatible example adapter" with "`taugraph/openai`".

- [ ] **Step 5: Check for leftovers.**

Run: `grep -n "examples/adapters\|example adapter" README.md README.zh-CN.md docs/design.md docs/trace-format.md CHANGELOG.md`
Expected: no line outside released CHANGELOG sections (`## [0.2.0]` and older). Fix any other hit to point to `taugraph/openai`.

- [ ] **Step 6: Format, check, commit.**

```bash
pnpm exec biome check --write README.md README.zh-CN.md docs/design.md CHANGELOG.md && pnpm check
git add README.md README.zh-CN.md docs/design.md CHANGELOG.md docs/trace-format.md
git commit -m "docs: taugraph/openai"
```

---

### Task 3: Tool calling in `taugraph-pi`

Repo: `/Users/mi/2026/claw/github/taugraph-pi`, branch `feat/images` (already has the images and reasoning work).

**Files:**

- Modify: `src/model.ts`
- Test: `test/model.test.ts`
- Modify: `README.md:103`, `README.zh-CN.md` (the bullet at about line 12), `CHANGELOG.md`

**Interfaces:**

- Consumes: `ToolCall`, `LLMRequest.tools` / `toolChoice`, assistant `toolCalls`, `tool` messages from `taugraph/nodes`; `createAgent`, `tool` from `taugraph/agent` (tests only), through a local pack of the taugraph branch.

- [ ] **Step 1: Install this taugraph.**

```bash
cd /Users/mi/2026/claw/github/taugraph && pnpm build && rm -rf /tmp/tg-pack && pnpm pack --pack-destination /tmp/tg-pack
cd /Users/mi/2026/claw/github/taugraph-pi && git checkout feat/images && rm -rf node_modules/.pnpm/taugraph@file* && pnpm add /tmp/tg-pack/taugraph-0.2.0.tgz
```

- [ ] **Step 2: Write the failing tests.** In `test/model.test.ts`:
  - Add `import { createAgent, tool } from "taugraph/agent";` to the imports.
  - Add a helper below `ctxWith`:

```ts
/** A Pi session whose model answers with the given replies in turn. */
function scriptedPi(replies: Record<string, unknown>[], seen: unknown[][] = []) {
  return {
    model,
    modelRegistry: {
      complete: async (...args: unknown[]) => {
        seen.push(args);
        return { model: "m-1", usage: { input: 1, output: 1 }, stopReason: "stop", content: [], ...replies.shift() };
      },
    },
  } as unknown as ExtensionContext;
}
```

- Inside `describe("piModel")`, add:

```ts
it("passes tools to Pi and only the tool choices Pi has", async () => {
  const calls: unknown[][] = [];
  const simple: unknown[][] = [];
  const m = piModel(ctxWith({}, calls, simple));
  const signal = new AbortController().signal;
  const tools = [{ name: "weather", inputSchema: { type: "object" } }];
  const messages = [{ role: "user" as const, content: "q" }];
  await m.complete({ messages, tools, toolChoice: "auto" }, { signal });
  expect(calls).toHaveLength(1);
  expect((calls[0]?.[1] as { tools: unknown }).tools).toEqual([
    { name: "weather", description: "", parameters: { type: "object" } },
  ]);
  await m.complete({ messages, tools, toolChoice: "none" }, { signal });
  expect(simple[0]?.[2]).toMatchObject({ toolChoice: "none" });
  expect(simple[0]?.[2]).not.toHaveProperty("reasoning");
  await expect(m.complete({ messages, tools, toolChoice: "required" }, { signal })).rejects.toThrow(
    'Pi supports toolChoice "auto" and "none" only, got "required"',
  );
  await expect(m.complete({ messages, tools, toolChoice: { name: "weather" } }, { signal })).rejects.toThrow(
    'Pi supports toolChoice "auto" and "none" only, got {"name":"weather"}',
  );
});

it("reads Pi's tool calls with their signatures and argument errors", async () => {
  const reply = {
    content: [
      { type: "toolCall", id: "c1", name: "weather", arguments: { city: "南京" }, thoughtSignature: "ts" },
      { type: "toolCall", id: "c2", name: "weather", arguments: {}, argumentsError: "not JSON: {" },
    ],
    stopReason: "toolUse",
  };
  const res = await piModel(ctxWith(reply)).complete(
    { messages: [{ role: "user", content: "q" }] },
    { signal: new AbortController().signal },
  );
  expect(res.toolCalls).toEqual([
    { id: "c1", name: "weather", arguments: { city: "南京" }, signature: "ts" },
    { id: "c2", name: "weather", arguments: {}, parseError: "not JSON: {" },
  ]);
  expect(res.finishReason).toBe("toolUse");
});

it("runs a tool loop with createAgent", async () => {
  const seen: unknown[][] = [];
  const ctx = scriptedPi(
    [
      {
        content: [{ type: "toolCall", id: "c1", name: "weather", arguments: { city: "南京" } }],
        stopReason: "toolUse",
      },
      { content: [{ type: "text", text: "南京晴" }] },
    ],
    seen,
  );
  const weather = tool({
    name: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    run: (args) => `${String(args.city)}: 晴`,
  });
  const { state } = await createAgent({ model: piModel(ctx), tools: [weather] }).run({
    messages: [{ role: "user", content: "南京天气" }],
  });
  expect(state.final).toBe("南京晴");
  const second = seen[1]?.[1] as { messages: { role: string }[]; tools: unknown[] };
  expect(second.tools).toEqual([
    { name: "weather", description: "", parameters: { type: "object", properties: { city: { type: "string" } } } },
  ]);
  expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(second.messages[2]).toMatchObject({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "weather",
    content: [{ type: "text", text: "南京: 晴" }],
    isError: false,
  });
});
```

- Inside `describe("toPiContext")`, add:

```ts
it("sends tool calls and results back in Pi's shape", () => {
  const call = { id: "c1", name: "shot", arguments: { url: "x" }, signature: "ts" };
  const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  const ctx = toPiContext(
    {
      messages: [
        { role: "assistant", content: "", toolCalls: [call], reasoning: [{ text: "plan" }], model: "pi:acme/m-1" },
        { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "page" }, png] },
        { role: "assistant", content: "again", toolCalls: [{ ...call, id: "c2" }], model: "pi:other/x" },
        { role: "tool", toolCallId: "c2", content: "boom", isError: true },
      ],
    },
    model,
  );
  expect(ctx.messages[0]).toMatchObject({
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "toolCall", id: "c1", name: "shot", arguments: { url: "x" }, thoughtSignature: "ts" },
    ],
  });
  expect(ctx.messages[1]).toMatchObject({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "shot",
    isError: false,
    content: [{ type: "text", text: "page" }, png],
  });
  expect(ctx.messages[2]).toMatchObject({
    content: [
      { type: "text", text: "again" },
      { type: "toolCall", id: "c2", name: "shot", arguments: { url: "x" } },
    ],
  });
  expect((ctx.messages[2] as { content: object[] }).content[1]).not.toHaveProperty("thoughtSignature");
  expect(ctx.messages[3]).toMatchObject({
    role: "toolResult",
    toolCallId: "c2",
    toolName: "shot",
    isError: true,
    content: [{ type: "text", text: "boom" }],
  });
  expect(() => toPiContext({ messages: [{ role: "tool", toolCallId: "zz", content: "x" }] }, model)).toThrow(
    'Tool result "zz" answers no call in an earlier assistant message',
  );
});
```

- [ ] **Step 3: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/model.test.ts`
Expected: FAIL. Tools are not passed, tool calls are not read, and tool messages are dropped.

- [ ] **Step 4: Implement.** In `src/model.ts`:
  - Add `type ToolCall,` to the `taugraph/nodes` import, and add next to `PiReply`:

```ts
type PiAssistantContent = Extract<PiContext["messages"][number], { role: "assistant" }>["content"][number];
type PiToolCall = Extract<PiAssistantContent, { type: "toolCall" }>;
```

- At the start of `complete` (before `current()`), add:

```ts
if (request.toolChoice !== undefined && request.toolChoice !== "auto" && request.toolChoice !== "none") {
  throw new TypeError(`Pi supports toolChoice "auto" and "none" only, got ${JSON.stringify(request.toolChoice)}`);
}
```

- Replace the `reply` statement with:

```ts
// Pi's thinking levels and tool choice exist on its provider-neutral API only; "off" is no level there, and
// "auto" is Pi's default when tools are given.
const simple = request.reasoning !== undefined || request.toolChoice === "none";
const reply: PiReply = !simple
  ? await ctx.modelRegistry.complete(model, context, base)
  : await ctx.modelRegistry
      .streamSimple(model, context, {
        ...base,
        ...(request.reasoning !== undefined && request.reasoning !== "off" && { reasoning: request.reasoning }),
        ...(request.toolChoice === "none" && { toolChoice: "none" as const }),
      })
      .result();
```

- After the `reasoning` constant, add:

```ts
const toolCalls = reply.content.flatMap((part): ToolCall[] =>
  part.type === "toolCall"
    ? [
        {
          id: part.id,
          name: part.name,
          arguments: part.arguments,
          ...(part.thoughtSignature !== undefined && { signature: part.thoughtSignature }),
          ...(part.argumentsError !== undefined && { parseError: part.argumentsError }),
        },
      ]
    : [],
);
```

    and add `...(toolCalls.length > 0 && { toolCalls }),` as the last property of `response`.
- In `toPiContext`:
  - Before the `messages` constant, add `const names = new Map<string, string>(); // tool call id -> tool name`.
  - Replace the assistant branch with:

```ts
    if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
      const own = m.model === idOf(model);
      const thinking = own ? (m.reasoning ?? []).map(toPiThinking) : [];
      const calls = (m.toolCalls ?? []).map((c) => toPiToolCall(c, own));
      const text = m.content !== "" || calls.length === 0 ? [{ type: "text" as const, text: m.content }] : [];
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost };
      return [
        {
          role: "assistant",
          content: [...thinking, ...text, ...calls],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: calls.length > 0 ? "toolUse" : "stop",
          timestamp,
        },
      ];
    }
    if (m.role === "tool") {
      const toolName = names.get(m.toolCallId);
      if (toolName === undefined) {
        throw new TypeError(`Tool result "${m.toolCallId}" answers no call in an earlier assistant message`);
      }
      return [
        {
          role: "toolResult",
          toolCallId: m.toolCallId,
          toolName,
          content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map(toPiPart),
          isError: m.isError === true,
          timestamp,
        },
      ];
    }
```

    - Replace the final `return` with:

```ts
  const tools = (request.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema,
  }));
  return { ...(systemPrompt !== "" && { systemPrompt }), messages, ...(tools.length > 0 && { tools }) };
```

- Add below `toPiThinking`:

```ts
/** A taugraph tool call as Pi's. The thought signature only goes back to the model that wrote it. */
const toPiToolCall = (c: ToolCall, own: boolean): PiToolCall => ({
  type: "toolCall",
  id: c.id,
  name: c.name,
  arguments: c.arguments as PiToolCall["arguments"],
  ...(own && c.signature !== undefined && { thoughtSignature: c.signature }),
});
```

- Update `toPiContext`'s doc comment to:

```ts
/** taugraph chat messages -> Pi context. System messages become the system prompt; tools go into `tools`. */
```

- [ ] **Step 5: Docs and checks.**
  - `README.md:103`: append ``Tools work too: `request.tools` go to Pi, tool calls come back in `response.toolCalls`, and tool results go back as Pi tool results, so `taugraph/agent` runs on Pi. Pi takes `toolChoice` `"auto"` and `"none"` only; other choices are an error.``
  - `README.zh-CN.md`, the "LLM 步骤使用你在 Pi 里选的模型" bullet: append ``工具调用也支持：`request.tools` 交给 Pi，工具调用在 `response.toolCalls` 里，工具结果作为 Pi 的工具结果发回，所以 `taugraph/agent` 可以跑在 Pi 上。Pi 只支持 `toolChoice` 为 `"auto"` 和 `"none"`，其他取值会报错。``
  - `CHANGELOG.md`, under `## [Unreleased]` → `### Added`: ``- Tool calling: `request.tools` go into Pi's context, Pi's tool calls come back as `response.toolCalls` (with `signature` and `parseError`), and tool results go back as Pi tool results with their tool name, so `taugraph/agent` runs on Pi. `toolChoice` `"none"` goes through `streamSimple`; `"required"` and `{ name }` are errors because Pi has no such choice. Requires taugraph 0.3.0.``

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit without the dependency change.**

```bash
git checkout package.json pnpm-lock.yaml
git add src/model.ts test/model.test.ts README.md README.zh-CN.md CHANGELOG.md
git commit -m "feat: tool calling (needs taugraph 0.3.0)"
```

---

### Task 4: Tool calling in `taugraph-mcp`, and `openAICompatibleModel` through `taugraph/openai`

Repo: `/Users/mi/2026/claw/github/taugraph-mcp`, branch `feat/images` (already has the images and reasoning work).

**Files:**

- Modify: `src/models.ts`
- Test: `test/models.test.ts`
- Modify: `README.md` (Models section), `README.zh-CN.md` (same section), `CHANGELOG.md`

**Interfaces:**

- Consumes: `taugraph/openai` (`openAICompatible`, `OpenAICompatibleOptions`) from Task 1; `ToolCall`, `ChatMessage`, `LLMRequest.tools` / `toolChoice` from `taugraph/nodes`; `createAgent`, `tool` from `taugraph/agent` (tests only).
- Produces: `openAICompatibleModel(options: OpenAICompatibleOptions): LLMModel` (same name, options re-exported from `taugraph/openai`); `samplingModel` with tool calling.

- [ ] **Step 1: Install this taugraph.**

```bash
cd /Users/mi/2026/claw/github/taugraph-mcp && git checkout feat/images && rm -rf node_modules/.pnpm/taugraph@file* && pnpm add /tmp/tg-pack/taugraph-0.2.0.tgz
```

(The tarball comes from Task 3 Step 1; rebuild it the same way if `/tmp/tg-pack` is gone.)

- [ ] **Step 2: Write the failing tests.** In `test/models.test.ts`:
  - Add imports:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAgent, tool } from "taugraph/agent";
```

    (change the existing `import type { Server }` to the value import above).
- Add helpers below `samplingServer`:

```ts
type Params = Record<string, unknown> & { messages?: unknown[] };

/** A fake server whose client may or may not support tools in sampling. */
function toolServer(replies: unknown[], seen: Params[] = [], tools = true): Server {
  return {
    getClientCapabilities: () => ({ sampling: tools ? { tools: {} } : {} }),
    createMessage: async (params: Params) => {
      seen.push(params);
      return replies.shift();
    },
  } as unknown as Server;
}

/** A real MCP server and client over an in-memory transport; the client answers sampling with the given replies. */
async function samplingPair(replies: unknown[], seen: Params[]): Promise<Server> {
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const client = new Client({ name: "client", version: "0.0.0" }, { capabilities: { sampling: { tools: {} } } });
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    seen.push(request.params as Params);
    return replies.shift() as never;
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return server;
}

const weatherSpec = { name: "weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } };
const weather = tool({ ...weatherSpec, run: (args) => `${String(args.city)}: 晴` });
const text = (t: string) => ({ role: "assistant", model: "m", content: { type: "text", text: t } });
```

- Inside `describe("samplingModel")`, add:

```ts
it("needs a client that supports tools in sampling when the flow uses tools", async () => {
  const plain = samplingModel(toolServer([], [], false));
  await expect(
    plain.complete({ messages: [{ role: "user", content: "q" }], tools: [weatherSpec] }, { signal }),
  ).rejects.toThrow("This flow uses tools, but the MCP client does not support tools in sampling (sampling.tools).");
  const seen: Params[] = [];
  const reply = await samplingModel(toolServer([text("hi")], seen, false)).complete(
    { messages: [{ role: "user", content: "q" }] },
    { signal },
  );
  expect(reply.content).toBe("hi");
  expect(seen[0]).not.toHaveProperty("tools");
});

it("passes tools and maps tool choices to MCP modes", async () => {
  const seen: Params[] = [];
  const model = samplingModel(toolServer([text("a"), text("b"), text("c"), text("d")], seen));
  const other = { name: "clock", inputSchema: { type: "object" } };
  const ask = (toolChoice: unknown) =>
    model.complete({ messages: [{ role: "user", content: "q" }], tools: [weatherSpec, other], toolChoice } as never, {
      signal,
    });
  await ask("auto");
  await ask("required");
  await ask("none");
  await ask({ name: "clock" });
  expect(seen.map((p) => p.toolChoice)).toEqual([
    { mode: "auto" },
    { mode: "required" },
    { mode: "none" },
    { mode: "required" },
  ]);
  expect(seen[0]?.tools).toEqual([weatherSpec, other]);
  expect(seen[3]?.tools).toEqual([other]);
  await expect(ask({ name: "zzz" })).rejects.toThrow(
    'toolChoice names "zzz", which is not one of the request\'s tools',
  );
});

it("sends tool calls as tool_use blocks and consecutive results as one message of tool_result blocks", async () => {
  const seen: Params[] = [];
  const reply = await samplingModel(
    toolServer(
      [
        {
          role: "assistant",
          model: "m",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "c3", name: "weather", input: { city: "北京" } },
          ],
        },
      ],
      seen,
    ),
  ).complete(
    {
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "two cities",
          toolCalls: [
            { id: "c1", name: "weather", arguments: { city: "南京" } },
            { id: "c2", name: "weather", arguments: { city: "上海" } },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "晴" },
        { role: "tool", toolCallId: "c2", content: [{ type: "text", text: "down" }], isError: true },
      ],
      tools: [weatherSpec],
    },
    { signal },
  );
  expect(seen[0]?.messages).toEqual([
    { role: "user", content: { type: "text", text: "q" } },
    {
      role: "assistant",
      content: [
        { type: "text", text: "two cities" },
        { type: "tool_use", id: "c1", name: "weather", input: { city: "南京" } },
        { type: "tool_use", id: "c2", name: "weather", input: { city: "上海" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "晴" }] },
        { type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "down" }], isError: true },
      ],
    },
  ]);
  expect(reply).toEqual({
    content: "checking",
    model: "m",
    finishReason: "toolUse",
    toolCalls: [{ id: "c3", name: "weather", arguments: { city: "北京" } }],
  });
});

it("runs a tool loop with createAgent through a real MCP client", async () => {
  const seen: Params[] = [];
  const server = await samplingPair(
    [
      {
        role: "assistant",
        model: "m",
        stopReason: "toolUse",
        content: [{ type: "tool_use", id: "c1", name: "weather", input: { city: "南京" } }],
      },
      { role: "assistant", model: "m", stopReason: "endTurn", content: { type: "text", text: "南京晴" } },
    ],
    seen,
  );
  const { state } = await createAgent({ model: samplingModel(server), tools: [weather] }).run({
    messages: [{ role: "user", content: "南京天气" }],
  });
  expect(state.final).toBe("南京晴");
  expect(seen[0]?.tools).toEqual([weatherSpec]);
  expect(seen[1]?.messages).toEqual([
    { role: "user", content: { type: "text", text: "南京天气" } },
    { role: "assistant", content: { type: "tool_use", id: "c1", name: "weather", input: { city: "南京" } } },
    { role: "user", content: { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "南京: 晴" }] } },
  ]);
});
```

- Inside `describe("openAICompatibleModel")`, add:

```ts
it("calls tools through taugraph/openai", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"南京"}' } }],
          },
        },
      ],
    });
  });
  const reply = await openAICompatibleModel({ baseURL: "http://x/v1", model: "m" }).complete(
    { messages: [{ role: "user", content: "q" }], tools: [weatherSpec], toolChoice: "required" },
    { signal },
  );
  expect(body.tools).toEqual([
    { type: "function", function: { name: "weather", parameters: weatherSpec.inputSchema } },
  ]);
  expect(body.tool_choice).toBe("required");
  expect(reply.toolCalls).toEqual([{ id: "c1", name: "weather", arguments: { city: "南京" } }]);
});
```

- [ ] **Step 3: Run the tests to see them fail.**

Run: `pnpm exec vitest run test/models.test.ts`
Expected: FAIL. `samplingModel` sends no tools and drops tool messages; `openAICompatibleModel` sends no tools.

- [ ] **Step 4: Forward `openAICompatibleModel` to `taugraph/openai`.** In `src/models.ts`:
  - Delete `OpenAICompatibleOptions`, `SENDABLE`, `toOpenAIPart`, `defaultReasoningParams` and the body of `openAICompatibleModel`, and add:

```ts
import { openAICompatible, type OpenAICompatibleOptions } from "taugraph/openai";

export type { OpenAICompatibleOptions } from "taugraph/openai";

/** Any OpenAI-compatible `/chat/completions` endpoint through `taugraph/openai`: tools, images and reasoning included. */
export function openAICompatibleModel(options: OpenAICompatibleOptions): LLMModel {
  return openAICompatible(options);
}
```

- Remove imports that are no longer used (`pnpm check` lists them).

* [ ] **Step 5: Tool calling in `samplingModel`.** In `src/models.ts`:
  - Add `type ChatMessage,` and `type ToolCall,` to the `taugraph/nodes` import.
  - Replace `SamplingBlock` and `toSamplingContent` with:

```ts
type SamplingBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: SamplingBlock[]; isError?: boolean };
type MessageBlock = SamplingBlock | ToolUseBlock | ToolResultBlock;
type SamplingMessage = { role: "user" | "assistant"; content: MessageBlock | MessageBlock[] };

/** One block alone, several as an array: clients before MCP 2025-11-25 take single blocks only. */
const one = <T>(blocks: T[]): T | T[] => (blocks.length === 1 ? (blocks[0] as T) : blocks);

/** MCP content blocks for a message's content; images must be base64 by now. */
function toBlocks(content: MessageContent): SamplingBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): SamplingBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    if ("data" in part) return { type: "image", data: part.data, mimeType: part.mimeType };
    throw new TypeError(
      `MCP sampling takes images as base64 only, but got the URL "${shown(part.url)}"; make resolveImage return { data, mimeType }`,
    );
  });
}

/** taugraph messages as MCP sampling messages: tool calls become tool_use blocks, and consecutive tool results one user message of tool_result blocks. */
function toSamplingMessages(messages: readonly ChatMessage[]): SamplingMessage[] {
  const out: SamplingMessage[] = [];
  let results: ToolResultBlock[] = [];
  const flush = () => {
    if (results.length > 0) out.push({ role: "user", content: one(results) });
    results = [];
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      results.push({
        type: "tool_result",
        toolUseId: m.toolCallId,
        content: toBlocks(m.content),
        ...(m.isError && { isError: true }),
      });
      continue;
    }
    flush();
    if (m.role === "user") {
      out.push({ role: "user", content: one(toBlocks(m.content)) });
      continue;
    }
    const calls = (m.toolCalls ?? []).map(
      (c): ToolUseBlock => ({ type: "tool_use", id: c.id, name: c.name, input: { ...c.arguments } }),
    );
    const text = m.content !== "" || calls.length === 0 ? [{ type: "text" as const, text: m.content }] : [];
    out.push({ role: "assistant", content: one([...text, ...calls]) });
  }
  flush();
  return out;
}

const usesTools = (request: LLMRequest): boolean =>
  (request.tools?.length ?? 0) > 0 ||
  request.messages.some((m) => m.role === "tool" || (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0));

/** Tools and tool choice for MCP sampling. A choice of one tool becomes that tool alone, required. */
function samplingTools(request: LLMRequest): Record<string, unknown> {
  const tools = (request.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description && { description: t.description }),
    inputSchema: t.inputSchema,
  }));
  const choice = request.toolChoice;
  if (choice === undefined) return tools.length > 0 ? { tools } : {};
  if (typeof choice === "string") return { ...(tools.length > 0 && { tools }), toolChoice: { mode: choice } };
  const only = tools.filter((t) => t.name === choice.name);
  if (only.length === 0)
    throw new TypeError(`toolChoice names "${choice.name}", which is not one of the request's tools`);
  return { tools: only, toolChoice: { mode: "required" } };
}
```

- In `samplingModel`'s `complete`, after the existing sampling-capability check, add:

```ts
if (usesTools(request) && !server.getClientCapabilities()?.sampling?.tools) {
  throw new Error("This flow uses tools, but the MCP client does not support tools in sampling (sampling.tools).");
}
```

    In the `createMessage` params, replace the `messages: messages.filter(...).map(...)` entry with `messages: toSamplingMessages(messages),` and add `...samplingTools(request),` after the `temperature` line. If TypeScript rejects the params type, cast the params object once with `as Parameters<Server["createMessage"]>[0]` and say so in the report.
- Replace the reply handling with:

```ts
      const blocks = (Array.isArray(result.content) ? result.content : [result.content]) as { type: string }[];
      const text = blocks.flatMap((c) => (c.type === "text" ? [(c as { text: string }).text] : [])).join("");
      const toolCalls = blocks.flatMap((c): ToolCall[] => {
        if (c.type !== "tool_use") return [];
        const use = c as ToolUseBlock;
        return [{ id: use.id, name: use.name, arguments: use.input }];
      });
      return {
        content: text,
        model: result.model,
        ...(result.stopReason && { finishReason: result.stopReason }),
        ...(toolCalls.length > 0 && { toolCalls }),
      };
```

- Add to `samplingModel`'s doc comment: ``Tools need a client that declares `sampling.tools` (MCP 2025-11-25); a `toolChoice` of one tool is sent as that tool alone, required.``

* [ ] **Step 6: Docs and checks.**
  - `README.md` Models section: add ``Tool calling works with both models. `samplingModel` needs a client that declares `sampling.tools` (MCP 2025-11-25) and refuses tools otherwise; a `toolChoice` of one tool is sent as that tool alone, required. `openAICompatibleModel` is `taugraph/openai`'s adapter, so it takes all of that adapter's options.`` and the Chinese equivalent in `README.zh-CN.md`: ``两种模型都支持工具调用。`samplingModel` 要求客户端声明 `sampling.tools`（MCP 2025-11-25），否则遇到工具会报错；指定单个工具的 `toolChoice` 会变成只发送这一个工具并要求调用。`openAICompatibleModel` 就是 `taugraph/openai` 的适配器，接受它的全部选项。``
  - `CHANGELOG.md`, under `## [Unreleased]` → `### Added`: ``- Tool calling: `samplingModel` sends tools and tool choice through MCP sampling (clients that declare `sampling.tools`, MCP 2025-11-25), tool calls as `tool_use` blocks and tool results as `tool_result` blocks, and reads `tool_use` replies into `toolCalls`, so `taugraph/agent` runs on MCP sampling. `openAICompatibleModel` now forwards to `taugraph/openai`, with its tools, images and reasoning. Requires taugraph 0.3.0.``

Run: `pnpm format && pnpm check`
Expected: PASS, including the earlier image and reasoning tests of `openAICompatibleModel` (it now runs `taugraph/openai`). If one of those fails only because an error text differs, report it before changing the test.

- [ ] **Step 7: Commit without the dependency change.**

```bash
git checkout package.json pnpm-lock.yaml
git add src/models.ts test/models.test.ts README.md README.zh-CN.md CHANGELOG.md
git commit -m "feat: tool calling in sampling; openAICompatibleModel through taugraph/openai (needs taugraph 0.3.0)"
```

---

### Task 5: Final verification

- [ ] **Step 1:** In `/Users/mi/2026/claw/github/taugraph`: `pnpm check` and `pnpm build`. Expected: PASS, and `dist/openai/index.js` exists.
- [ ] **Step 2:** `pnpm example:quickstart && pnpm example:checkout && pnpm example:rag && pnpm example:agent`. Expected: all run; `example:agent` prints `replay equal: true`.
- [ ] **Step 3:** In both siblings, with the latest local tarball installed: `pnpm check` passes; `git status --short` is empty in all three repos; `git diff main --stat -- package.json pnpm-lock.yaml` is empty in both siblings.
