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

/**
 * Returns a deeply frozen copy of a plain-JSON value.
 *
 * Throws `NotJsonError` for anything that would not survive a JSON round trip
 * (Date, Map, class instances, functions, bigint, NaN, cycles). This is what makes
 * an in-memory trace and a trace loaded from JSONL replay identically.
 * `undefined` object properties are kept (JSON drops them; `jsonEqual` ignores them).
 */
export function freezeJson<T>(value: T): T {
  return copy(value, "", new Set()) as T;
}

function copy(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NotJsonError(path, `non-finite number ${value}`);
    return value;
  }
  if (typeof value !== "object") throw new NotJsonError(path, `${typeof value} is not JSON`);
  if (ancestors.has(value)) throw new NotJsonError(path, "circular reference");

  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item, i) => {
      if (item === undefined) throw new NotJsonError(`${path}[${i}]`, "undefined in array");
      return copy(item, `${path}[${i}]`, ancestors);
    });
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new NotJsonError(path, `${name} is not a plain object (use strings / numbers / arrays / objects)`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = item === undefined ? undefined : copy(item, path === "" ? key : `${path}.${key}`, ancestors);
    }
    result = out;
  }
  ancestors.delete(value);
  return Object.freeze(result);
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
