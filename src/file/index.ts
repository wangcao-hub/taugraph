// taugraph/file: one append-only JSONL file per run (format v2), written before each step goes on, with a lock per
// run and a repair for the half-written last line a crash leaves. Uses node:fs, so it runs on Node, Bun and Deno;
// the kernel itself stays platform-free.
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createTraceEncoder, fromJSONL, runStatus, type Trace, type TraceEvent } from "../index.js";

/** When to fsync: around write steps, pauses and the end of a run (default), after every event, or never. */
export type Durability = "writes" | "every" | "none";

export interface FileStoreOptions {
  readonly durability?: Durability | undefined;
}

/** `running`: a live process holds the run's lock. `interrupted`: no `run_end` and nobody is writing it. */
export type StoredRunStatus = "running" | "interrupted" | "paused" | "completed" | "failed";

export interface StoredRun {
  readonly runId: string;
  readonly status: StoredRunStatus;
  readonly events: number;
  /** Last change of the file, in ms since epoch. */
  readonly updatedAt: number;
}

export interface FileStore {
  readonly dir: string;
  /** Pass as `onEvent`. Appends each event before the run continues. */
  readonly sink: (event: TraceEvent) => void;
  /** The stored trace without a half-written last line; undefined if there is no complete line. Never writes. */
  load(runId: string): Trace | undefined;
  /** Every run in the directory, oldest change first. Files that cannot be read are skipped. */
  list(): StoredRun[];
}

const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

function checkRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new TypeError(`Invalid runId "${runId.slice(0, 40)}"`);
}

/** Whether a process with this id exists. EPERM means it does, under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/** The process id a lock file holds, if its content is one. */
function pidIn(content: string): number | undefined {
  const text = content.trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
}

/** Lock files this process holds; released if the process exits while a run is still open. */
const held = new Set<string>();
let releaseOnExit = false;

/**
 * Whether the process that wrote a lock is still writing the run. This process's own id counts only for locks it
 * holds: any other lock with that id was left by an earlier process that had the same id (e.g. a restarted container).
 */
function isLive(lock: string, pid: number): boolean {
  return pid === process.pid ? held.has(lock) : alive(pid);
}

/** The live process holding a lock file, if any. */
function holder(lock: string): number | undefined {
  try {
    const pid = pidIn(readFileSync(lock, "utf8"));
    return pid !== undefined && isLive(lock, pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function hold(lock: string): void {
  held.add(lock);
  if (releaseOnExit) return;
  releaseOnExit = true;
  process.once("exit", () => {
    for (const path of [...held]) releaseLock(path);
  });
}

/** Removes a lock this process took, unless it no longer holds this process's id (another process took it over). */
function releaseLock(lock: string): void {
  held.delete(lock);
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {
    // already gone
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** A file's text, or undefined if it does not exist. */
function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

const suffix = () => `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;

/** Creates the lock with this process's id in one step, so nobody can see it empty. False if it already exists. */
function link(lock: string): boolean {
  const temp = `${lock}.${suffix()}`;
  try {
    writeFileSync(temp, String(process.pid), { flag: "wx" });
    try {
      linkSync(temp, lock);
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw error;
    }
    return true;
  } finally {
    unlinkQuietly(temp);
  }
}

/**
 * Removes a stale lock that holds `stale`. It is moved aside first: if another process replaced it after it was
 * judged, the moved file holds that process's lock, which is put back.
 */
function takeOver(lock: string, stale: string): void {
  const moved = `${lock}.stale.${suffix()}`;
  try {
    renameSync(lock, moved);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return; // moved or released by someone else
    throw error;
  }
  try {
    if (readFileSync(moved, "utf8") !== stale) {
      try {
        linkSync(moved, lock);
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
    }
  } finally {
    unlinkQuietly(moved);
  }
}

/** The bytes up to and including the last newline. A line after it was cut short by a crash and never took effect. */
function completeLines(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(0, bytes.lastIndexOf(10) + 1);
}

/** The trace in a file's complete lines, or undefined if there are none. */
function traceOf(complete: Uint8Array): Trace | undefined {
  return complete.length === 0 ? undefined : fromJSONL(new TextDecoder().decode(complete));
}

const utf8 = new TextEncoder();

/** Writes every byte: `writeSync` may write fewer than it was given. */
function writeAll(fd: number, text: string): void {
  const bytes = utf8.encode(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
}

/** Makes a new file's directory entry durable. Not every system can fsync a directory. */
function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // not supported here
  }
}

interface Writing {
  readonly fd: number;
  readonly lock: string;
  readonly encoder: { encode(event: TraceEvent): string };
  next: number;
}

export function fileStore(dir: string, options: FileStoreOptions = {}): FileStore {
  const durability = options.durability ?? "writes";
  const writing = new Map<string, Writing>();
  const fileOf = (runId: string) => join(dir, `${runId}.jsonl`);
  const lockOf = (runId: string) => join(dir, `${runId}.lock`);

  function acquire(runId: string): string {
    const lock = lockOf(runId);
    let seen: number | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (link(lock)) {
        hold(lock);
        return lock;
      }
      const content = readIfExists(lock);
      if (content === undefined) continue; // released in the meantime
      const pid = pidIn(content);
      if (pid === undefined) {
        throw new Error(
          `Run "${runId}" has a lock file without a process id (${lock}); remove it if no process is writing the run`,
        );
      }
      seen = pid;
      if (isLive(lock, pid)) throw new Error(`Run "${runId}" is being written by process ${pid}`);
      takeOver(lock, content);
    }
    throw new Error(`Run "${runId}" is being written by ${seen === undefined ? "another process" : `process ${seen}`}`);
  }

  function release(runId: string, w: Writing): void {
    writing.delete(runId);
    try {
      closeSync(w.fd);
    } finally {
      releaseLock(w.lock);
    }
  }

  /** Opens a new run's file. One with no complete line is what a crash right after creating it leaves: start over. */
  function create(path: string, runId: string): number {
    try {
      return openSync(path, "ax");
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
    if (completeLines(readFileSync(path)).length > 0) throw new Error(`Run "${runId}" already exists in ${dir}`);
    unlinkSync(path);
    return openSync(path, "ax");
  }

  function open(event: TraceEvent): Writing {
    checkRunId(event.runId);
    mkdirSync(dir, { recursive: true });
    const path = fileOf(event.runId);
    const noFile = () => new Error(`Run "${event.runId}" has no file in ${dir} to continue`);
    const lock = acquire(event.runId);
    let fd: number | undefined;
    try {
      if (event.seq === 0) {
        fd = create(path, event.runId);
        if (durability !== "none") syncDir(dir);
        return { fd, lock, encoder: createTraceEncoder(), next: 0 };
      }
      if (!existsSync(path)) throw noFile();
      fd = openSync(path, "a");
      const bytes = readFileSync(path);
      const complete = completeLines(bytes);
      const prefix = traceOf(complete);
      if (!prefix) throw noFile();
      const last = (prefix[prefix.length - 1] as TraceEvent).seq;
      if (last !== event.seq - 1) {
        throw new Error(`Run "${event.runId}" on disk ends at seq ${last}, but the next event is seq ${event.seq}`);
      }
      // Cut the torn tail only after the checks, so a refused continuation leaves the file as it is.
      if (complete.length < bytes.length) ftruncateSync(fd, complete.length);
      return { fd, lock, encoder: createTraceEncoder(prefix), next: event.seq };
    } catch (error) {
      try {
        if (fd !== undefined) closeSync(fd);
      } finally {
        releaseLock(lock);
      }
      throw error;
    }
  }

  const sink = (event: TraceEvent): void => {
    let w = writing.get(event.runId);
    if (!w) {
      w = open(event);
      writing.set(event.runId, w);
    }
    // Not released: the entry may belong to another run with the same id that is still going in this process.
    if (event.seq !== w.next) throw new Error(`Run "${event.runId}" expected seq ${w.next}, got ${event.seq}`);
    try {
      writeAll(w.fd, `${w.encoder.encode(event)}\n`);
      w.next++;
      const critical =
        event.type === "pause" ||
        event.type === "run_end" ||
        (event.type === "enter" && event.meta?.effect === "write");
      if (durability === "every" || (durability === "writes" && critical)) fsyncSync(w.fd);
    } catch (error) {
      // ENOSPC, EIO: the run ends here and the kernel will not send its run_end. Free the run, so a resume opens the
      // file again and cuts what was half written.
      release(event.runId, w);
      throw error;
    }
    if (event.type === "run_end") release(event.runId, w);
  };

  return {
    dir,
    sink,
    load(runId) {
      checkRunId(runId);
      const path = fileOf(runId);
      return existsSync(path) ? traceOf(completeLines(readFileSync(path))) : undefined;
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl") && RUN_ID.test(name.slice(0, -".jsonl".length)))
        .flatMap((name): StoredRun[] => {
          const runId = name.slice(0, -".jsonl".length);
          const path = join(dir, name);
          try {
            const trace = traceOf(completeLines(readFileSync(path)));
            if (!trace) return [];
            const status = runStatus(trace);
            const stored: StoredRunStatus =
              status !== "running" ? status : holder(lockOf(runId)) !== undefined ? "running" : "interrupted";
            return [{ runId, status: stored, events: trace.length, updatedAt: statSync(path).mtimeMs }];
          } catch {
            return [];
          }
        })
        .sort((a, b) => a.updatedAt - b.updatedAt);
    },
  };
}
