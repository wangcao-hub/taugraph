// A JSON Patch (RFC 6902) subset for trace format v2: add, remove and replace. Diffs are tuned for
// state that mostly grows, so new object keys and items appended to arrays stay small.
import { jsonEqual } from "./util.js";

export type PatchOp =
  | { readonly op: "add"; readonly path: string; readonly value: unknown }
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string };

const escapeKey = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapeToken = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Own properties only: `o.constructor` or `o.toString` must not count as keys that are there. */
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
/** Sets an own data property. Assigning `o["__proto__"] = x` would set the prototype instead. */
const define = (o: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
};
const OPS: ReadonlySet<unknown> = new Set(["add", "remove", "replace"]);

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
      if (own(a, key) !== undefined && own(b, key) === undefined) {
        ops.push({ op: "remove", path: `${path}/${escapeKey(key)}` });
      }
    }
    for (const key of Object.keys(b)) {
      const next = own(b, key);
      if (next === undefined) continue;
      const prev = own(a, key);
      if (prev === undefined) ops.push({ op: "add", path: `${path}/${escapeKey(key)}`, value: next });
      else walk(prev, next, `${path}/${escapeKey(key)}`, ops);
    }
    return;
  }
  if (!jsonEqual(a, b)) ops.push({ op: "replace", path, value: b });
}

/**
 * Applies `ops` to `base` without changing it. Parts the operations do not touch keep their identity.
 * Only the subset is accepted: `add` to an array must use `-`, and `replace` / `remove` need the key or index to exist.
 */
export function applyPatch(base: unknown, ops: readonly PatchOp[]): unknown {
  let doc = base;
  for (const op of ops) {
    if (!OPS.has(op.op)) throw new Error(`patch op ${String(op.op)} is not supported`);
    if (op.path === "") {
      if (op.op === "remove") throw new Error("patch cannot remove the whole value");
      doc = op.value;
      continue;
    }
    if (!op.path.startsWith("/")) throw new Error(`patch path ${op.path} must start with "/"`);
    doc = setIn(doc, op.path.slice(1).split("/").map(unescapeToken), 0, op);
  }
  return doc;
}

function setIn(node: unknown, tokens: readonly string[], i: number, op: PatchOp): unknown {
  const token = tokens[i] as string;
  const last = i === tokens.length - 1;
  if (Array.isArray(node)) {
    const copy = node.slice();
    if (last && op.op === "add") {
      if (token !== "-") throw new Error(`patch path ${op.path} must end in "-" to add to an array`);
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
    // Spreading keeps an own `__proto__` key as an own data property.
    const copy: Record<string, unknown> = { ...node };
    if (last && op.op === "add") define(copy, token, op.value);
    else if (!Object.hasOwn(copy, token)) throw new Error(`patch path ${op.path} does not exist`);
    else if (!last) define(copy, token, setIn(copy[token], tokens, i + 1, op));
    else if (op.op === "remove") delete copy[token];
    else define(copy, token, op.value);
    return copy;
  }
  throw new Error(`patch path ${op.path} does not exist`);
}

/**
 * `JSON.stringify(value).length` when that is at most `limit`, otherwise some number greater than `limit`.
 * It stops as soon as the count passes `limit`, so a large value costs about `limit` characters of work.
 */
export function jsonLengthAtMost(value: unknown, limit: number): number {
  let length = 0;
  const fits = (v: unknown): boolean => {
    if (typeof v === "string") {
      // Quotes and escapes only add characters, so the escaped form is checked only when the raw one fits.
      length += v.length + 2;
      if (length <= limit) length += JSON.stringify(v).length - v.length - 2;
    } else if (typeof v === "number") {
      length += Number.isFinite(v) ? String(v).length : 4;
    } else if (typeof v === "boolean") {
      length += v ? 4 : 5;
    } else if (Array.isArray(v)) {
      length += Math.max(2, v.length + 1);
      for (let i = 0; i < v.length && length <= limit; i++) fits(v[i] ?? null);
    } else if (isRecord(v)) {
      length += 2;
      let first = true;
      for (const key of Object.keys(v)) {
        if (length > limit) break;
        const item = v[key];
        if (item === undefined) continue;
        length += first ? 1 : 2;
        first = false;
        if (fits(key)) fits(item);
      }
    } else {
      length += 4;
    }
    return length <= limit;
  };
  fits(value);
  return length;
}
