import {
  type CompiledGraph,
  driveAsync,
  driveSync,
  execute,
  type Outgoing,
  type ResumePlan,
  toJson,
} from "./engine.js";
import { TaugraphError } from "./errors.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import { assertTrace, recordedAnswers, recordedSteps, resumePoint } from "./trace.js";
import type { Graph, GraphDefinition, Node, ReplayOptions, ResumeOptions, RunOptions, Trace } from "./types.js";

/**
 * Declares a graph and checks it statically. Throws `INVALID_GRAPH` on any inconsistency,
 * so a graph that builds can only fail at run time because of its nodes or routers.
 *
 * The schema comes first so TypeScript infers the state type from it before checking
 * the nodes; plugin factories such as `CodeNode(...)` then get a typed `state` parameter.
 */
export function createGraph<S, I, K extends string>(
  schema: StandardSchemaV1<I, S>,
  definition: GraphDefinition<S, K>,
): Graph<S, I, K> {
  const graph = compile(schema as StandardSchemaV1<unknown, S>, definition as unknown as GraphDefinition<S, string>);
  const nodeIds = Object.freeze(Object.keys(definition.nodes) as K[]);

  /** Every check that can reject a resume runs here, before anything is appended to the trace. */
  const planResume = (trace: Trace, value: unknown, options: ResumeOptions): ResumePlan => {
    const events = assertTrace(trace);
    const point = resumePoint(events);
    const isReplay = (events[0] as Trace[number]).meta?.replayOf !== undefined;
    const blockWrites = isReplay && options.allowWrites !== true;
    if (value !== undefined && point.kind !== "paused") {
      throw new TaugraphError(
        "NOT_RESUMABLE",
        "The run is not waiting for a value. To continue an interrupted trace, call resume(trace) without a value.",
      );
    }
    if (point.kind === "start") return { trace: events, point, value: undefined, blockWrites };
    const node = graph.nodes[point.nodeId];
    if (!Object.hasOwn(graph.nodes, point.nodeId) || !node) {
      throw new TaugraphError(
        "NOT_RESUMABLE",
        `The trace continues at node "${point.nodeId}", which this graph does not have`,
      );
    }
    if (point.kind === "running" && node.effect === "write" && !options.allowWrites) {
      throw new TaugraphError(
        "UNKNOWN_OUTCOME",
        `Write node "${point.nodeId}" (step ${point.step}) was running when the trace ended, so its effect may or may not have happened. Check the external system, then resume with { allowWrites: true }; the node will see ctx.meta.recovered === true.`,
        { nodeId: point.nodeId, step: point.step },
      );
    }
    const json = value === undefined ? undefined : toJson(value, "Resume value is not plain JSON");
    return { trace: events, point, value: json, blockWrites };
  };

  return Object.freeze({
    start: definition.start,
    nodeIds,
    endNodes: Object.freeze([...definition.endNodes]),

    run(input: I, options: RunOptions = {}) {
      return driveAsync(execute({ graph, input, options }), options.signal) as never;
    },

    runSync(input: I, options: RunOptions = {}) {
      return driveSync(execute({ graph, input, options })) as never;
    },

    async resume(trace: Trace, value?: unknown, options: ResumeOptions = {}) {
      const resume = planResume(trace, value, options);
      return driveAsync(execute({ graph, options, resume }), options.signal) as never;
    },

    resumeSync(trace: Trace, value?: unknown, options: ResumeOptions = {}) {
      const resume = planResume(trace, value, options);
      return driveSync(execute({ graph, options, resume })) as never;
    },

    async replay(trace: Trace, options: ReplayOptions<S, K> = {}) {
      const events = assertTrace(trace);
      const first = events[0] as Trace[number];
      const overrides: Record<string, Node<S> | undefined> = { ...options.overrides };
      for (const [id, node] of Object.entries(overrides)) {
        if (!Object.hasOwn(definition.nodes, id)) {
          throw new TaugraphError("INVALID_GRAPH", `Cannot override unknown node "${id}"`);
        }
        if (node !== undefined && typeof node !== "function") {
          throw new TaugraphError("INVALID_GRAPH", `Override for node "${id}" is not a function`);
        }
      }
      const mode = options.mode ?? "recorded";
      const replay = {
        sourceRunId: first.runId,
        mode,
        overrides,
        recorded: mode === "recorded" ? recordedSteps(events) : new Map(),
        answers: recordedAnswers(events),
        allowWrites: options.allowWrites === true,
      };
      return driveAsync(execute({ graph, input: first.input, options, replay }), options.signal) as never;
    },
  });
}

function compile<S>(schema: StandardSchemaV1<unknown, S>, def: GraphDefinition<S, string>): CompiledGraph<S> {
  const fail = (message: string): never => {
    throw new TaugraphError("INVALID_GRAPH", message);
  };

  if (typeof schema?.["~standard"]?.validate !== "function") {
    fail("`schema` must implement Standard Schema v1 (Zod >= 3.24, Valibot >= 1, ArkType >= 2, ...)");
  }

  const nodes = def.nodes ?? {};
  const ids = Object.keys(nodes);
  if (ids.length === 0) fail("Graph has no nodes");
  for (const id of ids) {
    if (typeof nodes[id] !== "function") fail(`Node "${id}" is not a function`);
  }
  const exists = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(nodes, id);
  const requireNode = (id: unknown, role: string): string => {
    if (!exists(id)) fail(`${role} "${String(id)}" is not a defined node`);
    return id as string;
  };

  const start = requireNode(def.start, "Start node");

  const outgoing = new Map<string, Outgoing<S>>();
  const addOutgoing = (from: unknown, out: Outgoing<S>) => {
    const id = requireNode(from, "Edge source");
    if (outgoing.has(id)) {
      fail(
        `Node "${id}" has more than one outgoing edge. Parallel fan-out is not supported; use one conditional edge to pick the next node.`,
      );
    }
    outgoing.set(id, out);
  };

  for (const edge of def.edges ?? []) {
    addOutgoing(edge.from, { kind: "edge", to: requireNode(edge.to, `Target of edge from "${edge.from}"`) });
  }
  for (const edge of def.conditionalEdges ?? []) {
    if (typeof edge.route !== "function") fail(`Conditional edge from "${edge.from}" has no route function`);
    const targets = edge.targets?.map((t) => requireNode(t, `Declared target of "${edge.from}"`));
    addOutgoing(edge.from, {
      kind: "route",
      route: edge.route,
      ...(targets && { targets: new Set(targets) }),
    });
  }

  if (!def.endNodes || def.endNodes.length === 0) fail("Graph needs at least one end node");
  const endNodes = new Set(def.endNodes.map((id) => requireNode(id, "End node")));
  for (const id of endNodes) {
    if (outgoing.has(id)) fail(`End node "${id}" must not have outgoing edges`);
  }
  for (const id of ids) {
    if (!endNodes.has(id) && !outgoing.has(id)) fail(`Node "${id}" has no outgoing edge and is not an end node`);
  }

  return Object.freeze({ schema, start, nodes, outgoing, endNodes });
}
