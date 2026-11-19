// Compile-time API guarantees. These assertions are checked by `pnpm typecheck`.
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createGraph, type RunResult } from "../src/index.js";
import { CodeNode, LLMNode } from "../src/nodes/index.js";

const schema = z.object({
  question: z.string(),
  answer: z.string().nullable().default(null),
});
type State = z.infer<typeof schema>;
const model = { id: "m", complete: () => ({ content: "" }) };

describe("type inference", () => {
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
