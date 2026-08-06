import { readFileSync } from "node:fs";
import type {
  BlockOutput,
  TransformConfiguration,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowParamValue,
} from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import {
  triggerOutputWithTicketContext,
  triggerTypeFor,
  v2TerminalBlockResult,
  type TerminalStatus,
} from "../../workflows/agent.js";
import { isRunControlError } from "../../workflows/run-control-error.js";
import {
  validateBlockOutputForDefinition,
  type WorkflowBlockRegistryContext,
} from "../block-registry.js";
import { executionError, type BlockExecutionResult } from "../interpreter.js";
import type { V2InvocationContext } from "../invocation-context.js";
import {
  describeWorkflowDefinitionIssues,
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionSchema,
} from "../schema.js";
import { workflowDefinitionTemplate } from "../templates.js";
import { executeTransform } from "../transform.js";
import type { V2BindingResolutionContext } from "../v2-bindings.js";
import {
  executeV2Graph,
  isSchedulerOwnedBlockType,
  V2_PRODUCTION_SCHEDULER_BOUNDS,
  type V2InvocationIdentity,
  type V2InvocationTerminalState,
  type V2SchedulerHooks,
  type V2SchedulerResult,
  type V2SelectedTransition,
  type V2StepsRecord,
} from "../v2-scheduler.js";

/**
 * Turns a workflow definition into an executable specification. The scenario
 * drives the production v2 scheduler over a graph it did not author, so edges,
 * bindings, Branch evaluation, fan-out/fan-in, Loop scopes and attempt counters
 * are the real ones. Only action blocks are scripted, and only through this
 * file, so a scenario can never reimplement control flow that the product owns.
 *
 * A graph comes from exactly one of two places: a template shipped by
 * `templates.ts`, or a committed JSON snapshot of a deployed definition, parsed
 * through the production schema. Both are artifacts a human published, so a
 * scenario that drifts from them fails instead of proving nothing. An inline
 * `nodes`/`edges` object is not accepted at all.
 *
 * Strictness is the point: an unexpected invocation, an unused script or a
 * scripted output that violates a block contract fails the scenario. A
 * permissive `{ status: "ok" }` fallback would let a template silently grow a
 * block that no scenario ever asserted.
 *
 * The quiescence watchdog below measures EVENT-LOOP QUIESCENCE, NOT ELAPSED
 * TIME. It counts consecutive macrotask turns in which no gated block arrived,
 * and it never gates a pass: its only job is to turn a barrier the graph can
 * never satisfy into a legible failure instead of a hung suite.
 */

/** Macrotask turns without a new arrival before a held barrier is declared
 * unsatisfiable. Not a duration: the harness performs no I/O, so a graph that
 * can satisfy the barrier does so within a couple of turns. Exported so a test
 * can prove a release came from cancellation rather than from this fallback. */
export const QUIESCENCE_TURNS = 50;

/** Blocks that reach a block executor but whose behaviour lives in the
 * production dispatcher rather than in an agent call. The harness replays the
 * production helper for them, so a scenario cannot script them either. */
const PRODUCTION_OWNED_BLOCK_TYPES = new Set(["terminate", "transform"]);

const TERMINAL_STATUSES: readonly TerminalStatus[] = [
  "waiting_for_human",
  "failed",
  "skipped",
  "done",
];

/** Snapshots live in one committed directory so a scenario cannot reach for an
 * arbitrary file and call the result a deployed definition. */
const SNAPSHOT_DIRECTORY = new URL("./snapshots/", import.meta.url);

/** Deployment validation needs to know what the installation offers. A snapshot
 * is checked for structural soundness, not for what this machine happens to
 * have configured, so every provider is declared present and the environment
 * availability pass is switched off. That keeps the harness credential-free. */
const SNAPSHOT_REGISTRY_CONTEXT: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-scenario" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

type TemplateOptions = Parameters<typeof workflowDefinitionTemplate>[1];
type TicketContext = Parameters<typeof triggerOutputWithTicketContext>[1];

/** Which invocations a script claims. Omitted fields match any value. */
export interface ScenarioScriptMatch {
  nodeId: string;
  /** 1-based scheduler attempt; a Loop re-invokes the same node. */
  attempt?: number;
  /** Activation containing the invocation, for fan-out and Loop scopes. */
  activationScopeId?: string;
}

export type ScenarioResultFactory = (
  node: WorkflowDefinitionV2Node,
  resolvedInputs: Readonly<Record<string, unknown>>,
  context: V2InvocationContext,
) => BlockExecutionResult | Promise<BlockExecutionResult>;

/**
 * One invocation as the scheduler saw it.
 *
 * Sequence numbers come from the scheduler's hook queue because the executor
 * cannot supply them. A finish is fundamentally unobservable from inside the
 * executor: the executor returns before `processResult` runs, and
 * `processResult` may drop the result entirely once a sibling has failed. Half
 * the records here never enter the executor at all (an activated trigger, a
 * skipped trigger, a Branch, a Loop, an invocation cancelled during
 * quiescence), so the hook queue is the only channel that orders all of them
 * against each other.
 */
export interface ScenarioInvocation {
  nodeId: string;
  nodeType: string;
  attempt: number;
  activationScopeId: string;
  startSeq?: number;
  finishSeq?: number;
  runtimeState?: V2InvocationTerminalState;
  /** The only channel that reports a control node's selected port: Branch and
   * Loop never reach a block executor. */
  selectedTransition?: V2SelectedTransition | null;
  /** Whether this invocation reached a block executor. False for triggers,
   * control nodes and anything the scheduler resolved on its own, which is why
   * "did this block run?" cannot be answered by record count alone. */
  enteredExecutor: boolean;
  /** True for a trigger the run did not fire. */
  skipped?: boolean;
  resolvedInputs?: Record<string, unknown>;
  result?: BlockExecutionResult;
}

export interface ScenarioOutcome {
  result: V2SchedulerResult;
  invocations: ScenarioInvocation[];
  invocationsOf(nodeId: string): ScenarioInvocation[];
}

/** Thrown when the scenario itself is wrong: an unscripted block ran, a script
 * went unused, a scenario tried to script behaviour the product owns, or a
 * barrier described concurrency the graph cannot produce. */
export class ScenarioViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioViolation";
  }
}

/** The two graph sources, expressed so the compiler rejects both-or-neither
 * before the runtime check has to. */
type ScenarioGraphSource =
  | { template: { id: string; options: TemplateOptions }; snapshot?: never }
  | { snapshot: { path: string }; template?: never };

export type CreateScenarioOptions = ScenarioGraphSource & {
  entry: AgentWorkflowInput;
  entryTriggerId: string;
  /** Ticket facts the production trigger output publishes to bindings. Required
   * whenever the graph binds `steps.entry.output.ticket` and friends. */
  ticket?: TicketContext;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

interface ScriptEntry {
  match: ScenarioScriptMatch;
  node: WorkflowDefinitionV2Node;
  produce: ScenarioResultFactory;
  used: number;
  label: string;
}

interface GateArrival {
  nodeId: string;
  released: Deferred<void>;
  /** Resolves once the harness executor for this arrival has left, whether it
   * produced a result or threw. */
  produced: Deferred<void>;
}

function quoteAll(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `"${value}"`).join(", ");
}

function describeMatch(match: ScenarioScriptMatch): string {
  const parts = [`node "${match.nodeId}"`];
  if (match.attempt !== undefined) parts.push(`attempt ${match.attempt}`);
  if (match.activationScopeId !== undefined) {
    parts.push(`scope "${match.activationScopeId}"`);
  }
  return parts.join(", ");
}

function describeInvocation(context: V2InvocationContext): string {
  return `node "${context.nodeId}", attempt ${context.attempt}, scope "${context.activationScopeId}"`;
}

function matchKey(match: ScenarioScriptMatch): string {
  return `${match.nodeId}|${match.attempt ?? "*"}|${match.activationScopeId ?? "*"}`;
}

/** Higher wins, so an attempt-specific script beats a node-wide one. Ties are
 * impossible because two matches with equal specificity over the same node
 * either share a key (rejected at registration) or cannot match the same
 * invocation. */
function specificity(match: ScenarioScriptMatch): number {
  return (
    (match.attempt === undefined ? 0 : 2) +
    (match.activationScopeId === undefined ? 0 : 1)
  );
}

function matchesInvocation(
  match: ScenarioScriptMatch,
  context: V2InvocationContext,
): boolean {
  if (match.nodeId !== context.nodeId) return false;
  if (match.attempt !== undefined && match.attempt !== context.attempt) {
    return false;
  }
  return (
    match.activationScopeId === undefined ||
    match.activationScopeId === context.activationScopeId
  );
}

/**
 * Why a block cannot be scripted, or undefined when it can. Exported because no
 * shipped template contains a Transform node today, so this rule would
 * otherwise be untestable for that type.
 */
export function nonScriptableBlockReason(
  node: Pick<WorkflowDefinitionV2Node, "id" | "type">,
): string | undefined {
  if (isSchedulerOwnedBlockType(node.type)) {
    return `node "${node.id}" is a scheduler-owned "${node.type}" block. The scheduler resolves it without calling a block executor, so a script could not change what it does.`;
  }
  if (PRODUCTION_OWNED_BLOCK_TYPES.has(node.type)) {
    return `node "${node.id}" is a dispatcher-owned "${node.type}" block. The harness replays the production result for it, so a script would assert harness behaviour instead of product behaviour.`;
  }
  return undefined;
}

interface ScenarioGraph {
  /** How every violation names this graph, for example `template "post-pr-review"`. */
  source: string;
  definition: WorkflowDefinitionV2;
}

function loadTemplateGraph(
  id: string,
  options: TemplateOptions,
): ScenarioGraph {
  const source = `template "${id}"`;
  const template = workflowDefinitionTemplate(id, options);
  if (!template) {
    throw new ScenarioViolation(
      `Unknown workflow ${source}. A scenario may only run a template that templates.ts ships.`,
    );
  }
  if (template.definition.schemaVersion !== 2) {
    throw new ScenarioViolation(
      `Workflow ${source} is not a v2 definition, and the harness drives the v2 scheduler.`,
    );
  }
  return { source, definition: template.definition };
}

/** Loads a committed snapshot of a deployed definition through both gates a
 * deployment passes: the definition schema and the deployment validator. A file
 * with, say, a dangling edge parses cleanly and would otherwise surface much
 * later as a confusing scheduler error. */
function loadSnapshotGraph(path: string): ScenarioGraph {
  const source = `snapshot "${path}"`;
  const file = new URL(path, SNAPSHOT_DIRECTORY);
  if (!file.href.startsWith(SNAPSHOT_DIRECTORY.href)) {
    throw new ScenarioViolation(
      `Workflow ${source} resolves outside the committed snapshots directory. A scenario may only run a snapshot checked into the repository.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ScenarioViolation(
      `Workflow ${source} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioViolation(
      `Workflow ${source} is not a valid workflow definition: ${describeWorkflowDefinitionIssues(parsed.error)}.`,
    );
  }
  if (parsed.data.schemaVersion !== 2) {
    throw new ScenarioViolation(
      `Workflow ${source} is not a v2 definition, and the harness drives the v2 scheduler.`,
    );
  }
  const deploymentIssues = validateWorkflowDefinitionIssuesForDeployment(
    parsed.data,
    SNAPSHOT_REGISTRY_CONTEXT,
    { checkEnvironmentAvailability: false },
  );
  if (deploymentIssues.length > 0) {
    throw new ScenarioViolation(
      `Workflow ${source} would not deploy: ${deploymentIssues.map((issue) => issue.message).join("; ")}.`,
    );
  }
  return { source, definition: parsed.data };
}

function loadScenarioGraph(options: CreateScenarioOptions): ScenarioGraph {
  if (options.template && options.snapshot) {
    throw new ScenarioViolation(
      "A scenario runs exactly one graph, so it must pass either `template` or `snapshot`, never both.",
    );
  }
  if (options.template) {
    return loadTemplateGraph(options.template.id, options.template.options);
  }
  if (options.snapshot) return loadSnapshotGraph(options.snapshot.path);
  throw new ScenarioViolation(
    "A scenario needs a graph, so it must pass either `template` or `snapshot`. Inline nodes and edges are not accepted.",
  );
}

/**
 * Holds every member of a group inside the harness executor until all of them
 * have arrived. Because the executor cannot return before the gate opens, no
 * member can finish before every member has started: that is the structural
 * proof of concurrency, with no timing involved.
 */
class ScenarioGate {
  private readonly arrivals = new Map<string, GateArrival>();
  private roundId = 0;
  private disposed = false;

  constructor(
    private readonly source: string,
    readonly members: readonly string[],
    private readonly mode: "together" | "ordered",
  ) {}

  arrive(nodeId: string): GateArrival {
    if (this.arrivals.has(nodeId)) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} holds ${quoteAll(this.members)} together, but node "${nodeId}" arrived twice before the group was complete. A gate describes one concurrent round.`,
      );
    }
    const arrival: GateArrival = {
      nodeId,
      released: deferred(),
      produced: deferred(),
    };
    this.arrivals.set(nodeId, arrival);
    if (this.arrivals.size === this.members.length) {
      this.openRound();
    } else {
      this.armWatchdog();
    }
    return arrival;
  }

  /** Force-releases anything still held, so an aborted run never leaves the
   * suite waiting on a gate nobody will open. */
  dispose(): void {
    this.disposed = true;
    const held = [...this.arrivals.values()];
    this.arrivals.clear();
    for (const arrival of held) arrival.released.resolve();
  }

  private openRound(): void {
    const round = new Map(this.arrivals);
    this.arrivals.clear();
    const roundId = ++this.roundId;
    if (this.mode === "together") {
      for (const arrival of round.values()) arrival.released.resolve();
      return;
    }
    void (async () => {
      for (const nodeId of this.members) {
        if (this.disposed || roundId !== this.roundId) return;
        const arrival = round.get(nodeId)!;
        arrival.released.resolve();
        await arrival.produced.promise;
      }
    })();
  }

  /**
   * Counts macrotask turns without a new arrival. Any progress (another
   * arrival, the round opening, disposal) abandons the chain, so a healthy run
   * never reaches the limit and the count can never make a passing scenario
   * fail for being slow.
   */
  private armWatchdog(): void {
    const roundId = this.roundId;
    const arrived = this.arrivals.size;
    let turns = 0;
    const tick = (): void => {
      if (this.disposed) return;
      if (this.roundId !== roundId || this.arrivals.size !== arrived) return;
      if (++turns < QUIESCENCE_TURNS) {
        setImmediate(tick);
        return;
      }
      this.failUnsatisfiable();
    };
    setImmediate(tick);
  }

  private failUnsatisfiable(): void {
    const held = [...this.arrivals.values()];
    this.arrivals.clear();
    this.roundId += 1;
    const arrivedIds = held.map((arrival) => arrival.nodeId);
    const missing = this.members.filter((nodeId) => !arrivedIds.includes(nodeId));
    const error = new ScenarioViolation(
      `Scenario for ${this.source} holds ${quoteAll(this.members)} together, but the run went quiet with only ${quoteAll(arrivedIds)} started. Never started: ${quoteAll(missing)}. The graph cannot run these blocks at the same time.`,
    );
    for (const arrival of held) arrival.released.reject(error);
  }
}

class Scenario {
  private readonly source: string;
  private readonly definition: WorkflowDefinitionV2;
  private readonly nodes: Map<string, WorkflowDefinitionV2Node>;
  private readonly triggerOutput: BlockOutput;
  private readonly scripts: ScriptEntry[] = [];
  private readonly scriptKeys = new Set<string>();
  private readonly gateByNodeId = new Map<string, ScenarioGate>();
  private readonly gates: ScenarioGate[] = [];
  private readonly invocationLog: ScenarioInvocation[] = [];
  private readonly invocationByIdentity = new Map<string, ScenarioInvocation>();
  private hookSequence = 0;
  private started = false;

  constructor(private readonly options: CreateScenarioOptions) {
    const graph = loadScenarioGraph(options);
    this.source = graph.source;
    this.definition = graph.definition;
    this.nodes = new Map(this.definition.nodes.map((node) => [node.id, node]));

    const trigger = this.nodes.get(options.entryTriggerId);
    if (!trigger) {
      throw new ScenarioViolation(
        `Workflow ${this.source} has no node "${options.entryTriggerId}" to enter from. It defines: ${quoteAll(this.definition.nodes.map((node) => node.id))}.`,
      );
    }
    const expectedType = triggerTypeFor(options.entry);
    if (trigger.type !== expectedType) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} enters at node "${options.entryTriggerId}" (type "${trigger.type}"), but its entry (kind "${options.entry.kind}") fires "${expectedType}". A run cannot deliver one trigger's payload through another trigger's node.`,
      );
    }
    this.triggerOutput = triggerOutputWithTicketContext(
      options.entry,
      options.ticket,
    );
    const issues = validateBlockOutputForDefinition(
      trigger.type,
      trigger.configuration as unknown as Record<string, WorkflowParamValue>,
      this.triggerOutput,
      // Stated rather than defaulted: a `scope: "any"` PR trigger deliberately
      // publishes no ticket fields in production, so requiring the normal
      // binding output here would reject a legitimate entry.
      { requireNormalOutput: false },
    );
    if (issues.length > 0) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} derives an invalid "${trigger.type}" trigger output from its entry: ${issues.join("; ")}.`,
      );
    }
  }

  /**
   * Claims the invocations described by `match`. A script may serve several
   * invocations (for example every attempt of a Loop body) but must serve at
   * least one, otherwise the scenario asserts something that never ran.
   */
  script(
    match: ScenarioScriptMatch,
    result: BlockExecutionResult | ScenarioResultFactory,
  ): this {
    this.assertNotStarted("script");
    const node = this.requireNode(match.nodeId);
    this.assertScriptable(node);
    const key = matchKey(match);
    if (this.scriptKeys.has(key)) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} already scripts ${describeMatch(match)}. Two scripts claiming the same invocations cannot both be right, so pick one.`,
      );
    }
    this.scriptKeys.add(key);
    if (typeof result !== "function") {
      this.assertScriptedOutput(node, result, describeMatch(match));
    }
    this.scripts.push({
      match,
      node,
      produce: typeof result === "function" ? result : () => result,
      used: 0,
      label: describeMatch(match),
    });
    return this;
  }

  /** Holds every listed node inside the executor until all of them have
   * started. Members still need their own `script`. */
  barrier(nodeIds: readonly string[]): this {
    this.assertNotStarted("barrier");
    this.registerGate(nodeIds, "together");
    return this;
  }

  /**
   * Holds every listed node, then completes them one at a time in the listed
   * order, awaiting each before releasing the next. Releasing in a
   * non-declaration order proves a join waits for all of its inputs and orders
   * them by declaration rather than by completion.
   */
  releaseInOrder(
    nodeIds: readonly string[],
    resultFor: (
      nodeId: string,
      context: V2InvocationContext,
    ) => BlockExecutionResult,
  ): this {
    this.assertNotStarted("releaseInOrder");
    this.registerGate(nodeIds, "ordered");
    for (const nodeId of nodeIds) {
      // The context carries attempt and scope, so a join inside a Loop can vary
      // its members per pass while still being released out of declaration
      // order.
      this.script({ nodeId }, (_node, _inputs, context) =>
        resultFor(nodeId, context),
      );
    }
    return this;
  }

  /** The records gathered so far. Readable even when `execute` rejects, so a
   * failing scenario can still be interrogated about what actually ran. */
  get invocations(): readonly ScenarioInvocation[] {
    return this.invocationLog;
  }

  async execute(): Promise<ScenarioOutcome> {
    this.assertNotStarted("execute");
    this.started = true;
    let failure: unknown;
    try {
      const result = await executeV2Graph({
        definition: this.definition,
        entryTriggerId: this.options.entryTriggerId,
        triggerOutput: this.triggerOutput,
        maxConcurrency: V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency,
        maxTotalExecutions: V2_PRODUCTION_SCHEDULER_BOUNDS.maxTotalExecutions,
        // Mirrors the production call site: a run-level control signal must end
        // the walk instead of becoming an authored block failure.
        shouldRethrowExecutionError: (error) =>
          error instanceof ScenarioViolation || isRunControlError(error),
        hooks: this.schedulerHooks(),
        executeBlock: (node, steps, resolvedInputs, context) =>
          this.runBlock(node, steps, resolvedInputs, context),
      });
      return {
        result,
        invocations: this.invocationLog,
        invocationsOf: (nodeId) =>
          this.invocationLog.filter((entry) => entry.nodeId === nodeId),
      };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      for (const gate of this.gates) gate.dispose();
      const unused = this.scripts.filter((entry) => entry.used === 0);
      if (unused.length > 0) {
        throw new ScenarioViolation(
          `Scenario for ${this.source} scripted outcomes that never ran: ${unused.map((entry) => entry.label).join("; ")}. Remove them or fix the scenario's expectations.${
            failure === undefined
              ? ""
              : ` The run also ended with: ${failure instanceof Error ? failure.message : String(failure)}`
          }`,
        );
      }
    }
  }

  private async runBlock(
    node: WorkflowDefinitionV2Node,
    steps: Readonly<V2StepsRecord>,
    resolvedInputs: Readonly<Record<string, unknown>>,
    context: V2InvocationContext,
  ): Promise<BlockExecutionResult> {
    const record = this.invocationRecord(context);
    record.enteredExecutor = true;
    record.resolvedInputs = structuredClone(resolvedInputs) as Record<
      string,
      unknown
    >;
    if (isSchedulerOwnedBlockType(node.type)) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} saw the scheduler dispatch "${node.id}" (type "${node.type}") to a block executor. Control-flow behaviour is production-owned and must never reach the harness.`,
      );
    }
    if (PRODUCTION_OWNED_BLOCK_TYPES.has(node.type)) {
      const result = await this.productionOwnedResult(node, steps, context);
      record.result = result;
      return result;
    }
    const script = this.resolveScript(node, context);
    script.used += 1;
    const arrival = this.gateByNodeId.get(node.id)?.arrive(node.id);
    try {
      if (arrival) {
        // A failing or cancelled run quiesces its siblings by awaiting them, so
        // a gate that only opens on an explicit release would hang the suite.
        await Promise.race([
          arrival.released.promise,
          context.cancellation.wait(),
        ]);
        context.cancellation.throwIfCancelled();
      }
      const result = await script.produce(node, resolvedInputs, context);
      // A factory result is only known now, so name the invocation the
      // scheduler actually ran rather than the (possibly node-wide) match.
      this.assertScriptedOutput(node, result, describeInvocation(context));
      record.result = result;
      return result;
    } finally {
      arrival?.produced.resolve();
    }
  }

  /** Replays the production dispatcher for the two block types it owns, minus
   * their side effects: `terminate` posts a ticket comment in a real run, which
   * the harness must never do. */
  private async productionOwnedResult(
    node: WorkflowDefinitionV2Node,
    steps: Readonly<V2StepsRecord>,
    context: V2InvocationContext,
  ): Promise<BlockExecutionResult> {
    if (node.type === "transform") {
      const bindingContext: V2BindingResolutionContext = {
        entryOutput: this.triggerOutput,
        getStepOutput: (nodeId) => steps[nodeId]?.output,
      };
      try {
        return {
          kind: "next",
          output: {
            status: "ok",
            output: await executeTransform(
              node.configuration as unknown as TransformConfiguration,
              bindingContext,
            ),
          },
        };
      } catch (error) {
        return executionError(
          error instanceof Error ? error.message : String(error),
          { category: "binding", phase: "transform" },
        );
      }
    }
    const configured = node.configuration.terminalStatus;
    const terminalStatus = TERMINAL_STATUSES.find(
      (status) => status === configured,
    );
    if (terminalStatus === undefined) {
      return executionError("Terminate has an invalid terminal status.", {
        category: "engine",
        phase: "terminate",
      });
    }
    const postComment =
      typeof node.configuration.postComment === "string"
        ? node.configuration.postComment
        : undefined;
    return v2TerminalBlockResult({
      terminalStatus,
      ...(postComment === undefined ? {} : { postComment }),
      ...(context.clarificationAnswer === undefined
        ? {}
        : { clarificationAnswer: context.clarificationAnswer }),
    });
  }

  private schedulerHooks(): V2SchedulerHooks {
    return {
      onTriggerActivated: (event) => {
        const record = this.invocationRecord(event);
        record.startSeq = ++this.hookSequence;
        record.finishSeq = ++this.hookSequence;
        record.selectedTransition = event.selectedTransition;
      },
      onNodeStart: (event) => {
        this.invocationRecord(event).startSeq = ++this.hookSequence;
      },
      onNodeFinish: (event) => {
        const record = this.invocationRecord(event);
        record.finishSeq = ++this.hookSequence;
        record.runtimeState = event.runtimeState;
        record.selectedTransition = event.selectedTransition;
      },
      onNodeSkipped: (event) => {
        const record = this.invocationRecord(event);
        record.startSeq = ++this.hookSequence;
        record.finishSeq = ++this.hookSequence;
        record.skipped = true;
      },
    };
  }

  private invocationRecord(identity: V2InvocationIdentity): ScenarioInvocation {
    const key = `${identity.nodeId}|${identity.attempt}|${identity.activationScopeId}`;
    const existing = this.invocationByIdentity.get(key);
    if (existing) return existing;
    const record: ScenarioInvocation = {
      nodeId: identity.nodeId,
      nodeType: this.nodes.get(identity.nodeId)?.type ?? "unknown",
      attempt: identity.attempt,
      activationScopeId: identity.activationScopeId,
      enteredExecutor: false,
    };
    this.invocationByIdentity.set(key, record);
    this.invocationLog.push(record);
    return record;
  }

  private resolveScript(
    node: WorkflowDefinitionV2Node,
    context: V2InvocationContext,
  ): ScriptEntry {
    const candidates = this.scripts.filter((entry) =>
      matchesInvocation(entry.match, context),
    );
    if (candidates.length === 0) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} did not script node "${node.id}" (type "${node.type}", attempt ${context.attempt}, scope "${context.activationScopeId}"). Add: script({ nodeId: "${node.id}", attempt: ${context.attempt}, activationScopeId: "${context.activationScopeId}" }, { kind: "next", output: { status: "ok" } }). Scripted so far: ${
          this.scripts.length === 0
            ? "nothing"
            : this.scripts.map((entry) => entry.label).join("; ")
        }.`,
      );
    }
    return candidates.reduce((best, entry) =>
      specificity(entry.match) > specificity(best.match) ? entry : best,
    );
  }

  private assertScriptedOutput(
    node: WorkflowDefinitionV2Node,
    result: BlockExecutionResult,
    label: string,
  ): void {
    if (result.kind === "execution_error") return;
    const issues = validateBlockOutputForDefinition(
      node.type,
      node.configuration as unknown as Record<string, WorkflowParamValue>,
      result.output,
      {
        requireNormalOutput:
          result.kind === "next" ||
          result.kind === "ended" ||
          result.kind === "terminal_success",
      },
    );
    if (issues.length === 0) return;
    throw new ScenarioViolation(
      `Scenario for ${this.source} scripts an invalid "${node.type}" output for ${label}: ${issues.join("; ")}.`,
    );
  }

  private registerGate(
    nodeIds: readonly string[],
    mode: "together" | "ordered",
  ): void {
    if (nodeIds.length > V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} holds ${nodeIds.length} blocks (${quoteAll(nodeIds)}) at once, but a production run dispatches at most ${V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency}. Such a scenario would deadlock a real run.`,
      );
    }
    for (const nodeId of nodeIds) {
      this.assertScriptable(this.requireNode(nodeId));
      if (this.gateByNodeId.has(nodeId)) {
        throw new ScenarioViolation(
          `Scenario for ${this.source} already holds node "${nodeId}" in another group. One block cannot belong to two concurrency claims.`,
        );
      }
    }
    const gate = new ScenarioGate(this.source, nodeIds, mode);
    this.gates.push(gate);
    for (const nodeId of nodeIds) this.gateByNodeId.set(nodeId, gate);
  }

  private requireNode(nodeId: string): WorkflowDefinitionV2Node {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new ScenarioViolation(
        `Workflow ${this.source} has no node "${nodeId}". It defines: ${quoteAll([...this.nodes.keys()])}.`,
      );
    }
    return node;
  }

  private assertScriptable(node: WorkflowDefinitionV2Node): void {
    const reason = nonScriptableBlockReason(node);
    if (reason) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} cannot script ${reason}`,
      );
    }
  }

  private assertNotStarted(operation: string): void {
    if (this.started) {
      throw new ScenarioViolation(
        `Scenario for ${this.source} has already been executed, so "${operation}" cannot change it.`,
      );
    }
  }
}

export type { Scenario };

export function createScenario(options: CreateScenarioOptions): Scenario {
  return new Scenario(options);
}
