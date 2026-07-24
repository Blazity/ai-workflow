import {
  BLOCK_TYPE_SPECS,
  EXECUTION_DIAGNOSTIC_PREFIX,
  isTriggerBlockType,
  type BlockOutput,
  type BlockRunState,
  type WorkflowParamValue,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionV2ControlEdge,
  type WorkflowDefinitionV2Node,
  type WorkflowReplaySelectedTransition,
} from "@shared/contracts";
import type {
  BlockExecutionError,
  BlockExecutionResult,
  WorkflowExecutionErrorState,
} from "./interpreter.js";
import {
  combineV2InvocationCancellations,
  createV2InvocationCancellationController,
  createV2InvocationContext,
  NOOP_V2_INVOCATION_OBSERVATIONS,
  V2InvocationCancelledError,
  type V2InvocationCancellation,
  type V2InvocationContext,
  type V2InvocationObservation,
  type V2InvocationObservationHooks,
} from "./invocation-context.js";
import {
  evaluateV2BranchCondition,
  isV2BranchConfiguration,
} from "./v2-branch.js";
import {
  resolveWorkflowNodeInputsV2,
  type V2BindingResolutionContext,
} from "./v2-bindings.js";
import { validateBlockOutputForDefinition } from "./block-registry.js";

const ROOT_SCOPE_ID = "root";
const DEFAULT_MAX_CONCURRENCY = 4;
const HARD_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_TOTAL_EXECUTIONS = 200;

export type V2EdgeToken = "unresolved" | "active" | "inactive";

export type V2NodeRuntimeStatus =
  | "waiting"
  | "ready"
  | "running"
  | "waiting_loop"
  | "waiting_for_clarification"
  | "completed"
  | "skipped"
  | "cancelled"
  | "failed";

export interface V2NodeRuntimeState {
  status: V2NodeRuntimeStatus;
  attempt?: number;
  readySequence?: number;
}

export interface V2LoopActivation {
  loopNodeId: string;
  ownerScopeId: string;
  iteration: number;
}

export interface V2ActivationScopeState {
  id: string;
  sequence: number;
  parentScopeId: string | null;
  allowedNodeIds: string[];
  edgeTokens: Record<string, V2EdgeToken>;
  nodeStates: Record<string, V2NodeRuntimeState>;
  outputs: Record<string, BlockOutput>;
  loop?: V2LoopActivation;
}

export interface V2ReadyInvocation {
  scopeId: string;
  nodeId: string;
  sequence: number;
}

export interface V2ClarificationState {
  scopeId: string;
  nodeId: string;
  attempt: number;
  kind: "node" | "loop_exhausted";
  questions: string[];
  suggestedAnswers?: string[];
}

export interface V2SchedulerCheckpoint {
  version: 1;
  entryTriggerId: string;
  entryOutput: BlockOutput;
  scopes: Record<string, V2ActivationScopeState>;
  attempts: Record<string, number>;
  executions: number;
  readyQueue: V2ReadyInvocation[];
  pendingClarifications: V2ClarificationState[];
  clarificationAnswers: Record<string, string>;
  nextReadySequence: number;
  nextScopeSequence: number;
  ended: boolean;
}

export interface V2ResolvedControlEdge
  extends WorkflowDefinitionV2ControlEdge {
  port: string;
}

export interface V2LoopRegion {
  loopNodeId: string;
  memberNodeIds: Set<string>;
}

export interface V2RuntimeGraph {
  nodes: Map<string, WorkflowDefinitionV2Node>;
  nodeOrder: Map<string, number>;
  edges: V2ResolvedControlEdge[];
  edgeById: Map<string, V2ResolvedControlEdge>;
  incoming: Map<string, V2ResolvedControlEdge[]>;
  outgoing: Map<string, V2ResolvedControlEdge[]>;
  triggers: WorkflowDefinitionV2Node[];
  loopRegions: Map<string, V2LoopRegion>;
  loopBodyNodeIds: Set<string>;
}

export type V2StepsRecord = Record<string, { output: BlockOutput }>;

export interface V2InvocationIdentity {
  nodeId: string;
  attempt: number;
  activationScopeId: string;
}

export type V2SelectedTransition = WorkflowReplaySelectedTransition;

export type V2InvocationTerminalState =
  | "completed"
  | "waiting_for_clarification"
  | "cancelled"
  | "failed";

export type V2BlockExecutor = (
  node: WorkflowDefinitionV2Node,
  steps: Readonly<V2StepsRecord>,
  resolvedInputs: Readonly<Record<string, unknown>>,
  context: V2InvocationContext,
) => Promise<BlockExecutionResult>;

export interface V2SchedulerHooks {
  onTriggerActivated?(event: V2InvocationIdentity & {
    startedAt: Date;
    completedAt: Date;
    output: BlockOutput;
    selectedTransition: V2SelectedTransition | null;
  }): void | Promise<void>;
  onNodeStart?(
    event: V2InvocationIdentity & { startedAt: Date },
  ): void | Promise<void>;
  onNodeWaiting?(event: V2InvocationIdentity & {
    state: "waiting_loop";
    selectedTransition: V2SelectedTransition;
  }): void | Promise<void>;
  onNodeFinish?(event: V2InvocationIdentity & {
    completedAt: Date;
    state: BlockRunState;
    runtimeState: V2InvocationTerminalState;
    selectedTransition: V2SelectedTransition | null;
  }): void | Promise<void>;
  onNodeSkipped?(
    event: V2InvocationIdentity & {
      startedAt: Date;
      completedAt: Date;
    },
  ): void | Promise<void>;
  onExecutionError?(event: {
    state: WorkflowExecutionErrorState;
    error: BlockExecutionError;
    activationScopeId: string;
  }): void | Promise<void>;
  observationHooksFor?(
    identity: V2InvocationIdentity,
  ): V2InvocationObservationHooks;
}

export interface ExecuteV2GraphOptions {
  runId?: string;
  definition: Pick<WorkflowDefinitionV2, "nodes" | "edges">;
  entryTriggerId: string;
  triggerOutput: BlockOutput;
  runValues?: Readonly<Record<string, unknown>>;
  executeBlock: V2BlockExecutor;
  hooks?: V2SchedulerHooks;
  maxConcurrency?: number;
  maxTotalExecutions?: number;
  cancellation?: V2InvocationCancellation;
  resume?: {
    checkpoint: V2SchedulerCheckpoint;
    clarificationAnswer: string;
  };
  shouldRethrowExecutionError?: (error: unknown) => boolean;
  clock?: () => Date;
}

export interface V2SchedulerResult {
  outcome: "completed" | "paused" | "ended" | "failed";
  steps: V2StepsRecord;
  state: V2SchedulerCheckpoint;
  clarification?: V2ClarificationState;
  executionError?: WorkflowExecutionErrorState;
}

export class V2SchedulerDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2SchedulerDefinitionError";
  }
}

type SettledInvocation =
  | {
      kind: "result";
      key: string;
      scopeId: string;
      nodeId: string;
      attempt: number;
      context: V2InvocationContext;
      result: BlockExecutionResult;
    }
  | {
      kind: "rethrow";
      key: string;
      error: unknown;
    };

interface LoopRegionInternal {
  loopNodeId: string;
  memberNodeIds: Set<string>;
}

function runtimeError(
  detail: string,
  options: {
    category?: BlockExecutionError["category"];
    message?: string;
    phase?: string;
  } = {},
): Extract<BlockExecutionResult, { kind: "execution_error" }> {
  const category = options.category ?? "engine";
  const safeMessages: Record<BlockExecutionError["category"], string> = {
    sandbox: "The workspace environment could not complete this block.",
    provider: "An external service could not complete this block.",
    engine: "The workflow engine could not continue.",
    binding: "A block input could not be resolved.",
    timeout: "The block timed out.",
    parsing: "The block response could not be parsed.",
    schema: "The block returned an invalid result.",
    checks: "The checks could not be started.",
    unknown: "The block could not be completed.",
  };
  return {
    kind: "execution_error",
    error: {
      category,
      message: options.message ?? safeMessages[category],
      detail,
      ...(options.phase ? { phase: options.phase } : {}),
    },
  };
}

function stronglyConnectedComponents(
  nodes: readonly WorkflowDefinitionV2Node[],
  outgoing: Map<string, V2ResolvedControlEdge[]>,
): string[][] {
  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (nodeId: string) => {
    const index = nextIndex;
    nextIndex += 1;
    indexByNode.set(nodeId, index);
    lowLink.set(nodeId, index);
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const edge of outgoing.get(nodeId) ?? []) {
      if (!indexByNode.has(edge.to)) {
        visit(edge.to);
        lowLink.set(
          nodeId,
          Math.min(lowLink.get(nodeId)!, lowLink.get(edge.to)!),
        );
      } else if (onStack.has(edge.to)) {
        lowLink.set(
          nodeId,
          Math.min(lowLink.get(nodeId)!, indexByNode.get(edge.to)!),
        );
      }
    }

    if (lowLink.get(nodeId) !== indexByNode.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    components.push(component);
  };

  for (const node of nodes) {
    if (!indexByNode.has(node.id)) visit(node.id);
  }
  return components;
}

export function buildV2RuntimeGraph(
  definition: Pick<WorkflowDefinitionV2, "nodes" | "edges">,
): V2RuntimeGraph {
  const nodes = new Map<string, WorkflowDefinitionV2Node>();
  const nodeOrder = new Map<string, number>();
  definition.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) {
      throw new V2SchedulerDefinitionError(`duplicate node id "${node.id}"`);
    }
    nodes.set(node.id, node);
    nodeOrder.set(node.id, index);
  });

  const incoming = new Map<string, V2ResolvedControlEdge[]>();
  const outgoing = new Map<string, V2ResolvedControlEdge[]>();
  const edgeById = new Map<string, V2ResolvedControlEdge>();
  const edgeIds = new Set<string>();
  const edges = definition.edges.map((edge) => {
    if (edgeIds.has(edge.id)) {
      throw new V2SchedulerDefinitionError(`duplicate edge id "${edge.id}"`);
    }
    edgeIds.add(edge.id);
    const source = nodes.get(edge.from);
    if (!source || !nodes.has(edge.to)) {
      throw new V2SchedulerDefinitionError(
        `edge "${edge.id}" references a missing node`,
      );
    }
    const port = edge.fromPort ?? BLOCK_TYPE_SPECS[source.type].ports[0];
    if (port === undefined) {
      throw new V2SchedulerDefinitionError(
        `edge "${edge.id}" has no resolvable source port`,
      );
    }
    const resolved: V2ResolvedControlEdge = { ...edge, port };
    edgeById.set(edge.id, resolved);
    const sourceEdges = outgoing.get(edge.from) ?? [];
    sourceEdges.push(resolved);
    outgoing.set(edge.from, sourceEdges);
    const targetEdges = incoming.get(edge.to) ?? [];
    targetEdges.push(resolved);
    incoming.set(edge.to, targetEdges);
    return resolved;
  });

  const loopRegions = new Map<string, V2LoopRegion>();
  const loopBodyNodeIds = new Set<string>();
  for (const component of stronglyConnectedComponents(definition.nodes, outgoing)) {
    const componentSet = new Set(component);
    const cyclic =
      component.length > 1 ||
      (outgoing.get(component[0]!) ?? []).some(
        (edge) => edge.to === component[0],
      );
    if (!cyclic) continue;
    const loops = component.filter((id) => nodes.get(id)?.type === "loop");
    if (loops.length === 0) continue;
    if (loops.length > 1) {
      throw new V2SchedulerDefinitionError(
        `cycle contains multiple Loop blocks: ${loops.join(", ")}`,
      );
    }
    const loopNodeId = loops[0]!;
    loopRegions.set(loopNodeId, {
      loopNodeId,
      memberNodeIds: componentSet,
    });
    for (const member of component) {
      if (member !== loopNodeId) loopBodyNodeIds.add(member);
    }
  }

  return {
    nodes,
    nodeOrder,
    edges,
    edgeById,
    incoming,
    outgoing,
    triggers: definition.nodes.filter((node) => isTriggerBlockType(node.type)),
    loopRegions,
    loopBodyNodeIds,
  };
}

class V2SchedulerRuntime {
  private readonly graph: V2RuntimeGraph;
  private readonly hooks: V2SchedulerHooks;
  private readonly runId: string;
  private readonly maxConcurrency: number;
  private readonly maxTotalExecutions: number;
  private readonly schedulerCancellation =
    createV2InvocationCancellationController();
  private readonly cancellation: V2InvocationCancellation;
  private readonly running = new Map<string, Promise<SettledInvocation>>();
  private readonly pendingHookCalls: Array<() => void | Promise<void>> = [];
  private readonly resolutionQueue: Array<{ scopeId: string; nodeId: string }> = [];
  private hookFlushTail: Promise<void> = Promise.resolve();
  private checkpoint: V2SchedulerCheckpoint;
  private primaryFailure: WorkflowExecutionErrorState | undefined;
  private admissionStopped = false;

  constructor(private readonly options: ExecuteV2GraphOptions) {
    this.graph = buildV2RuntimeGraph(options.definition);
    this.hooks = options.hooks ?? {};
    this.runId = options.runId ?? "test-run";
    this.maxConcurrency = Math.max(
      1,
      Math.min(
        HARD_MAX_CONCURRENCY,
        options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      ),
    );
    this.maxTotalExecutions =
      options.maxTotalExecutions ?? DEFAULT_MAX_TOTAL_EXECUTIONS;
    this.cancellation = options.cancellation
      ? combineV2InvocationCancellations([
          options.cancellation,
          this.schedulerCancellation.view,
        ])
      : this.schedulerCancellation.view;

    if (options.resume) {
      this.checkpoint = structuredClone(options.resume.checkpoint);
      if (
        this.checkpoint.version !== 1 ||
        this.checkpoint.entryTriggerId !== options.entryTriggerId
      ) {
        throw new V2SchedulerDefinitionError(
          "scheduler checkpoint does not match the selected entry trigger",
        );
      }
      if (
        Object.values(this.checkpoint.scopes).some((scope) =>
          Object.values(scope.nodeStates).some(
            (nodeState) => nodeState.status === "running",
          ),
        )
      ) {
        throw new V2SchedulerDefinitionError(
          "scheduler checkpoints cannot contain running invocations",
        );
      }
      this.resumeClarification(options.resume.clarificationAnswer);
    } else {
      this.checkpoint = this.initialCheckpoint();
    }
  }

  private boundaryTime(): Date {
    const value = this.options.clock?.() ?? new Date();
    return new Date(value.getTime());
  }

  async run(): Promise<V2SchedulerResult> {
    await this.flushHookCalls();
    while (true) {
      if (this.primaryFailure) return this.failureResult();
      if (this.cancellation.cancelled) {
        this.schedulerCancellation.cancel(this.cancellation.reason);
        await this.quiesceRunningSiblings(
          "Cancelled because the workflow run was stopped.",
        );
        throw new V2InvocationCancelledError(this.cancellation.reason);
      }

      if (!this.admissionStopped) {
        await this.admitReadyNodes();
      }
      await this.flushHookCalls();
      if (this.primaryFailure) return this.failureResult();

      if (this.running.size === 0) {
        if (this.checkpoint.pendingClarifications.length > 0) {
          return this.result(
            "paused",
            this.sortedClarifications()[0],
          );
        }
        if (this.checkpoint.ended) {
          this.cancelWaitingLoopAttempts(
            "Cancelled because the workflow ended before the loop returned.",
          );
          await this.flushHookCalls();
          return this.result("ended");
        }
        const deadlockedLoop = this.deadlockedLoop();
        if (deadlockedLoop) {
          await this.failNode(
            deadlockedLoop.scopeId,
            deadlockedLoop.nodeId,
            deadlockedLoop.attempt,
            runtimeError(
              `loop "${deadlockedLoop.nodeId}" did not return to its Loop block`,
              { phase: "loop" },
            ).error,
          );
          return this.failureResult();
        }
        if (this.checkpoint.readyQueue.length === 0) {
          return this.result("completed");
        }
        continue;
      }

      const cancellation = this.cancellation.wait().then(
        (): SettledInvocation => ({
          kind: "rethrow",
          key: "",
          error: new Error(this.cancellation.reason ?? "Workflow run cancelled."),
        }),
      );
      const settled = await Promise.race([
        ...this.running.values(),
        cancellation,
      ]);
      if (settled.kind === "rethrow") {
        if (settled.key) this.running.delete(settled.key);
        this.schedulerCancellation.cancel(
          settled.error instanceof Error
            ? settled.error.message
            : "Workflow run cancelled.",
        );
        await this.quiesceRunningSiblings(
          settled.key
            ? "Cancelled because another block could not continue."
            : "Cancelled because the workflow run was stopped.",
        );
        if (!settled.key && this.cancellation.cancelled) {
          throw new V2InvocationCancelledError(this.cancellation.reason);
        }
        throw settled.error;
      }
      this.running.delete(settled.key);
      await this.processResult(settled);
    }
  }

  private initialCheckpoint(): V2SchedulerCheckpoint {
    const entry = this.graph.nodes.get(this.options.entryTriggerId);
    if (!entry || !isTriggerBlockType(entry.type)) {
      throw new V2SchedulerDefinitionError(
        `entry trigger "${this.options.entryTriggerId}" is not present`,
      );
    }
    const allowedNodeIds = [...this.graph.nodes.keys()].filter(
      (nodeId) => !this.graph.loopBodyNodeIds.has(nodeId),
    );
    const root = this.createScope({
      id: ROOT_SCOPE_ID,
      sequence: 0,
      parentScopeId: null,
      allowedNodeIds,
      outputs: { entry: structuredClone(this.options.triggerOutput) },
    });
    const checkpoint: V2SchedulerCheckpoint = {
      version: 1,
      entryTriggerId: this.options.entryTriggerId,
      entryOutput: structuredClone(this.options.triggerOutput),
      scopes: { [ROOT_SCOPE_ID]: root },
      attempts: {},
      executions: 0,
      readyQueue: [],
      pendingClarifications: [],
      clarificationAnswers: {},
      nextReadySequence: 1,
      nextScopeSequence: 1,
      ended: false,
    };
    this.checkpoint = checkpoint;

    for (const edge of this.graph.edges) {
      const sourceLoopRegion = this.loopRegionContaining(edge.from);
      if (
        root.allowedNodeIds.includes(edge.to) &&
        !root.allowedNodeIds.includes(edge.from) &&
        (
          sourceLoopRegion === undefined ||
          sourceLoopRegion.memberNodeIds.has(edge.to)
        )
      ) {
        this.setEdgeToken(root.id, edge.id, "inactive");
      }
    }
    for (const trigger of this.graph.triggers) {
      const active = trigger.id === this.options.entryTriggerId;
      const attempt = this.nextAttempt(trigger.id);
      root.nodeStates[trigger.id] = {
        status: active ? "completed" : "skipped",
        attempt,
      };
      const selectedPort =
        active
          ? BLOCK_TYPE_SPECS[trigger.type].ports[0]
          : undefined;
      this.propagatePort(root.id, trigger.id, selectedPort);
      if (active) {
        const boundaryAt = this.boundaryTime();
        const selectedTransition = this.selectedTransition(
          trigger.id,
          selectedPort,
        );
        this.pendingHookCalls.push(() =>
          this.hooks.onTriggerActivated?.({
            nodeId: trigger.id,
            attempt,
            activationScopeId: root.id,
            startedAt: boundaryAt,
            completedAt: boundaryAt,
            output: structuredClone(this.options.triggerOutput),
            selectedTransition,
          }),
        );
      } else {
        const boundaryAt = this.boundaryTime();
        this.pendingHookCalls.push(() =>
          this.hooks.onNodeSkipped?.({
            nodeId: trigger.id,
            attempt,
            activationScopeId: root.id,
            startedAt: boundaryAt,
            completedAt: boundaryAt,
          }),
        );
      }
    }
    this.drainResolutionQueue();
    return checkpoint;
  }

  private createScope(input: {
    id: string;
    sequence: number;
    parentScopeId: string | null;
    allowedNodeIds: string[];
    outputs?: Record<string, BlockOutput>;
    loop?: V2LoopActivation;
  }): V2ActivationScopeState {
    const allowed = new Set(input.allowedNodeIds);
    const nodeStates: Record<string, V2NodeRuntimeState> = {};
    for (const nodeId of input.allowedNodeIds) {
      nodeStates[nodeId] = { status: "waiting" };
    }
    const edgeTokens: Record<string, V2EdgeToken> = {};
    for (const edge of this.graph.edges) edgeTokens[edge.id] = "unresolved";
    return {
      id: input.id,
      sequence: input.sequence,
      parentScopeId: input.parentScopeId,
      allowedNodeIds: [...allowed],
      edgeTokens,
      nodeStates,
      outputs: input.outputs ?? {},
      ...(input.loop ? { loop: input.loop } : {}),
    };
  }

  private scope(scopeId: string): V2ActivationScopeState {
    const scope = this.checkpoint.scopes[scopeId];
    if (!scope) {
      throw new V2SchedulerDefinitionError(
        `activation scope "${scopeId}" is missing`,
      );
    }
    return scope;
  }

  private isAllowed(scope: V2ActivationScopeState, nodeId: string): boolean {
    return scope.allowedNodeIds.includes(nodeId);
  }

  private setEdgeToken(
    scopeId: string,
    edgeId: string,
    token: Exclude<V2EdgeToken, "unresolved">,
  ): void {
    const scope = this.scope(scopeId);
    const current = scope.edgeTokens[edgeId];
    if (current === token) return;
    if (current !== "unresolved") {
      throw new V2SchedulerDefinitionError(
        `edge "${edgeId}" resolved more than once in scope "${scopeId}"`,
      );
    }
    scope.edgeTokens[edgeId] = token;
    const edge = this.graph.edgeById.get(edgeId);
    if (edge && this.isAllowed(scope, edge.to)) {
      this.resolutionQueue.push({ scopeId, nodeId: edge.to });
    }
  }

  private propagatePort(
    scopeId: string,
    nodeId: string,
    selectedPort: string | undefined,
  ): void {
    for (const edge of this.graph.outgoing.get(nodeId) ?? []) {
      this.setEdgeToken(
        scopeId,
        edge.id,
        edge.port === selectedPort ? "active" : "inactive",
      );
    }
    this.drainResolutionQueue();
  }

  private selectedTransition(
    nodeId: string,
    selectedPort: string | undefined,
    selectedEdgeIds?: ReadonlySet<string>,
  ): V2SelectedTransition | null {
    if (selectedPort === undefined) return null;
    const edgeIds = (this.graph.outgoing.get(nodeId) ?? [])
      .filter(
        (edge) =>
          edge.port === selectedPort &&
          (selectedEdgeIds === undefined || selectedEdgeIds.has(edge.id)),
      )
      .map((edge) => edge.id);
    return { port: selectedPort, edgeIds };
  }

  private drainResolutionQueue(): void {
    while (this.resolutionQueue.length > 0) {
      const next = this.resolutionQueue.shift()!;
      this.resolveNodeIfReady(next.scopeId, next.nodeId);
    }
  }

  private resolveNodeIfReady(scopeId: string, nodeId: string): void {
    const scope = this.scope(scopeId);
    const state = scope.nodeStates[nodeId];
    if (!state || state.status !== "waiting") return;
    const incoming = this.graph.incoming.get(nodeId) ?? [];
    if (incoming.length === 0) return;
    const tokens = incoming.map((edge) => scope.edgeTokens[edge.id]);
    if (tokens.some((token) => token === "unresolved")) return;
    if (tokens.some((token) => token === "active")) {
      const sequence = this.checkpoint.nextReadySequence;
      this.checkpoint.nextReadySequence += 1;
      state.status = "ready";
      state.readySequence = sequence;
      this.checkpoint.readyQueue.push({ scopeId, nodeId, sequence });
      this.sortReadyQueue();
      return;
    }

    const attempt = this.nextAttempt(nodeId);
    const boundaryAt = this.boundaryTime();
    state.status = "skipped";
    state.attempt = attempt;
    this.pendingHookCalls.push(() =>
      this.hooks.onNodeSkipped?.({
        nodeId,
        attempt,
        activationScopeId: scopeId,
        startedAt: boundaryAt,
        completedAt: boundaryAt,
      }),
    );
    if (scope.loop?.loopNodeId === nodeId) {
      return;
    }
    if (
      this.graph.nodes.get(nodeId)?.type === "loop" &&
      scope.loop?.loopNodeId !== nodeId
    ) {
      this.resolveLoopBoundaryEdges(scopeId, nodeId, new Set());
    }
    this.propagatePort(scopeId, nodeId, undefined);
  }

  private loopRegionContaining(nodeId: string): V2LoopRegion | undefined {
    for (const region of this.graph.loopRegions.values()) {
      if (region.memberNodeIds.has(nodeId)) return region;
    }
    return undefined;
  }

  private loopBoundaryEdges(loopNodeId: string): V2ResolvedControlEdge[] {
    const region = this.graph.loopRegions.get(loopNodeId);
    if (!region) return [];
    return this.graph.edges.filter(
      (edge) =>
        region.memberNodeIds.has(edge.from) &&
        !region.memberNodeIds.has(edge.to),
    );
  }

  private resolveLoopBoundaryEdges(
    ownerScopeId: string,
    loopNodeId: string,
    selectedEdgeIds: ReadonlySet<string>,
  ): void {
    for (const edge of this.loopBoundaryEdges(loopNodeId)) {
      this.setEdgeToken(
        ownerScopeId,
        edge.id,
        selectedEdgeIds.has(edge.id) ? "active" : "inactive",
      );
    }
    this.drainResolutionQueue();
  }

  private sortReadyQueue(): void {
    this.checkpoint.readyQueue.sort(
      (left, right) =>
        left.sequence - right.sequence ||
        this.scope(left.scopeId).sequence - this.scope(right.scopeId).sequence ||
        (this.graph.nodeOrder.get(left.nodeId) ?? 0) -
          (this.graph.nodeOrder.get(right.nodeId) ?? 0),
    );
  }

  private async admitReadyNodes(): Promise<void> {
    while (
      !this.admissionStopped &&
      !this.primaryFailure &&
      this.checkpoint.readyQueue.length > 0
    ) {
      const next = this.checkpoint.readyQueue[0]!;
      const state = this.scope(next.scopeId).nodeStates[next.nodeId];
      if (!state || state.status !== "ready") {
        this.checkpoint.readyQueue.shift();
        continue;
      }
      const node = this.graph.nodes.get(next.nodeId)!;
      if (node.type === "branch" || node.type === "loop") {
        this.checkpoint.readyQueue.shift();
        await this.executeControlNode(next.scopeId, node);
        await this.flushHookCalls();
        continue;
      }
      if (this.running.size >= this.maxConcurrency) return;
      this.checkpoint.readyQueue.shift();
      this.launchBlock(next.scopeId, node);
    }
  }

  private startAttempt(scopeId: string, nodeId: string): number {
    const attempt = this.nextAttempt(nodeId);
    this.checkpoint.executions += 1;
    if (this.checkpoint.executions > this.maxTotalExecutions) {
      throw new V2SchedulerDefinitionError(
        `workflow exceeded ${this.maxTotalExecutions} block executions`,
      );
    }
    const startedAt = this.boundaryTime();
    const state = this.scope(scopeId).nodeStates[nodeId];
    if (state) {
      state.status = "running";
      state.attempt = attempt;
      delete state.readySequence;
    }
    this.pendingHookCalls.push(() =>
      this.hooks.onNodeStart?.({
        nodeId,
        attempt,
        activationScopeId: scopeId,
        startedAt,
      }),
    );
    return attempt;
  }

  private nextAttempt(nodeId: string): number {
    const attempt = (this.checkpoint.attempts[nodeId] ?? 0) + 1;
    this.checkpoint.attempts[nodeId] = attempt;
    return attempt;
  }

  private async executeControlNode(
    scopeId: string,
    node: WorkflowDefinitionV2Node,
  ): Promise<void> {
    let attempt: number;
    try {
      attempt = this.startAttempt(scopeId, node.id);
    } catch (error) {
      await this.failNode(
        scopeId,
        node.id,
        this.checkpoint.attempts[node.id] ?? 1,
        runtimeError(error instanceof Error ? error.message : String(error), {
          phase: node.type,
        }).error,
      );
      return;
    }
    await this.flushHookCalls();
    const context = this.invocationContext(scopeId, node.id, attempt);
    context.cancellation.throwIfCancelled();
    await context.observations.emit({
      kind: "input",
      value:
        node.type === "branch"
          ? structuredClone(node.configuration)
          : {
              maxAttempts: node.configuration.maxAttempts,
              onExhaust: node.configuration.onExhaust,
              iteration:
                this.scope(scopeId).loop?.loopNodeId === node.id
                  ? this.scope(scopeId).loop?.iteration
                  : 1,
            },
    });

    if (node.type === "branch") {
      if (!isV2BranchConfiguration(node.configuration)) {
        await this.failNode(
          scopeId,
          node.id,
          attempt,
          runtimeError(`branch "${node.id}" has an invalid condition`, {
            phase: "branch",
          }).error,
        );
        return;
      }
      try {
        const path = evaluateV2BranchCondition(
          node.configuration,
          this.bindingContext(scopeId),
        )
          ? "true"
          : "false";
        const output: BlockOutput = { status: "ok", path };
        await context.observations.emit({ kind: "output", value: output });
        this.completeNode(scopeId, node.id, attempt, output, path);
        await this.finishLoopFromBoundary(scopeId, node.id, path);
        return;
      } catch (error) {
        await this.failNode(
          scopeId,
          node.id,
          attempt,
          runtimeError(error instanceof Error ? error.message : String(error), {
            phase: "branch",
          }).error,
        );
        return;
      }
    }

    try {
      await this.executeLoop(scopeId, node, attempt, context);
    } catch (error) {
      await this.failNode(
        scopeId,
        node.id,
        attempt,
        runtimeError(error instanceof Error ? error.message : String(error), {
          phase: "loop",
        }).error,
      );
    }
  }

  private async executeLoop(
    scopeId: string,
    node: WorkflowDefinitionV2Node,
    attempt: number,
    context: V2InvocationContext,
  ): Promise<void> {
    const scope = this.scope(scopeId);
    const activeLoop = scope.loop;
    if (activeLoop?.loopNodeId === node.id) {
      scope.nodeStates[node.id] = { status: "completed", attempt };
      const output: BlockOutput = {
        status: "ok",
        attempt: activeLoop.iteration,
      };
      await context.observations.emit({ kind: "output", value: output });
      scope.outputs[node.id] = output;
      const continues =
        activeLoop.iteration < this.loopMaxAttempts(node);
      this.finishHook(
        scopeId,
        node.id,
        attempt,
        {
          status: "ok",
          attempt,
          output,
        },
        "completed",
        continues ? "continue" : undefined,
      );
      if (continues) {
        this.spawnLoopIteration(
          activeLoop.ownerScopeId,
          node,
          activeLoop.iteration + 1,
        );
      } else {
        const ownerAttempt =
          this.scope(activeLoop.ownerScopeId).nodeStates[node.id]?.attempt;
        if (ownerAttempt === undefined) {
          throw new V2SchedulerDefinitionError(
            `loop "${node.id}" lost its owner attempt`,
          );
        }
        await this.exhaustLoop(
          activeLoop.ownerScopeId,
          node,
          ownerAttempt,
          this.invocationContext(
            activeLoop.ownerScopeId,
            node.id,
            ownerAttempt,
          ),
        );
      }
      return;
    }

    const region = this.graph.loopRegions.get(node.id);
    if (!region) {
      await this.failNode(
        scopeId,
        node.id,
        attempt,
        runtimeError(`loop "${node.id}" is not part of a valid cycle`, {
          phase: "loop",
        }).error,
      );
      return;
    }
    const output: BlockOutput = { status: "ok", attempt: 1 };
    scope.outputs[node.id] = output;
    scope.nodeStates[node.id] = { status: "waiting_loop", attempt };
    const selectedTransition = this.selectedTransition(node.id, "continue");
    if (!selectedTransition) {
      throw new V2SchedulerDefinitionError(
        `loop "${node.id}" has no continue transition`,
      );
    }
    this.pendingHookCalls.push(() =>
      this.hooks.onNodeWaiting?.({
        nodeId: node.id,
        attempt,
        activationScopeId: scopeId,
        state: "waiting_loop",
        selectedTransition,
      }),
    );
    for (const edge of this.graph.outgoing.get(node.id) ?? []) {
      if (edge.port !== "exhausted") {
        this.setEdgeToken(scopeId, edge.id, "inactive");
      }
    }
    this.spawnLoopIteration(scopeId, node, 1);
  }

  private loopMaxAttempts(node: WorkflowDefinitionV2Node): number {
    const value = node.configuration.maxAttempts;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1
    ) {
      throw new V2SchedulerDefinitionError(
        `loop "${node.id}" has an invalid maxAttempts`,
      );
    }
    return value;
  }

  private spawnLoopIteration(
    ownerScopeId: string,
    node: WorkflowDefinitionV2Node,
    iteration: number,
  ): void {
    const region = this.graph.loopRegions.get(node.id);
    if (!region) {
      throw new V2SchedulerDefinitionError(
        `loop "${node.id}" has no runtime region`,
      );
    }
    const scopeId = `${ownerScopeId}/loop:${node.id}:${iteration}`;
    if (this.checkpoint.scopes[scopeId]) {
      throw new V2SchedulerDefinitionError(
        `loop activation scope "${scopeId}" already exists`,
      );
    }
    const scope = this.createScope({
      id: scopeId,
      sequence: this.checkpoint.nextScopeSequence,
      parentScopeId: ownerScopeId,
      allowedNodeIds: [...region.memberNodeIds],
      outputs: {
        [node.id]: { status: "ok", attempt: iteration },
      },
      loop: {
        loopNodeId: node.id,
        ownerScopeId,
        iteration,
      },
    });
    this.checkpoint.nextScopeSequence += 1;
    this.checkpoint.scopes[scopeId] = scope;

    for (const edge of this.graph.edges) {
      if (
        this.isAllowed(scope, edge.to) &&
        !this.isAllowed(scope, edge.from)
      ) {
        this.setEdgeToken(scopeId, edge.id, "inactive");
      }
    }
    for (const edge of this.graph.outgoing.get(node.id) ?? []) {
      this.setEdgeToken(
        scopeId,
        edge.id,
        edge.port === "continue" ? "active" : "inactive",
      );
    }
    this.drainResolutionQueue();
  }

  private async exhaustLoop(
    ownerScopeId: string,
    node: WorkflowDefinitionV2Node,
    attempt: number,
    context: V2InvocationContext,
  ): Promise<void> {
    const owner = this.scope(ownerScopeId);
    const maxAttempts = this.loopMaxAttempts(node);
    const output: BlockOutput = {
      status: "exhausted",
      attempt: maxAttempts,
    };
    await context.observations.emit({ kind: "output", value: output });
    owner.outputs[node.id] = output;
    const onExhaust = node.configuration.onExhaust;
    const exhaustedEdges = (this.graph.outgoing.get(node.id) ?? []).filter(
      (edge) => edge.port === "exhausted",
    );
    if (onExhaust === "human") {
      owner.nodeStates[node.id] = {
        status: "waiting_for_clarification",
        attempt,
      };
      this.checkpoint.pendingClarifications.push({
        scopeId: ownerScopeId,
        nodeId: node.id,
        attempt,
        kind: "loop_exhausted",
        questions: [
          `Loop "${node.name ?? node.id}" exhausted after ${maxAttempts} attempts. How should we proceed?`,
        ],
      });
      this.finishHook(
        ownerScopeId,
        node.id,
        attempt,
        {
          status: "warn",
          attempt,
          output,
          error: `Loop exhausted after ${maxAttempts} attempts.`,
        },
        "waiting_for_clarification",
      );
      this.admissionStopped = true;
      return;
    }
    if (onExhaust === "fail" && exhaustedEdges.length === 0) {
      await this.failNode(
        ownerScopeId,
        node.id,
        attempt,
        runtimeError(
          `loop "${node.id}" exhausted after ${maxAttempts} attempts`,
          { phase: "loop" },
        ).error,
      );
      return;
    }
    owner.nodeStates[node.id] = { status: "completed", attempt };
    this.finishHook(
      ownerScopeId,
      node.id,
      attempt,
      {
        status: "ok",
        attempt,
        output,
      },
      "completed",
      "exhausted",
      new Set(exhaustedEdges.map((edge) => edge.id)),
    );
    this.resolveLoopBoundaryEdges(
      ownerScopeId,
      node.id,
      new Set(exhaustedEdges.map((edge) => edge.id)),
    );
    this.propagatePort(ownerScopeId, node.id, "exhausted");
  }

  private launchBlock(scopeId: string, node: WorkflowDefinitionV2Node): void {
    let attempt: number;
    try {
      attempt = this.startAttempt(scopeId, node.id);
    } catch (error) {
      void this.failNode(
        scopeId,
        node.id,
        this.checkpoint.attempts[node.id] ?? 1,
        runtimeError(error instanceof Error ? error.message : String(error), {
          phase: node.type,
        }).error,
      );
      return;
    }
    const key = `${scopeId}\0${node.id}`;
    const promise = (async (): Promise<SettledInvocation> => {
      await this.flushHookCalls();
      const clarificationAnswer = this.takeClarificationAnswer(
        scopeId,
        node.id,
      );
      const context = this.invocationContext(
        scopeId,
        node.id,
        attempt,
        clarificationAnswer,
      );
      try {
        context.cancellation.throwIfCancelled();
        const resolvedInputs = resolveWorkflowNodeInputsV2(
          node,
          this.bindingContext(scopeId),
        );
        await context.observations.emit({
          kind: "input",
          value: resolvedInputs,
        });
        const result = await this.options.executeBlock(
          node,
          this.stepsForScope(scopeId),
          Object.freeze(resolvedInputs),
          context,
        );
        return {
          kind: "result",
          key,
          scopeId,
          nodeId: node.id,
          attempt,
          context,
          result,
        };
      } catch (error) {
        if (this.options.shouldRethrowExecutionError?.(error)) {
          return { kind: "rethrow", key, error };
        }
        return {
          kind: "result",
          key,
          scopeId,
          nodeId: node.id,
          attempt,
          context,
          result: runtimeError(
            error instanceof Error ? error.message : String(error),
            {
              category:
                error instanceof Error &&
                error.message.startsWith("binding ")
                  ? "binding"
                  : "unknown",
              phase: node.type,
            },
          ),
        };
      }
    })();
    this.running.set(key, promise);
  }

  private invocationContext(
    scopeId: string,
    nodeId: string,
    attempt: number,
    clarificationAnswer?: string,
  ): V2InvocationContext {
    const identity = {
      nodeId,
      attempt,
      activationScopeId: scopeId,
    };
    const schedulerHooks = this.hooks;
    const observations: V2InvocationObservationHooks = Object.freeze({
      async emit(observation: V2InvocationObservation) {
        try {
          const suppliedObservations =
            schedulerHooks.observationHooksFor?.(identity) ??
            NOOP_V2_INVOCATION_OBSERVATIONS;
          await suppliedObservations.emit(observation);
        } catch {
          // Observation is deliberately best-effort and must not alter a run.
        }
      },
    });
    return createV2InvocationContext({
      ...identity,
      cancellation: this.cancellation,
      observations,
      ...(clarificationAnswer === undefined ? {} : { clarificationAnswer }),
    });
  }

  private async processResult(settled: Extract<SettledInvocation, { kind: "result" }>) {
    if (this.primaryFailure) return;
    const { scopeId, nodeId, attempt, result, context } = settled;
    const node = this.graph.nodes.get(nodeId)!;
    if (result.kind === "execution_error") {
      await this.failNode(scopeId, nodeId, attempt, result.error);
      return;
    }

    await context.observations.emit({ kind: "output", value: result.output });
    const outputIssues = validateBlockOutputForDefinition(
      node.type,
      node.configuration as unknown as Record<string, WorkflowParamValue>,
      result.output,
      {
        requireNormalOutput:
          result.kind === "next" || result.kind === "ended",
      },
    );
    if (outputIssues.length > 0) {
      await this.failNode(
        scopeId,
        nodeId,
        attempt,
        runtimeError(
          `block "${nodeId}" (${node.type}) returned output that violates its contract: ${outputIssues.join("; ")}`,
          { category: "schema", phase: "contract" },
        ).error,
      );
      return;
    }

    if (result.kind === "next") {
      const ports = BLOCK_TYPE_SPECS[node.type].ports;
      const port = result.port ?? ports[0];
      if (port === undefined && ports.length === 0) {
        this.completeNode(scopeId, nodeId, attempt, result.output);
        return;
      }
      if (
        port === undefined ||
        !ports.includes(port)
      ) {
        await this.failNode(
          scopeId,
          nodeId,
          attempt,
          runtimeError(
            `block "${nodeId}" returned an unknown v2 port "${String(port)}"`,
            { phase: "engine" },
          ).error,
        );
        return;
      }
      this.completeNode(scopeId, nodeId, attempt, result.output, port);
      await this.finishLoopFromBoundary(scopeId, nodeId, port);
      return;
    }

    if (result.kind === "needs_human_input") {
      if (this.checkpoint.pendingClarifications.length > 0) {
        await this.failNode(
          scopeId,
          nodeId,
          attempt,
          runtimeError(
            "Multiple blocks requested clarification at the same time.",
            { phase: "clarification" },
          ).error,
        );
        return;
      }
      const scope = this.scope(scopeId);
      scope.outputs[nodeId] = structuredClone(result.output);
      scope.nodeStates[nodeId] = {
        status: "waiting_for_clarification",
        attempt,
      };
      this.checkpoint.pendingClarifications.push({
        scopeId,
        nodeId,
        attempt,
        kind: "node",
        questions: [...result.questions],
        ...(result.suggestedAnswers
          ? { suggestedAnswers: [...result.suggestedAnswers] }
          : {}),
      });
      this.finishHook(
        scopeId,
        nodeId,
        attempt,
        {
          status: "warn",
          attempt,
          output: result.output,
          error: result.questions.join("; "),
        },
        "waiting_for_clarification",
      );
      this.admissionStopped = true;
      return;
    }

    const scope = this.scope(scopeId);
    scope.outputs[nodeId] = structuredClone(result.output);
    scope.nodeStates[nodeId] = { status: "completed", attempt };
    this.finishHook(
      scopeId,
      nodeId,
      attempt,
      {
        status: "warn",
        attempt,
        output: result.output,
      },
      "completed",
    );
    this.checkpoint.ended = true;
    this.admissionStopped = true;
  }

  private completeNode(
    scopeId: string,
    nodeId: string,
    attempt: number,
    output: BlockOutput,
    selectedPort?: string,
  ): void {
    const scope = this.scope(scopeId);
    scope.outputs[nodeId] = structuredClone(output);
    scope.nodeStates[nodeId] = { status: "completed", attempt };
    this.finishHook(
      scopeId,
      nodeId,
      attempt,
      {
        status: "ok",
        attempt,
        output,
      },
      "completed",
      selectedPort,
    );
    if (selectedPort !== undefined) {
      this.propagatePort(scopeId, nodeId, selectedPort);
    }
  }

  private async finishLoopFromBoundary(
    iterationScopeId: string,
    nodeId: string,
    selectedPort: string,
  ): Promise<void> {
    const iterationScope = this.scope(iterationScopeId);
    const activeLoop = iterationScope.loop;
    if (!activeLoop) return;
    const region = this.graph.loopRegions.get(activeLoop.loopNodeId);
    if (!region?.memberNodeIds.has(nodeId)) return;
    const selectedBoundaryEdges = (this.graph.outgoing.get(nodeId) ?? [])
      .filter(
        (edge) =>
          edge.port === selectedPort &&
          !region.memberNodeIds.has(edge.to),
      );
    if (selectedBoundaryEdges.length === 0) return;

    const owner = this.scope(activeLoop.ownerScopeId);
    const ownerState = owner.nodeStates[activeLoop.loopNodeId];
    if (ownerState?.status !== "waiting_loop") return;
    const childLoopState =
      iterationScope.nodeStates[activeLoop.loopNodeId];
    if (
      childLoopState?.status === "waiting" ||
      childLoopState?.status === "ready"
    ) {
      this.checkpoint.readyQueue = this.checkpoint.readyQueue.filter(
        (entry) =>
          entry.scopeId !== iterationScopeId ||
          entry.nodeId !== activeLoop.loopNodeId,
      );
      const skippedAttempt = this.nextAttempt(activeLoop.loopNodeId);
      const boundaryAt = this.boundaryTime();
      iterationScope.nodeStates[activeLoop.loopNodeId] = {
        status: "skipped",
        attempt: skippedAttempt,
      };
      this.pendingHookCalls.push(() =>
        this.hooks.onNodeSkipped?.({
          nodeId: activeLoop.loopNodeId,
          attempt: skippedAttempt,
          activationScopeId: iterationScopeId,
          startedAt: boundaryAt,
          completedAt: boundaryAt,
        }),
      );
    }
    const ownerAttempt = ownerState.attempt;
    if (ownerAttempt === undefined) {
      throw new V2SchedulerDefinitionError(
        `loop "${activeLoop.loopNodeId}" lost its owner attempt`,
      );
    }
    const output: BlockOutput = {
      status: "ok",
      attempt: activeLoop.iteration,
    };
    await this.invocationContext(
      activeLoop.ownerScopeId,
      activeLoop.loopNodeId,
      ownerAttempt,
    ).observations.emit({ kind: "output", value: output });
    owner.outputs[activeLoop.loopNodeId] = output;
    owner.nodeStates[activeLoop.loopNodeId] = {
      status: "completed",
      attempt: ownerAttempt,
    };
    this.finishHook(
      activeLoop.ownerScopeId,
      activeLoop.loopNodeId,
      ownerAttempt,
      {
        status: "ok",
        attempt: ownerAttempt,
        output,
      },
      "completed",
      selectedPort,
      new Set(selectedBoundaryEdges.map((edge) => edge.id)),
    );
    this.resolveLoopBoundaryEdges(
      activeLoop.ownerScopeId,
      activeLoop.loopNodeId,
      new Set(selectedBoundaryEdges.map((edge) => edge.id)),
    );
  }

  private async failNode(
    scopeId: string,
    nodeId: string,
    attempt: number,
    error: BlockExecutionError,
  ): Promise<void> {
    if (this.primaryFailure) return;
    const state: WorkflowExecutionErrorState = {
      category: error.category,
      message: error.message,
      ...(error.phase ? { phase: error.phase } : {}),
      diagnosticId: `${EXECUTION_DIAGNOSTIC_PREFIX}${this.runId}-${nodeId}-${attempt}`,
      nodeId,
      attempt,
    };
    this.primaryFailure = state;
    this.admissionStopped = true;
    this.schedulerCancellation.cancel(`block "${nodeId}" failed`);
    const nodeState = this.scope(scopeId).nodeStates[nodeId];
    if (nodeState) {
      nodeState.status = "failed";
      nodeState.attempt = attempt;
    }
    const completedAt = this.boundaryTime();
    this.pendingHookCalls.push(() =>
      this.hooks.onExecutionError?.({
        state,
        error,
        activationScopeId: scopeId,
      }),
    );
    this.pendingHookCalls.push(() =>
      this.hooks.onNodeFinish?.({
        nodeId,
        attempt,
        activationScopeId: scopeId,
        completedAt,
        runtimeState: "failed",
        selectedTransition: null,
        state: {
          status: "fail",
          attempt,
          error: state.message,
          diagnosticId: state.diagnosticId,
        },
      }),
    );
    await this.flushHookCalls();
  }

  private finishHook(
    scopeId: string,
    nodeId: string,
    attempt: number,
    state: BlockRunState,
    runtimeState: V2InvocationTerminalState,
    selectedPort?: string,
    selectedEdgeIds?: ReadonlySet<string>,
  ): void {
    const completedAt = this.boundaryTime();
    this.pendingHookCalls.push(() =>
      this.hooks.onNodeFinish?.({
        nodeId,
        attempt,
        activationScopeId: scopeId,
        completedAt,
        state,
        runtimeState,
        selectedTransition: this.selectedTransition(
          nodeId,
          selectedPort,
          selectedEdgeIds,
        ),
      }),
    );
  }

  private async flushHookCalls(): Promise<void> {
    const flush = this.hookFlushTail.then(async () => {
      while (this.pendingHookCalls.length > 0) {
        await this.pendingHookCalls.shift()?.();
      }
    });
    this.hookFlushTail = flush.catch(() => {});
    await flush;
  }

  private async failureResult(): Promise<V2SchedulerResult> {
    await this.quiesceRunningSiblings(
      "Cancelled because another block failed.",
    );
    await this.flushHookCalls();
    return this.result("failed");
  }

  private async quiesceRunningSiblings(reason: string): Promise<void> {
    const running = [...this.running.entries()];
    for (const [key] of running) {
      const separator = key.lastIndexOf("\0");
      const scopeId = key.slice(0, separator);
      const nodeId = key.slice(separator + 1);
      const state = this.scope(scopeId).nodeStates[nodeId];
      if (!state || state.status !== "running") continue;
      state.status = "cancelled";
      this.finishHook(
        scopeId,
        nodeId,
        state.attempt ?? 1,
        {
          status: "warn",
          attempt: state.attempt,
          error: reason,
        },
        "cancelled",
      );
    }
    this.cancelWaitingLoopAttempts(reason);

    await this.flushHookCalls();
    await Promise.allSettled(running.map(([, invocation]) => invocation));
    for (const [key] of running) this.running.delete(key);
  }

  private cancelWaitingLoopAttempts(reason: string): void {
    for (const scope of Object.values(this.checkpoint.scopes)) {
      for (const [nodeId, state] of Object.entries(scope.nodeStates)) {
        if (state.status !== "waiting_loop" || state.attempt === undefined) {
          continue;
        }
        state.status = "cancelled";
        this.finishHook(
          scope.id,
          nodeId,
          state.attempt,
          {
            status: "warn",
            attempt: state.attempt,
            error: reason,
          },
          "cancelled",
        );
      }
    }
  }

  private bindingContext(scopeId: string): V2BindingResolutionContext {
    return {
      entryOutput: this.checkpoint.entryOutput,
      runValues: this.options.runValues,
      getStepOutput: (nodeId) => this.stepOutput(scopeId, nodeId),
    };
  }

  private stepOutput(
    scopeId: string,
    nodeId: string,
  ): BlockOutput | undefined {
    let current: V2ActivationScopeState | undefined = this.scope(scopeId);
    while (current) {
      if (Object.prototype.hasOwnProperty.call(current.outputs, nodeId)) {
        return current.outputs[nodeId];
      }
      current = current.parentScopeId
        ? this.checkpoint.scopes[current.parentScopeId]
        : undefined;
    }
    return undefined;
  }

  private stepsForScope(scopeId: string): V2StepsRecord {
    const chain: V2ActivationScopeState[] = [];
    let current: V2ActivationScopeState | undefined = this.scope(scopeId);
    while (current) {
      chain.unshift(current);
      current = current.parentScopeId
        ? this.checkpoint.scopes[current.parentScopeId]
        : undefined;
    }
    const steps: V2StepsRecord = {};
    for (const scope of chain) {
      for (const [nodeId, output] of Object.entries(scope.outputs)) {
        steps[nodeId] = { output: structuredClone(output) };
      }
    }
    return Object.freeze(steps);
  }

  private flattenSteps(): V2StepsRecord {
    const steps: V2StepsRecord = {};
    const scopes = Object.values(this.checkpoint.scopes).sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const scope of scopes) {
      for (const [nodeId, output] of Object.entries(scope.outputs)) {
        if (scope.loop?.loopNodeId === nodeId) continue;
        steps[nodeId] = { output: structuredClone(output) };
      }
    }
    return steps;
  }

  private sortedClarifications(): V2ClarificationState[] {
    this.checkpoint.pendingClarifications.sort(
      (left, right) =>
        this.scope(left.scopeId).sequence - this.scope(right.scopeId).sequence ||
        (this.graph.nodeOrder.get(left.nodeId) ?? 0) -
          (this.graph.nodeOrder.get(right.nodeId) ?? 0),
    );
    return this.checkpoint.pendingClarifications;
  }

  private resumeClarification(answer: string): void {
    const clarification = this.sortedClarifications().shift();
    if (!clarification) {
      throw new V2SchedulerDefinitionError(
        "scheduler checkpoint has no clarification to resume",
      );
    }
    const scope = this.scope(clarification.scopeId);
    if (clarification.kind === "node") {
      const sequence = this.checkpoint.nextReadySequence;
      this.checkpoint.nextReadySequence += 1;
      scope.nodeStates[clarification.nodeId] = {
        status: "ready",
        readySequence: sequence,
      };
      this.checkpoint.readyQueue.push({
        scopeId: clarification.scopeId,
        nodeId: clarification.nodeId,
        sequence,
      });
      this.checkpoint.clarificationAnswers[
        this.invocationKey(clarification.scopeId, clarification.nodeId)
      ] = answer;
      this.sortReadyQueue();
    } else {
      const prior = scope.outputs[clarification.nodeId];
      const output: BlockOutput = {
        ...(prior ?? { status: "exhausted" }),
        answer,
      };
      const resumedAttempt = this.startAttempt(
        clarification.scopeId,
        clarification.nodeId,
      );
      const context = this.invocationContext(
        clarification.scopeId,
        clarification.nodeId,
        resumedAttempt,
        answer,
      );
      this.pendingHookCalls.push(async () => {
        await context.observations.emit({
          kind: "input",
          value: { clarificationAnswer: answer },
        });
        await context.observations.emit({ kind: "output", value: output });
      });
      scope.outputs[clarification.nodeId] = output;
      scope.nodeStates[clarification.nodeId] = {
        status: "completed",
        attempt: resumedAttempt,
      };
      const exhaustedEdgeIds = new Set(
        (this.graph.outgoing.get(clarification.nodeId) ?? [])
          .filter((edge) => edge.port === "exhausted")
          .map((edge) => edge.id),
      );
      this.finishHook(
        clarification.scopeId,
        clarification.nodeId,
        resumedAttempt,
        {
          status: "ok",
          attempt: resumedAttempt,
          output,
        },
        "completed",
        "exhausted",
        exhaustedEdgeIds,
      );
      this.resolveLoopBoundaryEdges(
        clarification.scopeId,
        clarification.nodeId,
        exhaustedEdgeIds,
      );
      this.propagatePort(
        clarification.scopeId,
        clarification.nodeId,
        "exhausted",
      );
    }
    this.admissionStopped = this.checkpoint.ended;
  }

  private invocationKey(scopeId: string, nodeId: string): string {
    return `${scopeId}\0${nodeId}`;
  }

  private takeClarificationAnswer(
    scopeId: string,
    nodeId: string,
  ): string | undefined {
    const key = this.invocationKey(scopeId, nodeId);
    if (
      !Object.prototype.hasOwnProperty.call(
        this.checkpoint.clarificationAnswers,
        key,
      )
    ) {
      return undefined;
    }
    const answer = this.checkpoint.clarificationAnswers[key];
    delete this.checkpoint.clarificationAnswers[key];
    return answer;
  }

  private deadlockedLoop(): {
    scopeId: string;
    nodeId: string;
    attempt: number;
  } | null {
    for (const scope of Object.values(this.checkpoint.scopes)) {
      if (!scope.loop) continue;
      const state = scope.nodeStates[scope.loop.loopNodeId];
      const ownerState =
        this.scope(scope.loop.ownerScopeId).nodeStates[scope.loop.loopNodeId];
      if (
        state &&
        state.status !== "completed" &&
        state.status !== "failed" &&
        ownerState?.status !== "completed"
      ) {
        if (
          ownerState?.status !== "waiting_loop" ||
          ownerState.attempt === undefined
        ) {
          continue;
        }
        return {
          scopeId: scope.loop.ownerScopeId,
          nodeId: scope.loop.loopNodeId,
          attempt: ownerState.attempt,
        };
      }
    }
    return null;
  }

  private result(
    outcome: V2SchedulerResult["outcome"],
    clarification?: V2ClarificationState,
  ): V2SchedulerResult {
    return {
      outcome,
      steps: this.flattenSteps(),
      state: structuredClone(this.checkpoint),
      ...(clarification ? { clarification: structuredClone(clarification) } : {}),
      ...(this.primaryFailure
        ? { executionError: structuredClone(this.primaryFailure) }
        : {}),
    };
  }
}

export async function executeV2Graph(
  options: ExecuteV2GraphOptions,
): Promise<V2SchedulerResult> {
  return new V2SchedulerRuntime(options).run();
}
