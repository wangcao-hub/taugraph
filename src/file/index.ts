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
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
  /**
   * Deletes a run's file; false if there is none. Throws for a run that a live process, or this store, is writing;
   * a lock left by a process that died is taken over first, as for writing.
   */
  remove(runId: string): boolean;
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

/** Lock files (absolute paths) this thread holds; released if the process exits while a run is still open. */
const held = new Set<string>();
let releaseOnExit = false;

/** When this process started, in ms since epoch. Process-wide on Node; on Bun and Deno each thread computes its own. */
const started = Date.now() - process.uptime() * 1000;

/** Slack for the lock's mtime: FAT stores mtimes in 2-second steps. */
const MTIME_STEP = 2000;

/**
 * Age after which a lock without a process id is stale. A lock is empty for a moment while it is created on a file
 * system without hard links, and for good if a power cut came before its content reached the disk.
 */
const NO_PID_STALE = 10_000;

/**
 * Whether the process that wrote a lock is still writing the run. A lock with this process's id that this thread
 * does not hold is live if it was written since this process started (another thread or store of this process),
 * give or take one FAT mtime step; an older one was left by an earlier process that had the same id (e.g. a
 * restarted container).
 */
function isLive(lock: string, pid: number): boolean {
  if (pid !== process.pid) return alive(pid);
  if (held.has(lock)) return true;
  try {
    return statSync(lock).mtimeMs >= started - MTIME_STEP;
  } catch {
    return false; // gone
  }
}

/** Whether a lock with this content keeps its run from being written: a live holder, or no process id for under 10 s. */
function holds(lock: string, content: string): boolean {
  const pid = pidIn(content);
  if (pid !== undefined) return isLive(lock, pid);
  try {
    return statSync(lock).mtimeMs >= Date.now() - NO_PID_STALE;
  } catch {
    return false; // gone
  }
}

/** Whether a lock keeps its run from being written. */
function locked(lock: string): boolean {
  try {
    return holds(lock, readFileSync(lock, "utf8"));
  } catch {
    return false; // no lock
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

/** Removes a lock this thread holds, unless it no longer holds this process's id (another process took it over). */
function releaseLock(lock: string): void {
  if (!held.delete(lock)) return;
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

/** What `linkSync` throws on a file system without hard links (FAT, exFAT, some SMB and FUSE mounts). */
const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"]);

/**
 * Creates the lock with this process's id in one step, so nobody can see it empty. Without hard links it is created
 * and then written, and may be seen empty for a moment: an empty lock is refused until it is 10 s old. False if it
 * exists.
 */
function link(lock: string): boolean {
  const temp = `${lock}.${suffix()}`;
  try {
    writeFileSync(temp, String(process.pid), { flag: "wx" });
    try {
      linkSync(temp, lock);
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      if (!NO_HARD_LINKS.has(codeOf(error) ?? "")) throw error;
    }
  } finally {
    unlinkQuietly(temp);
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  }
}

/**
 * Removes a stale lock that holds `stale`. One process at a time does this, holding `<lock>.takeover`; it removes the
 * lock only if it still holds that content and is still stale, so a lock another process created after it was judged
 * is kept.
 */
function takeOver(runId: string, lock: string, stale: string): void {
  const mutex = `${lock}.takeover`;
  try {
    writeFileSync(mutex, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
    throw new Error(`Run "${runId}" is being taken over by another process (remove ${mutex} if none is)`);
  }
  try {
    if (readIfExists(lock) === stale && !holds(lock, stale)) unlinkSync(lock);
  } finally {
    unlinkQuietly(mutex);
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
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset);
    if (written === 0) throw new Error("write made no progress");
    offset += written;
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
  // Absolute, so every store for this directory, however it is written, agrees on which locks this thread holds.
  const lockOf = (runId: string) => resolve(dir, `${runId}.lock`);

  function acquire(runId: string): string {
    const lock = lockOf(runId);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (link(lock)) {
        hold(lock);
        return lock;
      }
      const content = readIfExists(lock);
      if (content === undefined) continue; // released in the meantime
      if (holds(lock, content)) {
        const pid = pidIn(content);
        if (pid === undefined) {
          throw new Error(
            `Run "${runId}" has a lock file without a process id (${lock}); remove it if no process is writing the run`,
          );
        }
        throw new Error(`Run "${runId}" is being written by process ${pid} (${lock})`);
      }
      takeOver(runId, lock, content);
    }
    throw new Error(`Run "${runId}" is being written by another process`);
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
      } catch {
        // keep the original error
      }
      releaseLock(lock);
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
      try {
        release(event.runId, w);
      } catch {
        // keep the original error
      }
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
              status !== "running" ? status : locked(lockOf(runId)) ? "running" : "interrupted";
            return [{ runId, status: stored, events: trace.length, updatedAt: statSync(path).mtimeMs }];
          } catch {
            return [];
          }
        })
        .sort((a, b) => a.updatedAt - b.updatedAt);
    },
    remove(runId) {
      checkRunId(runId);
      const path = fileOf(runId);
      if (!existsSync(path)) return false;
      const lock = lockOf(runId);
      // A store of this thread is writing the run, even if its lock file was deleted from outside.
      if (held.has(lock)) throw new Error(`Run "${runId}" is being written by process ${process.pid} (${lock})`);
      // Holding the lock keeps a writer from opening the run between the check above and the unlink.
      acquire(runId);
      try {
        unlinkSync(path);
        return true;
      } catch (error) {
        if (codeOf(error) === "ENOENT") return false;
        throw error;
      } finally {
        releaseLock(lock);
      }
    },
  };
}
