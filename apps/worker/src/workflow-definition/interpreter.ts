import {
  BLOCK_TYPE_SPECS,
  FAILURE_PORT,
  isTriggerBlockType,
  wirablePorts,
} from "@shared/contracts";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowDefinition,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { evaluateCondition, parseCondition } from "@shared/conditions";

/** Resolved graph shape the walker consumes: node lookup, per-port targets, and triggers. */
export interface RuntimeGraph {
  nodes: Map<string, WorkflowDefinitionNode>;
  outEdges: Map<string, Map<string, string>>;
  triggers: WorkflowDefinitionNode[];
}

/** Build a walk-ready graph, resolving each edge's port to `fromPort` or the source type's first port. */
export function buildRuntimeGraph(
  def: Pick<WorkflowDefinition, "nodes" | "edges">,
): RuntimeGraph {
  const nodes = new Map<string, WorkflowDefinitionNode>();
  for (const node of def.nodes) nodes.set(node.id, node);

  const outEdges = new Map<string, Map<string, string>>();
  for (const edge of def.edges) {
    const source = nodes.get(edge.from);
    if (!source) continue;
    const port = edge.fromPort ?? BLOCK_TYPE_SPECS[source.type].ports[0];
    if (port === undefined) continue;
    let ports = outEdges.get(edge.from);
    if (!ports) {
      ports = new Map<string, string>();
      outEdges.set(edge.from, ports);
    }
    ports.set(port, edge.to);
  }

  const triggers = def.nodes.filter((node) => isTriggerBlockType(node.type));
  return { nodes, outEdges, triggers };
}

/** Accumulated block outputs keyed by node id, readable by later condition evaluation. */
export type StepsRecord = Record<string, { output: BlockOutput }>;

/** Outcome an action block reports back to the engine. */
export type BlockExecutionResult =
  | { kind: "next"; output: BlockOutput; port?: string }
  | { kind: "needs_human_input"; output: BlockOutput; questions: string[] }
  | { kind: "failed"; output: BlockOutput; reason: string; phase?: string }
  | { kind: "ended"; output: BlockOutput };

/** Runs a single action-category block and reports how the walk should proceed. */
export type BlockExecutor = (
  block: WorkflowDefinitionNode,
  steps: StepsRecord,
) => Promise<BlockExecutionResult>;

/** Side-effect callbacks the engine invokes as it walks; all persistence lives here. */
export interface ExecuteGraphHooks {
  onBlockStart(nodeId: string, attempt: number): Promise<void>;
  onBlockFinish(nodeId: string, state: BlockRunState): Promise<void>;
  clarificationExit(questions: string[], nodeId: string): Promise<void>;
  failureExit(phase: string, reason: string, nodeId: string): Promise<void>;
  terminate(
    params: {
      terminalStatus: "waiting_for_human" | "failed" | "skipped" | "done";
      postComment?: string;
    },
    nodeId: string,
  ): Promise<void>;
}

const ERROR_MAX_LENGTH = 500;
const DEFAULT_MAX_TOTAL_EXECUTIONS = 200;

function truncate(text: string): string {
  return text.length > ERROR_MAX_LENGTH ? text.slice(0, ERROR_MAX_LENGTH) : text;
}

function defaultPortOf(node: WorkflowDefinitionNode): string | undefined {
  return BLOCK_TYPE_SPECS[node.type].ports[0];
}

/** Walk the graph from a trigger, driving action blocks through `executeBlock` and control blocks inline. */
export async function executeGraph(opts: {
  graph: RuntimeGraph;
  entryTriggerId: string;
  triggerOutput: BlockOutput;
  executeBlock: BlockExecutor;
  hooks: ExecuteGraphHooks;
  maxTotalExecutions?: number;
}): Promise<{ outcome: "completed" | "stopped" | "ended"; steps: StepsRecord }> {
  const { graph, entryTriggerId, triggerOutput, executeBlock, hooks } = opts;
  const maxTotalExecutions = opts.maxTotalExecutions ?? DEFAULT_MAX_TOTAL_EXECUTIONS;

  const entry = graph.nodes.get(entryTriggerId);
  if (!entry) {
    throw new Error(`entry trigger "${entryTriggerId}" is not present in the graph`);
  }

  const steps: StepsRecord = { [entryTriggerId]: { output: triggerOutput } };
  const attempts = new Map<string, number>();
  let executions = 0;

  const entryPort = defaultPortOf(entry);
  let current =
    entryPort === undefined ? undefined : graph.outEdges.get(entryTriggerId)?.get(entryPort);

  while (current !== undefined) {
    const id = current;

    executions += 1;
    if (executions > maxTotalExecutions) {
      await hooks.failureExit(
        "engine",
        `workflow exceeded the maximum of ${maxTotalExecutions} block executions`,
        id,
      );
      return { outcome: "stopped", steps };
    }

    const node = graph.nodes.get(id);
    if (!node) {
      await hooks.failureExit("engine", `workflow referenced an unknown block "${id}"`, id);
      return { outcome: "stopped", steps };
    }

    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    await hooks.onBlockStart(id, attempt);

    const category = BLOCK_TYPE_SPECS[node.type].category;

    if (category === "control") {
      if (node.type === "branch") {
        const conditionSrc = String(node.params.condition ?? "");
        const parsed = parseCondition(conditionSrc);
        let value: boolean;
        if (parsed.ok) {
          try {
            value = evaluateCondition(parsed.ast, steps);
            // Defensive: evaluateCondition is a total, fully-guarded pure
            // function and does not throw for a parseable condition. Unreachable.
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const output: BlockOutput = { status: "failed", error: message };
            await hooks.onBlockFinish(id, { status: "fail", attempt, error: message, output });
            await hooks.failureExit("branch", message, id);
            return { outcome: "stopped", steps };
          }
        } else {
          const message = parsed.error;
          const output: BlockOutput = { status: "failed", error: message };
          await hooks.onBlockFinish(id, { status: "fail", attempt, error: message, output });
          await hooks.failureExit("branch", message, id);
          return { outcome: "stopped", steps };
        }

        const path = value ? "true" : "false";
        const output: BlockOutput = { status: "ok", path, reason: conditionSrc };
        steps[id] = { output };
        await hooks.onBlockFinish(id, { status: "ok", attempt, output });
        current = graph.outEdges.get(id)?.get(path);
        continue;
      }

      if (node.type === "loop") {
        const maxAttempts = Number(node.params.maxAttempts);
        const onExhaust = String(node.params.onExhaust ?? "");
        const exhaustedTarget = graph.outEdges.get(id)?.get("exhausted");

        if (attempt <= maxAttempts) {
          const output: BlockOutput = { status: "ok", attempt };
          steps[id] = { output };
          await hooks.onBlockFinish(id, { status: "ok", attempt, output });
          current = graph.outEdges.get(id)?.get("continue");
          continue;
        }

        const output: BlockOutput = { status: "exhausted", attempt: maxAttempts };
        steps[id] = { output };

        if (onExhaust === "continue") {
          await hooks.onBlockFinish(id, { status: "ok", attempt, output });
          current = exhaustedTarget;
          continue;
        }

        if (onExhaust === "human") {
          const label = node.name ?? id;
          const message = `Loop "${label}" exhausted after ${maxAttempts} attempts. How should we proceed?`;
          await hooks.onBlockFinish(id, { status: "warn", attempt, error: message, output });
          await hooks.clarificationExit([message], id);
          return { outcome: "stopped", steps };
        }

        if (exhaustedTarget !== undefined) {
          await hooks.onBlockFinish(id, { status: "ok", attempt, output });
          current = exhaustedTarget;
          continue;
        }
        const message = `loop "${id}" exhausted after ${maxAttempts} attempts`;
        await hooks.onBlockFinish(id, { status: "fail", attempt, error: message, output });
        await hooks.failureExit("loop", message, id);
        return { outcome: "stopped", steps };
      }

      if (node.type === "terminate") {
        const terminalStatus = node.params.terminalStatus as
          | "waiting_for_human"
          | "failed"
          | "skipped"
          | "done";
        const postComment =
          typeof node.params.postComment === "string" ? node.params.postComment : undefined;
        const output: BlockOutput = { status: terminalStatus };
        steps[id] = { output };
        const finishStatus =
          terminalStatus === "failed" ? "fail" : terminalStatus === "waiting_for_human" ? "warn" : "ok";
        await hooks.onBlockFinish(id, { status: finishStatus, attempt, output });
        await hooks.terminate({ terminalStatus, postComment }, id);
        return { outcome: "stopped", steps };
      }
    }

    const result = await executeBlock(node, steps);

    if (result.kind === "next") {
      const output = result.output;
      steps[id] = { output };
      await hooks.onBlockFinish(id, { status: "ok", attempt, output });
      const port = result.port ?? defaultPortOf(node);
      if (port === undefined || !wirablePorts(node.type).includes(port)) {
        await hooks.failureExit(
          "engine",
          `block "${id}" returned an unknown port "${String(port)}"`,
          id,
        );
        return { outcome: "stopped", steps };
      }
      current = graph.outEdges.get(id)?.get(port);
      continue;
    }

    if (result.kind === "needs_human_input") {
      const output = result.output;
      steps[id] = { output };
      const error = truncate(result.questions.join("; "));
      await hooks.onBlockFinish(id, { status: "warn", attempt, output, error });
      await hooks.clarificationExit(result.questions, id);
      return { outcome: "stopped", steps };
    }

    if (result.kind === "failed") {
      const output = result.output;
      steps[id] = { output };
      await hooks.onBlockFinish(id, {
        status: "fail",
        attempt,
        output,
        error: truncate(result.reason),
      });
      const failureTarget = graph.outEdges.get(id)?.get(FAILURE_PORT);
      if (failureTarget !== undefined) {
        current = failureTarget;
        continue;
      }
      await hooks.failureExit(result.phase ?? node.type, truncate(result.reason), id);
      return { outcome: "stopped", steps };
    }

    // result.kind === "ended": a block (e.g. send_plan_approval) parked the run
    // cleanly while it awaits a human. Distinct from "stopped" so agent.ts can
    // record it as a success instead of the default failed outcome.
    const output = result.output;
    steps[id] = { output };
    await hooks.onBlockFinish(id, { status: "warn", attempt, output });
    return { outcome: "ended", steps };
  }

  return { outcome: "completed", steps };
}
