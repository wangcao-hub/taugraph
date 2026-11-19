import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGraph, TaugraphError } from "../src/index.js";

const schema = z.object({ n: z.number() });
const id = (s: { n: number }) => s;

// Static validation is also enforced by the types; casts simulate untyped (JS / YAML) callers.
// biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the types
const build = (def: any) => createGraph(schema, def);

function expectInvalid(def: unknown, message: RegExp) {
  try {
    build(def);
  } catch (error) {
    expect(error).toBeInstanceOf(TaugraphError);
    expect((error as TaugraphError).code).toBe("INVALID_GRAPH");
    expect((error as TaugraphError).message).toMatch(message);
    return;
  }
  throw new Error("expected createGraph to throw");
}

describe("createGraph static validation", () => {
  it("accepts a minimal single-node graph", () => {
    const graph = build({ start: "a", nodes: { a: id }, endNodes: ["a"] });
    expect(graph.nodeIds).toEqual(["a"]);
    expect(graph.start).toBe("a");
  });

  it("rejects a schema that is not Standard Schema", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
      createGraph({} as any, { start: "a", nodes: { a: id }, endNodes: ["a"] } as any),
    ).toThrow(/Standard Schema/);
  });

  it("rejects an empty graph", () => {
    expectInvalid({ start: "a", nodes: {}, endNodes: ["a"] }, /no nodes/);
  });

  it("rejects an unknown start node", () => {
    expectInvalid({ start: "x", nodes: { a: id }, endNodes: ["a"] }, /Start node "x"/);
  });

  it("rejects edges that reference unknown nodes", () => {
    expectInvalid({ start: "a", nodes: { a: id, b: id }, edges: [{ from: "a", to: "c" }], endNodes: ["b"] }, /"c"/);
  });

  it("rejects fan-out (more than one outgoing edge)", () => {
    expectInvalid(
      {
        start: "a",
        nodes: { a: id, b: id, c: id },
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
        ],
        endNodes: ["b", "c"],
      },
      /more than one outgoing edge/,
    );
  });

  it("rejects mixing a plain and a conditional edge on one node", () => {
    expectInvalid(
      {
        start: "a",
        nodes: { a: id, b: id },
        edges: [{ from: "a", to: "b" }],
        conditionalEdges: [{ from: "a", route: () => "b" }],
        endNodes: ["b"],
      },
      /more than one outgoing edge/,
    );
  });

  it("rejects dead ends", () => {
    expectInvalid({ start: "a", nodes: { a: id, b: id }, endNodes: ["b"] }, /"a" has no outgoing edge/);
  });

  it("rejects end nodes with outgoing edges", () => {
    expectInvalid(
      { start: "a", nodes: { a: id, b: id }, edges: [{ from: "a", to: "b" }], endNodes: ["a", "b"] },
      /End node "a" must not have outgoing edges/,
    );
  });

  it("rejects a graph without end nodes", () => {
    expectInvalid({ start: "a", nodes: { a: id }, endNodes: [] }, /at least one end node/);
  });

  it("rejects undeclared conditional targets", () => {
    expectInvalid(
      {
        start: "a",
        nodes: { a: id, b: id },
        conditionalEdges: [{ from: "a", route: () => "b", targets: ["b", "zzz"] }],
        endNodes: ["b"],
      },
      /"zzz"/,
    );
  });
});
