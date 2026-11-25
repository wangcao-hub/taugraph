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
      if (a[key] !== undefined && b[key] === undefined) ops.push({ op: "remove", path: `${path}/${escapeKey(key)}` });
    }
    for (const key of Object.keys(b)) {
      if (b[key] === undefined) continue;
      if (a[key] === undefined) ops.push({ op: "add", path: `${path}/${escapeKey(key)}`, value: b[key] });
      else walk(a[key], b[key], `${path}/${escapeKey(key)}`, ops);
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
    doc = setIn(doc, op.path.slice(1).split("/").map(unescapeToken), 0, op);
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
