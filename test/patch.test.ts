import { describe, expect, it } from "vitest";
import { applyPatch, diffJson, jsonLengthAtMost, type PatchOp } from "../src/core/patch.js";
import { freezeJson, jsonEqual } from "../src/core/util.js";

/** An object with an own `__proto__` key after the keys of `rest`, as `JSON.parse` makes it. */
const withProto = (value: unknown, rest: Record<string, unknown> = {}): Record<string, unknown> =>
  JSON.parse(
    `${JSON.stringify(rest).slice(0, -1)}${Object.keys(rest).length ? "," : ""}"__proto__":${JSON.stringify(value)}}`,
  );
const ownProto = (o: object): unknown => Object.getOwnPropertyDescriptor(o, "__proto__")?.value;

/** Seeded pseudo-random numbers in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty", "a", "b", "c/d", "e~f"];
const define = (o: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function randomLeaf(next: () => number): unknown {
  const r = next();
  if (r < 0.2) return null;
  if (r < 0.4) return next() < 0.5;
  if (r < 0.7) return Math.floor(next() * 5) - 1;
  return ["", "x", "toString", '"q"\n'][Math.floor(next() * 4)];
}

function randomJson(next: () => number, depth: number): unknown {
  const r = next();
  if (depth <= 0 || r < 0.35) return randomLeaf(next);
  if (r < 0.65) return Array.from({ length: Math.floor(next() * 4) }, () => randomJson(next, depth - 1));
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (next() < 0.3) define(out, key, next() < 0.05 ? undefined : randomJson(next, depth - 1));
  }
  return out;
}

/** A value close to `value`: some keys removed, added or changed, items appended or dropped. */
function mutate(next: () => number, value: unknown, depth: number): unknown {
  if (next() < 0.15) return randomJson(next, depth);
  if (Array.isArray(value)) {
    const items = value.map((item) => (next() < 0.3 ? mutate(next, item, depth - 1) : item));
    if (next() < 0.4) items.push(randomJson(next, depth - 1));
    if (next() < 0.15) items.pop();
    return items;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const r = next();
      if (r < 0.15) continue;
      define(out, key, r < 0.2 ? undefined : r < 0.5 ? mutate(next, value[key], depth - 1) : value[key]);
    }
    for (const key of KEYS) {
      if (!Object.hasOwn(out, key) && next() < 0.15) define(out, key, randomJson(next, depth - 1));
    }
    return out;
  }
  return next() < 0.5 ? value : randomLeaf(next);
}

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
    [
      "reordered keys",
      { n: { a: 1, b: 2, c: 3 } },
      { n: { b: 2, c: 3, a: 1 } },
      [{ op: "replace", path: "/n", value: { b: 2, c: 3, a: 1 } }],
    ],
  ];

  for (const [name, from, to, ops] of cases) {
    it(`diffs and applies: ${name}`, () => {
      expect(diffJson(from, to)).toEqual(ops);
      expect(applyPatch(from, diffJson(from, to))).toEqual(JSON.parse(JSON.stringify(to)));
      expect(JSON.stringify(applyPatch(from, diffJson(from, to)))).toBe(JSON.stringify(to));
    });
  }

  it("keeps the key order of an earlier array item when items are also appended", () => {
    const from = { m: [{ a: 1, b: 2 }] };
    const to = { m: [{ b: 2, a: 1 }, { c: 3 }] };
    expect(JSON.stringify(applyPatch(from, diffJson(from, to)))).toBe(JSON.stringify(to));
  });

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

  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    it(`removes and adds a key named ${key}`, () => {
      const base = freezeJson({ [key]: 1, a: 1 });
      const removed = diffJson(base, { a: 1 });
      expect(removed).toEqual([{ op: "remove", path: `/${key}` }]);
      const after = applyPatch(base, removed) as object;
      expect(Object.hasOwn(after, key)).toBe(false);
      expect(jsonEqual(after, { a: 1 })).toBe(true);

      const added = diffJson(freezeJson({ a: 1 }), { a: 1, [key]: 2 });
      expect(added).toEqual([{ op: "add", path: `/${key}`, value: 2 }]);
      const result = applyPatch(freezeJson({ a: 1 }), added) as Record<string, unknown>;
      expect(Object.hasOwn(result, key)).toBe(true);
      expect(result[key]).toBe(2);
    });
  }

  for (const [kind, value, other] of [
    ["an object", { x: 1 }, { x: 2, y: [1] }],
    ["an array", [1, 2], [1, 2, 3]],
    ["a string", "s", "t"],
  ] as const) {
    it(`keeps a __proto__ key holding ${kind} as an own key`, () => {
      const pairs: [unknown, unknown][] = [
        [{ a: 1 }, withProto(value, { a: 1 })],
        [withProto(value, { a: 1 }), { a: 1 }],
        [withProto(value, { a: 1 }), withProto(other, { a: 1 })],
        [withProto(value, { a: 1 }), withProto(value, { a: 2 })],
        [{ n: { a: 1 } }, { n: withProto(value, { a: 1 }) }],
        [{ n: withProto(value) }, { n: withProto(other) }],
      ];
      for (const [from, to] of pairs) {
        const base = freezeJson(from);
        const result = applyPatch(base, diffJson(base, to));
        expect(jsonEqual(result, to), `${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toBe(true);
        for (const [got, want] of [
          [result, to],
          [(result as { n?: unknown }).n, (to as { n?: unknown }).n],
        ]) {
          if (!isRecord(want)) continue;
          expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
          expect(Object.hasOwn(got as object, "__proto__")).toBe(Object.hasOwn(want, "__proto__"));
        }
      }
      expect(diffJson({ a: 1 }, withProto(value, { a: 1 }))).toEqual([{ op: "add", path: "/__proto__", value }]);
    });
  }

  it("copies a record with an own __proto__ key as an own property", () => {
    const base = freezeJson(withProto({ admin: true }, { a: 1 }));
    const copy = { ...base };
    expect(Object.hasOwn(copy, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    const next = applyPatch(base, [{ op: "replace", path: "/a", value: 2 }]) as Record<string, unknown>;
    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(ownProto(next)).toBe(ownProto(base));
  });

  it("rejects operations outside the subset", () => {
    const bad = (op: unknown) => () => applyPatch({ a: 1, m: [1] }, [op as PatchOp]);
    expect(bad({ op: "move", from: "/a", path: "/b" })).toThrow(/patch op move is not supported/);
    expect(bad({ op: "test", path: "/a", value: 1 })).toThrow(/patch op test is not supported/);
    expect(bad({ op: "copy", from: "/a", path: "" })).toThrow(/patch op copy is not supported/);
    expect(bad({ op: "add", path: "/m/2", value: 2 })).toThrow(/patch path \/m\/2 does not exist/);
    expect(bad({ op: "add", path: "/m/x", value: 2 })).toThrow(/patch path \/m\/x does not exist/);
    expect(bad({ op: "replace", path: "/b", value: 2 })).toThrow(/patch path \/b does not exist/);
    expect(bad({ op: "remove", path: "/b" })).toThrow(/patch path \/b does not exist/);
    expect(bad({ op: "remove", path: "/constructor" })).toThrow(/patch path \/constructor does not exist/);
    expect(bad({ op: "replace", path: "/toString", value: 1 })).toThrow(/patch path \/toString does not exist/);
    expect(applyPatch({ m: [1] }, [{ op: "add", path: "/m/-", value: 2 }])).toEqual({ m: [1, 2] });
  });

  it("inserts at an array index from 0 to the length", () => {
    const base = freezeJson({ m: [1, 2, 3] });
    const add = (path: string) => applyPatch(base, [{ op: "add", path, value: 9 }]);
    expect(add("/m/0")).toEqual({ m: [9, 1, 2, 3] });
    expect(add("/m/1")).toEqual({ m: [1, 9, 2, 3] });
    expect(add("/m/3")).toEqual({ m: [1, 2, 3, 9] });
    expect(add("/m/-")).toEqual({ m: [1, 2, 3, 9] });
    expect(() => add("/m/4")).toThrow(/patch path \/m\/4 does not exist/);
    expect(() => add("/m/01")).toThrow(/patch path \/m\/01 does not exist/);
    expect(base).toEqual({ m: [1, 2, 3] });
  });

  it("turns 2000 seeded random values into each other", () => {
    const next = seeded(20261123);
    for (let n = 0; n < 2000; n++) {
      const from = freezeJson(randomJson(next, 4));
      const to = next() < 0.8 ? mutate(next, from, 4) : randomJson(next, 4);
      const result = applyPatch(from, diffJson(from, to));
      if (!jsonEqual(result, to)) {
        expect.fail(`pair ${n}: ${JSON.stringify(from)} -> ${JSON.stringify(to)} gave ${JSON.stringify(result)}`);
      }
    }
  });

  it("measures JSON length up to a limit", () => {
    const next = seeded(7);
    for (let n = 0; n < 2000; n++) {
      const value = randomJson(next, 4);
      const length = JSON.stringify(value).length;
      expect(jsonLengthAtMost(value, length)).toBe(length);
      expect(jsonLengthAtMost(value, Number.POSITIVE_INFINITY)).toBe(length);
      const limit = Math.floor(next() * length);
      expect(jsonLengthAtMost(value, limit)).toBeGreaterThan(limit);
    }
    expect(jsonLengthAtMost({ a: "x".repeat(1e6) }, 10)).toBeGreaterThan(10);
  });
});
