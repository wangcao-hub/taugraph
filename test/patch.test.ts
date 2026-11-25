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
