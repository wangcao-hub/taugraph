export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class NotJsonError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path === "" ? "(root)" : path}: ${reason}`);
  }
}

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
 * (also made by `freezeJson`) that equals the part at the same position, with its keys in the same order:
 * consecutive states share whatever did not change, which keeps traces linear in memory.
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
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new NotJsonError(`${path}[${i}]`, "hole in array");
      const item: unknown = value[i];
      if (item === undefined) throw new NotJsonError(`${path}[${i}]`, "undefined in array");
      items.push(copy(item, `${path}[${i}]`, ancestors, old?.[i]));
    }
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
      const prev = old && Object.hasOwn(old, key) ? old[key] : undefined;
      // defineProperty, not assignment: `out["__proto__"] = x` would set the prototype instead.
      Object.defineProperty(out, key, {
        value: item === undefined ? undefined : copy(item, path === "" ? key : `${path}.${key}`, ancestors, prev),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const keys = Object.keys(out);
    const oldKeys = old ? Object.keys(old) : [];
    // Same keys in the same order: a reordered object is new state, not the old one.
    result =
      old && keys.length === oldKeys.length && keys.every((k, i) => k === oldKeys[i] && out[k] === old[k])
        ? old
        : Object.freeze(out);
  }
  ancestors.delete(value);
  checked.add(result);
  return result;
}

/** Structural equality for JSON values. Object properties set to `undefined` count as absent. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(rb, k) && jsonEqual(ra[k], rb[k]));
}

export function randomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
