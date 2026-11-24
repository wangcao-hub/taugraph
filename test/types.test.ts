// Compile-time API guarantees. These assertions are checked by `pnpm typecheck`.
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type AgentNodeId, type AgentState, createAgent, tool } from "../src/agent/index.js";
import { createGraph, type MaybePromise, type RunResult } from "../src/index.js";
import { type ChatMessage, CodeNode, type ImagePart, LLMNode, resolveImages, textOf } from "../src/nodes/index.js";

const schema = z.object({
  question: z.string(),
  answer: z.string().nullable().default(null),
});
type State = z.infer<typeof schema>;
const model = { id: "m", complete: () => ({ content: "" }) };

describe("type inference", () => {
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

  it("lets user and tool messages carry images, and keeps system and assistant text", () => {
    const user: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", url: "media:a" },
      ],
    };
    const result: ChatMessage = {
      role: "tool",
      toolCallId: "c1",
      content: [{ type: "image", data: "", mimeType: "image/png" }],
    };
    // @ts-expect-error system messages are text
    const system: ChatMessage = { role: "system", content: [{ type: "text", text: "x" }] };
    // @ts-expect-error assistant messages are text
    const assistant: ChatMessage = { role: "assistant", content: [{ type: "text", text: "x" }] };
    // @ts-expect-error a base64 image needs its type
    const untyped: ImagePart = { type: "image", data: "" };
    expectTypeOf(textOf).returns.toEqualTypeOf<string>();
    expectTypeOf(resolveImages).returns.toEqualTypeOf<MaybePromise<ChatMessage[]>>();
    expectTypeOf([user, result, system, assistant]).toEqualTypeOf<ChatMessage[]>();
    void untyped;
  });

  it("infers state, input and node ids from the schema and nodes", () => {
    const graph = createGraph(schema, {
      start: "plan",
      nodes: {
        plan: CodeNode((s) => {
          expectTypeOf(s).toEqualTypeOf<State>();
          return s;
        }),
        ask: LLMNode({ model, prompt: (s) => s.question, update: (s, text) => ({ ...s, answer: text }) }),
        done: (s) => s,
      },
      edges: [{ from: "plan", to: "ask" }],
      conditionalEdges: [{ from: "ask", route: (s) => (s.answer ? "done" : "plan") }],
      endNodes: ["done"],
    });

    expectTypeOf(graph.run).parameter(0).toEqualTypeOf<z.input<typeof schema>>();
    expectTypeOf(graph.run).returns.resolves.toEqualTypeOf<RunResult<State, "plan" | "ask" | "done">>();
    expectTypeOf(graph.nodeIds).toEqualTypeOf<readonly ("plan" | "ask" | "done")[]>();
  });

  it("infers state from the graph even when callbacks return narrower literals", () => {
    const wide = z.object({ q: z.string(), score: z.number().nullable(), note: z.string().nullable() });
    createGraph(wide, {
      start: "a",
      nodes: {
        a: CodeNode((s) => ({ ...s, score: 1 })),
        b: LLMNode({
          model,
          prompt: (s) => ({ messages: [{ role: "user", content: s.q }] }),
          output: z.object({ score: z.number(), why: z.string() }),
          update: (s, data) => ({ ...s, score: data.score, note: data.why }),
        }),
      },
      edges: [{ from: "a", to: "b" }],
      endNodes: ["b"],
    });
  });

  it("narrows run results by status", () => {
    const graph = createGraph(schema, { start: "a", nodes: { a: (s) => s }, endNodes: ["a"] });
    const check = async () => {
      const result = await graph.run({ question: "q" });
      // @ts-expect-error pending only exists on paused runs
      void result.pending;
      if (result.status === "paused") {
        expectTypeOf(result.pending.nodeId).toEqualTypeOf<"a">();
        expectTypeOf(result.pending.step).toEqualTypeOf<number>();
      }
      expectTypeOf(result.state).toEqualTypeOf<State>();
    };
    expectTypeOf(check).toBeFunction();
  });

  it("types interrupt values and effects", () => {
    createGraph(schema, {
      start: "a",
      nodes: {
        a: CodeNode(
          (s, ctx) => {
            const answer = ctx.interrupt<string>({ question: s.question });
            expectTypeOf(answer).toEqualTypeOf<string>();
            expectTypeOf(ctx.meta.recovered).toEqualTypeOf<boolean>();
            return { ...s, answer };
          },
          { effect: "write" },
        ),
      },
      endNodes: ["a"],
    });
    const invalid = () => {
      // @ts-expect-error effect is "read" | "write"
      CodeNode<State>((s) => s, { effect: "delete" });
    };
    expectTypeOf(invalid).toBeFunction();
  });

  it("rejects unknown node ids and wrong input at compile time", () => {
    const build = () => {
      createGraph(schema, {
        start: "a",
        nodes: { a: (s) => s },
        // @ts-expect-error "b" is not a node
        edges: [{ from: "a", to: "b" }],
        endNodes: ["a"],
      });

      const graph = createGraph(schema, { start: "a", nodes: { a: (s) => s }, endNodes: ["a"] });
      // @ts-expect-error question is required
      void graph.run({});
      // @ts-expect-error nodes must return the full state type
      createGraph(schema, { start: "a", nodes: { a: () => ({ question: 1 }) }, endNodes: ["a"] });
    };
    expectTypeOf(build).toBeFunction();
  });
});
