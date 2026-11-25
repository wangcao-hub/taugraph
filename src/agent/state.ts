// The agent's state and its schema, written against Standard Schema by hand so the agent needs no validator.
import type { StandardSchemaV1 } from "../index.js";
import type { ChatMessage, ToolCall } from "../nodes/index.js";

export type AgentStop = "done" | "max_rounds";

export interface AgentState {
  /** The conversation without the system prompt, which comes from the config on every call. */
  readonly messages: readonly ChatMessage[];
  /** Calls from the last assistant message that have not run yet, in order. */
  readonly pending: readonly ToolCall[];
  /** Model calls made in this run. */
  readonly rounds: number;
  /** The last answer, once the model stops calling tools. */
  readonly final: string | null;
  readonly stop: AgentStop | null;
}

/** What a run starts from: a conversation, and optionally where an earlier run left off. */
export interface AgentInput {
  readonly messages: readonly ChatMessage[];
  readonly pending?: readonly ToolCall[];
  readonly rounds?: number;
  readonly final?: string | null;
  readonly stop?: AgentStop | null;
}

type Issue = StandardSchemaV1.Issue;
type Path = (string | number)[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkCall(value: unknown, path: Path, issues: Issue[]): void {
  if (!isObject(value)) {
    issues.push({ message: "expected a tool call object", path });
    return;
  }
  if (typeof value.id !== "string") issues.push({ message: "expected a string", path: [...path, "id"] });
  if (typeof value.name !== "string") issues.push({ message: "expected a string", path: [...path, "name"] });
  if (!isObject(value.arguments)) issues.push({ message: "expected an object", path: [...path, "arguments"] });
  if (value.parseError !== undefined && typeof value.parseError !== "string")
    issues.push({ message: "expected a string", path: [...path, "parseError"] });
  if (value.signature !== undefined && typeof value.signature !== "string")
    issues.push({ message: "expected a string", path: [...path, "signature"] });
}

function checkPart(value: unknown, path: Path, issues: Issue[]): void {
  if (!isObject(value)) {
    issues.push({ message: "expected a content part object", path });
    return;
  }
  if (value.type === "text") {
    if (typeof value.text !== "string") issues.push({ message: "expected a string", path: [...path, "text"] });
    return;
  }
  if (value.type !== "image") {
    issues.push({ message: 'expected "text" or "image"', path: [...path, "type"] });
    return;
  }
  if (value.data !== undefined) {
    if (typeof value.data !== "string") issues.push({ message: "expected a string", path: [...path, "data"] });
    if (typeof value.mimeType !== "string") issues.push({ message: "expected a string", path: [...path, "mimeType"] });
    return;
  }
  if (typeof value.url !== "string")
    issues.push({ message: "expected a string (or data and mimeType)", path: [...path, "url"] });
  if (value.mimeType !== undefined && typeof value.mimeType !== "string")
    issues.push({ message: "expected a string", path: [...path, "mimeType"] });
}

/** Checks a message's `content`: a string, or, where `parts` is true, also an array of text and image parts. */
export function checkContent(value: unknown, path: Path, issues: Issue[], parts: boolean): void {
  if (typeof value === "string") return;
  if (!parts || !Array.isArray(value)) {
    issues.push({ message: parts ? "expected a string or an array of content parts" : "expected a string", path });
    return;
  }
  for (const [i, part] of value.entries()) checkPart(part, [...path, i], issues);
}

function checkReasoning(value: unknown, path: Path, issues: Issue[]): void {
  if (!isObject(value)) {
    issues.push({ message: "expected a reasoning part object", path });
    return;
  }
  if (typeof value.text !== "string") issues.push({ message: "expected a string", path: [...path, "text"] });
  if (value.signature !== undefined && typeof value.signature !== "string")
    issues.push({ message: "expected a string", path: [...path, "signature"] });
  if (value.redacted !== undefined && typeof value.redacted !== "boolean")
    issues.push({ message: "expected a boolean", path: [...path, "redacted"] });
}

function checkMessage(value: unknown, path: Path, issues: Issue[]): void {
  if (!isObject(value)) {
    issues.push({ message: "expected a message object", path });
    return;
  }
  const { role } = value;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    issues.push({ message: 'expected "system", "user", "assistant" or "tool"', path: [...path, "role"] });
    return;
  }
  checkContent(value.content, [...path, "content"], issues, role === "user" || role === "tool");
  if (role === "assistant" && value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls)) issues.push({ message: "expected an array", path: [...path, "toolCalls"] });
    else for (const [i, c] of value.toolCalls.entries()) checkCall(c, [...path, "toolCalls", i], issues);
  }
  if (role === "assistant") {
    if (value.model !== undefined && typeof value.model !== "string")
      issues.push({ message: "expected a string", path: [...path, "model"] });
    if (value.reasoning !== undefined) {
      if (!Array.isArray(value.reasoning)) issues.push({ message: "expected an array", path: [...path, "reasoning"] });
      else for (const [i, r] of value.reasoning.entries()) checkReasoning(r, [...path, "reasoning", i], issues);
    }
  }
  if (role === "tool") {
    if (typeof value.toolCallId !== "string")
      issues.push({ message: "expected a string", path: [...path, "toolCallId"] });
    if (value.isError !== undefined && typeof value.isError !== "boolean")
      issues.push({ message: "expected a boolean", path: [...path, "isError"] });
  }
}

/** Validates an agent state, filling in `pending: []`, `rounds: 0`, `final: null` and `stop: null`. */
export const agentStateSchema: StandardSchemaV1<AgentInput, AgentState> = {
  "~standard": {
    version: 1,
    vendor: "taugraph",
    validate(value) {
      if (!isObject(value)) return { issues: [{ message: "expected an object" }] };
      const issues: Issue[] = [];
      const { messages, pending = [], rounds = 0, final = null, stop = null } = value;
      if (!Array.isArray(messages)) issues.push({ message: "expected an array", path: ["messages"] });
      else for (const [i, m] of messages.entries()) checkMessage(m, ["messages", i], issues);
      if (!Array.isArray(pending)) issues.push({ message: "expected an array", path: ["pending"] });
      else for (const [i, c] of pending.entries()) checkCall(c, ["pending", i], issues);
      if (!Number.isInteger(rounds) || (rounds as number) < 0)
        issues.push({ message: "expected a non-negative integer", path: ["rounds"] });
      if (final !== null && typeof final !== "string")
        issues.push({ message: "expected a string or null", path: ["final"] });
      if (stop !== null && stop !== "done" && stop !== "max_rounds")
        issues.push({ message: 'expected "done", "max_rounds" or null', path: ["stop"] });
      if (issues.length > 0) return { issues };
      return { value: { messages, pending, rounds, final, stop } as AgentState };
    },
  },
};
