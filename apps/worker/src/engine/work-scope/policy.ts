/**
 * What one run resolves about its work scope before it decides anything: which
 * subject it freezes a record for, and which repository policy it stands under.
 *
 * Both are read off the entry and the loaded graph, both are pure, and both are
 * answered once at the top of a run so nothing below re-derives them.
 *
 * The policy is a property of the trigger node, and the run knows which node it
 * entered through only for a webhook and a schedule
 * (`engine/agent-input.ts:91-93` and `:112-115`). For a ticket and a pull
 * request it knows the trigger TYPE and nothing more, so A35 spells a ladder:
 * the named node, else the only node of that type, else the policy every node
 * of that type agrees on, else the kind default. `source` says which rung the
 * run stood on, so a status reason can say why it is bounded the way it is.
 *
 * Pure: it reads the loaded graph and the definition pin the caller passes and
 * touches no store, no clock and no network. The per-kind defaults and the way
 * a definition pin becomes a candidate set are the contract's
 * (`resolveTriggerRepositoryPolicy`, `packages/contracts/work-scope.ts:588`)
 * and are composed here rather than copied, because the dashboard shows the
 * operator the same answer.
 */
import {
  resolveTriggerRepositoryPolicy,
  triggerRepositoryPolicySchema,
  type TriggerRepositoryPolicy,
  type WorkflowBlockType,
  type WorkflowDefinitionNode,
  type WorkflowRepositoryScope,
} from "@shared/contracts";
import type { AgentWorkflowInput } from "../agent-input.js";
import { webhookSubjectKey } from "../support/subject-key.js";
import { carriesWorkScope } from "./subject.js";

/**
 * The subject whose work scope this run freezes, or null for a run that carries
 * none.
 *
 * A36: a delivery resolved a subject of its own exactly when its subject key is
 * not the delivery-id fallback, which is tested here from `endpointId` and
 * `deliveryId` rather than carried as a flag on the run input, because such a
 * flag would be absent on every run serialized before it existed.
 */
export function runWorkScopeSubjectKey(entry: AgentWorkflowInput): string | null {
  const webhookSubjectResolved =
    entry.kind === "webhook_trigger" &&
    entry.subjectKey !== webhookSubjectKey(entry.endpointId, entry.deliveryId);
  return carriesWorkScope({
    subjectKey: entry.subjectKey,
    entryKind: entry.kind,
    webhookSubjectResolved,
  })
    ? entry.subjectKey
    : null;
}

/** Which rung of the ladder answered. `none` is a block type that carries no
 *  policy at all, which is `trigger_plan_approved` today. */
export type RunTriggerRepositoryPolicySource =
  | "node"
  | "only_node_of_kind"
  | "shared_by_kind"
  | "kind_default"
  | "none";

export interface RunTriggerRepositoryPolicy {
  policy: TriggerRepositoryPolicy | null;
  source: RunTriggerRepositoryPolicySource;
}

/**
 * The policy a node configures, or undefined when it configures none.
 *
 * Parsed rather than cast. The deployment validation already refused a stored
 * policy the schema does not accept, so a malformed one here was written by
 * something else, and reading it as absent puts the run on the kind default
 * instead of on half a policy.
 */
function configuredPolicy(node: WorkflowDefinitionNode): TriggerRepositoryPolicy | undefined {
  const configured = (node.params as Record<string, unknown> | undefined)?.repositoryPolicy;
  if (configured === undefined) return undefined;
  const parsed = triggerRepositoryPolicySchema.safeParse(configured);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether two configured policies say the same thing.
 *
 * The listed keys are compared as a SET, because that is what a candidate set
 * is: two triggers listing the same repositories in a different order are one
 * policy, and calling them two would drop the run to the kind default, which is
 * wider than either of them.
 */
function samePolicy(left: TriggerRepositoryPolicy, right: TriggerRepositoryPolicy): boolean {
  if (left.expansion !== right.expansion) return false;
  if (left.candidates.kind !== right.candidates.kind) return false;
  if (left.candidates.kind !== "listed" || right.candidates.kind !== "listed") return true;
  const leftKeys = [...left.candidates.repositoryKeys].sort();
  const rightKeys = [...right.candidates.repositoryKeys].sort();
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

export function resolveRunTriggerRepositoryPolicy(input: {
  entryKind: AgentWorkflowInput["kind"];
  triggerType: WorkflowBlockType;
  /** The node the run entered through. A webhook and a schedule carry one;
   *  nothing else does. */
  nodeId?: string;
  /** The graph this run loaded, or null where there is none to read. */
  plan: { nodes: readonly WorkflowDefinitionNode[] } | null;
  definitionPin?: WorkflowRepositoryScope;
  /** Whether this delivery has a subject an answer could be recorded against.
   *  It decides the webhook kind default, because without one every delivery is
   *  a new subject and "ask once" would mean "ask every delivery". */
  webhookHasSubjectPath: boolean;
}): RunTriggerRepositoryPolicy {
  const resolve = (configured?: TriggerRepositoryPolicy) =>
    resolveTriggerRepositoryPolicy({
      triggerType: input.triggerType,
      ...(configured === undefined ? {} : { configured }),
      ...(input.definitionPin === undefined ? {} : { definitionPin: input.definitionPin }),
      webhookHasSubjectPath: input.webhookHasSubjectPath,
    });

  // A block type that carries no policy, `trigger_plan_approved` above all: an
  // approved plan works from the repository snapshot a person approved. Asked
  // first, so no rung below can invent one for it.
  const kindDefault = resolve();
  if (kindDefault === null) return { policy: null, source: "none" };

  const nodes = (input.plan?.nodes ?? []).filter((node) => node.type === input.triggerType);

  if (
    (input.entryKind === "webhook_trigger" || input.entryKind === "schedule") &&
    input.nodeId !== undefined
  ) {
    const entered = nodes.find((node) => node.id === input.nodeId);
    // A delivery or an occurrence can sit in the pending queue across a publish
    // that removed its node. The graph can still answer, so a missing node falls
    // to the next rung rather than straight to the kind default.
    if (entered) return { policy: resolve(configuredPolicy(entered)), source: "node" };
  }

  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only) return { policy: resolve(configuredPolicy(only)), source: "only_node_of_kind" };

  const first = nodes[0] === undefined ? undefined : configuredPolicy(nodes[0]);
  if (
    first !== undefined &&
    nodes.every((node) => {
      const policy = configuredPolicy(node);
      return policy !== undefined && samePolicy(policy, first);
    })
  ) {
    return { policy: resolve(first), source: "shared_by_kind" };
  }

  return { policy: kindDefault, source: "kind_default" };
}
