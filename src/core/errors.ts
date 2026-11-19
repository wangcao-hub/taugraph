import type { StandardSchemaV1 } from "./standard-schema.js";
import type { Trace } from "./types.js";

export type TaugraphErrorCode =
  /** The graph definition is inconsistent (unknown node, dead end, fan-out, ...). */
  | "INVALID_GRAPH"
  /** Input or a node output failed schema validation, or is not plain JSON. */
  | "INVALID_STATE"
  /** A router threw or returned an unknown / undeclared node id. */
  | "INVALID_ROUTE"
  /** A node threw. The original error is in `cause`. */
  | "NODE_FAILED"
  /** The run executed more than `maxSteps` nodes. */
  | "MAX_STEPS"
  /** The run's AbortSignal fired. */
  | "ABORTED"
  /** `runSync` met a Promise. */
  | "ASYNC_IN_SYNC_RUN"
  /** A trace could not be parsed or is not a taugraph trace. */
  | "INVALID_TRACE"
  /** A node appended an invalid event (reserved type, not JSON, after its step ended). */
  | "INVALID_EVENT";

export interface TaugraphErrorDetails {
  readonly nodeId?: string | undefined;
  readonly step?: number | undefined;
  readonly issues?: readonly StandardSchemaV1.Issue[] | undefined;
  readonly cause?: unknown;
}

export class TaugraphError extends Error {
  override readonly name = "TaugraphError";
  readonly code: TaugraphErrorCode;
  readonly nodeId: string | undefined;
  readonly step: number | undefined;
  readonly issues: readonly StandardSchemaV1.Issue[] | undefined;
  /** The transcript up to the failure. Set when a run fails. */
  trace: Trace | undefined;

  constructor(code: TaugraphErrorCode, message: string, details: TaugraphErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.nodeId = details.nodeId;
    this.step = details.step;
    this.issues = details.issues;
  }
}

export function isTaugraphError(value: unknown): value is TaugraphError {
  return value instanceof TaugraphError;
}

export function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join(".");
      return `  - ${path === "" ? "(root)" : path}: ${issue.message}`;
    })
    .join("\n");
}
