# Tool Calling and the Agent Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tool calling in the model contract, and `createAgent`: the model ↔ tools loop as a taugraph graph with one step per model call and one per tool call.

**Architecture:** The contract grows by optional fields in `src/nodes/llm.ts`. A new plugin entry `taugraph/agent` (`src/agent/`) builds a four-node graph (`think`, `act`, `act_write`, `finish`) on the public API only, with a hand-written Standard Schema for its state. The OpenAI-compatible example adapter learns tools.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, Zod in tests only, biome.

Spec: `docs/superpowers/specs/2026-11-24-tool-calling-design.md`.

## Global Constraints

- Zero runtime dependencies; `src/core` untouched; `src/nodes` imports only `../index.js` and `./*.js`; `src/agent` imports only `../index.js`, `../nodes/index.js` and `./*.js`.
- Only optional fields are added to `LLMRequest`/`LLMResponse`; `TRACE_VERSION` unchanged.
- Library text (errors, messages to the model) in English; code comments in English.
- `pnpm check` (typecheck + biome + vitest) must pass; `pnpm format` fixes formatting.

---

### Task 1: Tool calling in the model contract

**Files:** Modify `src/nodes/llm.ts`, `src/nodes/index.ts`; Test `test/nodes.test.ts`, `test/types.test.ts`.

- [ ] **Step 1: Failing tests.** In `test/nodes.test.ts` add:

```ts
it("passes tools to the model and hands its tool calls to update", async () => {
  const calls = [{ id: "c1", name: "weather", arguments: { city: "南京" } }];
  const model: LLMModel = { id: "mock:tools", complete: () => ({ content: "", toolCalls: calls }) };
  let seen: unknown;
  const graph = createGraph(schema, {
    start: "ask",
    nodes: {
      ask: LLMNode({
        model,
        prompt: (s) => ({
          messages: [{ role: "user", content: s.question }],
          tools: [{ name: "weather", inputSchema: { type: "object" } }],
          toolChoice: "auto",
        }),
        update: (s, _text, response) => {
          seen = response.toolCalls;
          return s;
        },
      }),
    },
    endNodes: ["ask"],
  });
  const { trace } = await graph.run({ question: "天气" });
  expect(seen).toEqual(calls);
  expect(trace.find((e) => e.type === "llm_call")?.input).toMatchObject({
    tools: [{ name: "weather" }],
    toolChoice: "auto",
  });
});
```

In `test/types.test.ts` add (import `ChatMessage` from `../src/nodes/index.js`):

```ts
it("tells chat messages apart by role", () => {
  const tool: ChatMessage = { role: "tool", toolCallId: "c1", content: "ok" };
  const assistant: ChatMessage = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "t", arguments: {} }],
  };
  // @ts-expect-error a tool message needs the id of the call it answers
  const broken: ChatMessage = { role: "tool", content: "ok" };
  expectTypeOf([tool, assistant, broken]).toEqualTypeOf<ChatMessage[]>();
});
```

- [ ] **Step 2:** `pnpm typecheck` fails (no `toolCalls`, no `tool` role).
- [ ] **Step 3: Implement** in `src/nodes/llm.ts`, replacing `ChatMessage` and extending the request and response:

```ts
/** A tool the model may call. Field names follow MCP; `inputSchema` is JSON Schema for the arguments object. */
export interface ToolSpec {
  /** Letters, digits, `_` and `-`, at most 64 characters: what every major provider accepts. */
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** A call the model asked for. Arguments are parsed JSON, as in MCP and Anthropic; adapters convert OpenAI's string. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Set by an adapter that could not read the arguments as a JSON object; `arguments` is then `{}`. */
  readonly parseError?: string;
}

/** How the model may use tools: freely, not at all, at least one, or this one. */
export type ToolChoice = "auto" | "none" | "required" | { readonly name: string };

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string; readonly isError?: boolean };
```

`LLMRequest` gains `readonly tools?: readonly ToolSpec[];` and `readonly toolChoice?: ToolChoice;` (doc: "Tools the model may call; adapters translate them to the provider's format."). `LLMResponse` gains `readonly toolCalls?: readonly ToolCall[];` (doc: "Tool calls the model asked for, in order."). Export `ToolCall`, `ToolChoice`, `ToolSpec` from `src/nodes/index.ts`.

- [ ] **Step 4:** `pnpm check` passes. **Step 5: Commit** `feat(nodes): tool calling in the model contract`.

---

### Task 2: Tools in the OpenAI-compatible adapter

**Files:** Modify `examples/adapters/openai-compatible.ts`; Create `test/adapter.test.ts`.

- [ ] **Step 1: Failing test** `test/adapter.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromOpenAIToolCalls, openAICompatible, toOpenAIMessages } from "../examples/adapters/openai-compatible.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible adapter", () => {
  it("sends tools, tool choice, tool calls and tool results in OpenAI's shape", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        model: "m",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "weather", arguments: '{"city":"上海"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    });
    const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
    const response = await model.complete(
      {
        messages: [
          { role: "user", content: "天气" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "weather", arguments: { city: "南京" } }] },
          { role: "tool", toolCallId: "c1", content: "晴" },
        ],
        tools: [{ name: "weather", description: "Weather", inputSchema: { type: "object" } }],
        toolChoice: { name: "weather" },
      },
      { signal: new AbortController().signal },
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object" } } },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "weather" } });
    expect(body.messages).toEqual([
      { role: "user", content: "天气" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"南京"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "晴" },
    ]);
    expect(response).toMatchObject({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c2", name: "weather", arguments: { city: "上海" } }],
    });
  });

  it("marks arguments it cannot read instead of guessing", () => {
    expect(
      fromOpenAIToolCalls([
        { id: "a", function: { name: "t", arguments: "{not json" } },
        { id: "b", function: { name: "t", arguments: "[1]" } },
        { function: { name: "t", arguments: "" } },
      ]),
    ).toEqual([
      { id: "a", name: "t", arguments: {}, parseError: "arguments are not valid JSON" },
      { id: "b", name: "t", arguments: {}, parseError: "arguments are not a JSON object" },
      { id: "call_2", name: "t", arguments: {} },
    ]);
    expect(toOpenAIMessages([{ role: "system", content: "s" }])).toEqual([{ role: "system", content: "s" }]);
  });
});
```

- [ ] **Step 2:** the test fails (no exports). **Step 3: Implement** in the adapter: add types for OpenAI tool calls; export

```ts
/** taugraph messages in OpenAI's wire format. */
export function toOpenAIMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** OpenAI's tool calls as taugraph's, arguments parsed. Unreadable arguments become `{}` with a `parseError`. */
export function fromOpenAIToolCalls(calls: readonly OpenAIToolCall[]): ToolCall[] {
  return calls.flatMap((c, i) => {
    const name = c.function?.name;
    if (!name) return [];
    const raw = c.function?.arguments ?? "";
    let parsed: unknown = {};
    let parseError: string | undefined;
    if (raw.trim() !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseError = "arguments are not valid JSON";
      }
    }
    const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    if (!parseError && !isObject) parseError = "arguments are not a JSON object";
    return [
      {
        id: c.id || `call_${i}`,
        name,
        arguments: isObject && !parseError ? (parsed as Record<string, unknown>) : {},
        ...(parseError && { parseError }),
      },
    ];
  });
}
```

and in `complete`: `messages: toOpenAIMessages(request.messages)`, `...(request.tools?.length && { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, ...(t.description && { description: t.description }), parameters: t.inputSchema } })) })`, `...(request.toolChoice && { tool_choice: typeof request.toolChoice === "string" ? request.toolChoice : { type: "function", function: { name: request.toolChoice.name } } })`; the response gets `...(choice?.message?.tool_calls?.length && { toolCalls: fromOpenAIToolCalls(choice.message.tool_calls) })`. Update the header comment ("~40 line" → "small").

- [ ] **Step 4:** `pnpm check`. **Step 5: Commit** `feat(examples): tool calling in the OpenAI-compatible adapter`.

---

### Task 3: `taugraph/agent`

**Files:** Create `src/agent/index.ts`, `src/agent/state.ts`, `src/agent/util.ts`, `test/agent.test.ts`; Modify `package.json` (`exports`), `test/architecture.test.ts`, `test/types.test.ts`.

- [ ] **Step 1: Failing tests.** Architecture: a third rule `"builds the agent on the public API only"` matching `^(\.\.\/index\.js|\.\.\/nodes\/index\.js|\.\/[\w-]+\.js)$` for `src/agent`. Types (`test/types.test.ts`):

```ts
it("types a tool's arguments from its schema, and the agent's state", () => {
  tool({
    name: "weather",
    input: z.object({ city: z.string() }),
    run: (args) => {
      expectTypeOf(args).toEqualTypeOf<{ city: string }>();
      return "ok";
    },
  });
  const agent = createAgent({ model });
  expectTypeOf(agent.run).returns.resolves.toEqualTypeOf<RunResult<AgentState, AgentNodeId>>();
});
```

`test/agent.test.ts` covers every case in spec §5 (no tool → done; read tool round trip with `tool_call` event; schema from Zod without `$schema`, `inputSchema` wins; invalid arguments / unknown tool / thrown error / `parseError` become error results and the tool does not run; write tool goes through `act_write` with `meta.effect: "write"`, live replay with another model stops with `WRITE_BLOCKED`, passes with `allowWrites`; `approve: "ask"` pauses with `{ type: "tool_approval", call, effect }`, resume `true` runs, `false` refuses, `"deny"` refuses without pausing; `maxRounds` stops with `stop: "max_rounds"` without calling the model; more than 32 calls; a trace cut inside `act_write` resumes with `UNKNOWN_OUTCOME`; `runSync` with a sync model and tools; bad tool names and duplicates throw; the state schema rejects a bad message with a path; input with `pending` skips the model and runs the calls). Mock model:

```ts
function scripted(replies: LLMResponse[]): LLMModel & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    id: "mock:agent",
    requests,
    complete(request) {
      requests.push(request);
      return replies.shift() ?? { content: "done" };
    },
  };
}
```

- [ ] **Step 2:** tests fail (no module). **Step 3: Implement** (see the code committed with this task; it follows spec §3 exactly): `src/agent/util.ts` (`andThen`, `settle` for sync/async results with errors, `issuesText` with paths), `src/agent/state.ts` (`agentStateSchema`, hand-written Standard Schema with defaults and paths), `src/agent/index.ts` (`Tool`, `tool`, `ToolContext`, `ToolResult`, `AgentConfig` incl. `retry?: RetryPolicy` for model calls, `AgentState`, `AgentInput`, `ToolApprovalRequest`, `AGENT_DEFAULTS = { maxRounds: 8, maxCallsPerReply: 32, maxSteps: 1000 }`, `createAgent`). `package.json` `exports` gains `"./agent": { "types": "./dist/agent/index.d.ts", "import": "./dist/agent/index.js" }`.
- [ ] **Step 4:** `pnpm check` and `pnpm build` (check `dist/agent/index.js` exists). **Step 5: Commit** `feat(agent): the model and tools loop as a graph, one step per call`.

---

### Task 4: Example and docs

**Files:** Create `examples/agent.ts`; Modify `package.json` (`example:agent`), `README.md`, `README.zh-CN.md`, `docs/trace-format.md`, `docs/design.md`, `CHANGELOG.md`.

- [ ] **Step 1:** `examples/agent.ts`: a read tool `weather` (fake data) and a write tool `add_todo` that needs approval; with `modelFromEnv()` or a scripted mock; run → paused on `add_todo` → print the request → resume `true` → print the final answer and the path → replay recorded and show `diffTraces` equal. `pnpm example:agent` prints all of it.
- [ ] **Step 2:** Docs per spec §4. **Step 3:** `pnpm check`, `pnpm example:agent`, `pnpm example:quickstart` still work. **Step 4: Commit** `docs: tool calling and the agent`.

---

### Task 5: Sibling packages still work

- [ ] **Step 1:** `pnpm build && pnpm pack` in taugraph. For each of `taugraph-mcp` and `taugraph-pi`: `git worktree add /tmp/<name>-tg HEAD`, `cd` there, `pnpm install --offline` (fall back to `pnpm install`), `pnpm add <path to taugraph-0.3.0 tgz>` in the worktree only, `pnpm check`. Remove the worktrees afterwards. Nothing in the sibling repos' main working trees changes.
- [ ] **Step 2:** Report results; fix taugraph (not the siblings) if they break.
