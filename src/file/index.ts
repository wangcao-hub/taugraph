// taugraph/file: one append-only JSONL file per run (format v2), written before each step goes on, with a lock per
// run and a repair for the half-written last line a crash leaves. Uses node:fs, so it runs on Node, Bun and Deno;
// the kernel itself stays platform-free.
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
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
  /** The stored trace, without a half-written last line. Never changes the file. */
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

/** The live process holding a lock file, if any. */
function holder(lock: string): number | undefined {
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Lock files this process holds; released if the process exits while a run is still open. */
const held = new Set<string>();
let releaseOnExit = false;

function hold(lock: string): void {
  held.add(lock);
  if (releaseOnExit) return;
  releaseOnExit = true;
  process.once("exit", () => {
    for (const path of held) unlinkQuietly(path);
  });
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, "wx");
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        hold(lock);
        return lock;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        const pid = holder(lock);
        if (pid !== undefined) throw new Error(`Run "${runId}" is being written by process ${pid}`);
        unlinkQuietly(lock); // left by a process that died
      }
    }
    throw new Error(`Run "${runId}" is being written by another process`);
  }

  function release(runId: string, w: Writing): void {
    writing.delete(runId);
    closeSync(w.fd);
    unlinkQuietly(w.lock);
    held.delete(w.lock);
  }

  function open(event: TraceEvent): Writing {
    checkRunId(event.runId);
    mkdirSync(dir, { recursive: true });
    const path = fileOf(event.runId);
    const lock = acquire(event.runId);
    try {
      if (event.seq === 0) {
        if (existsSync(path)) throw new Error(`Run "${event.runId}" already exists in ${dir}`);
        const fd = openSync(path, "a");
        if (durability !== "none") syncDir(dir);
        return { fd, lock, encoder: createTraceEncoder(), next: 0 };
      }
      if (!existsSync(path)) throw new Error(`Run "${event.runId}" has no file in ${dir} to continue`);
      const fd = openSync(path, "a");
      const bytes = readFileSync(path);
      const end = bytes.lastIndexOf(10) + 1; // after the last newline: a torn line after it never took effect
      if (end < bytes.length) ftruncateSync(fd, end);
      const prefix = fromJSONL(new TextDecoder().decode(bytes.subarray(0, end)));
      const last = (prefix[prefix.length - 1] as TraceEvent).seq;
      if (last !== event.seq - 1) {
        closeSync(fd);
        throw new Error(`Run "${event.runId}" on disk ends at seq ${last}, but the next event is seq ${event.seq}`);
      }
      return { fd, lock, encoder: createTraceEncoder(prefix), next: event.seq };
    } catch (error) {
      unlinkQuietly(lock);
      held.delete(lock);
      throw error;
    }
  }

  const sink = (event: TraceEvent): void => {
    let w = writing.get(event.runId);
    if (!w) {
      w = open(event);
      writing.set(event.runId, w);
    }
    if (event.seq !== w.next) throw new Error(`Run "${event.runId}" expected seq ${w.next}, got ${event.seq}`);
    writeSync(w.fd, `${w.encoder.encode(event)}\n`);
    w.next++;
    const critical =
      event.type === "pause" || event.type === "run_end" || (event.type === "enter" && event.meta?.effect === "write");
    if (durability === "every" || (durability === "writes" && critical)) fsyncSync(w.fd);
    if (event.type === "run_end") release(event.runId, w);
  };

  return {
    dir,
    sink,
    load(runId) {
      checkRunId(runId);
      const path = fileOf(runId);
      return existsSync(path) ? fromJSONL(readFileSync(path, "utf8"), { tornTail: "drop" }) : undefined;
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl") && RUN_ID.test(name.slice(0, -".jsonl".length)))
        .flatMap((name): StoredRun[] => {
          const runId = name.slice(0, -".jsonl".length);
          const path = join(dir, name);
          try {
            const trace = fromJSONL(readFileSync(path, "utf8"), { tornTail: "drop" });
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
