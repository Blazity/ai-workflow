import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  applyWorkflowDefinitionLayout,
  isTriggerBlockType,
  normalizeWorkflowDefinitionLayout,
  pinnedRepositoriesNotEnabledSentence,
  positionsCarryNoLayout,
  RETIRED_SCHEMA_MESSAGE,
} from "@shared/contracts";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionLayout,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import { workflowDefinitionUrl } from "../../services/publication/dashboard-links.js";
import { dashboardOrigin } from "../../services/settings/runtime-settings.js";
import {
  declaresRetiredSchema,
  logger,
  validateWorkflowDefinitionCandidate,
} from "../../services/mcp/app-dependencies.js";
import { pinnedRepositoriesNotEnabled } from "../../services/repository-catalog/index.js";
import { agentFacingBlockContracts } from "../integration-facts.js";
import { redactIntegrationVariableNames } from "../integration-redaction.js";
import {
  runnableDefinitionOf,
  WorkflowDefinitionStoreError,
  WorkflowDefinitionValidationError,
} from "../../services/workflow-definitions/definition-store.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { registerCatalogTool } from "../tool-catalog.js";
import {
  announceAuthoringChange,
  announcementLabel,
  refusal,
  storeActor,
} from "./authoring-support.js";

/**
 * The highest privilege this server grants. A workflow definition is the
 * instruction the platform carries out with its own credentials: it says which
 * repositories are cloned, what an agent is told to do inside them, and what is
 * pushed back. prompts.update decides what a run is told; this decides what a run
 * IS. So the three tools below add no rules of their own and take none away:
 *
 *   - a scope of its own (contracts.ts:12) and a role list without "service"
 *     (policy.ts), with services/mcp/actor-resolution.ts stripping the scope out of an
 *     unattended token's actor;
 *   - every graph goes through the definition schema in @shared/workflow-graph
 *     (`workflowDefinitionV2Schema`, packages/workflow-graph/schema.ts), and a
 *     publish through the deployment gate inside deployWorkflowDefinition, which is the
 *     whole of what the dashboard's Deploy button calls
 *     (routes/api/v1/workflow-definitions/[id]/deploy.post.ts:55, through the role
 *     checking wrapper deployWorkflowDefinitionDraft,
 *     services/workflow-definitions/deployment.ts:44);
 *   - compare-and-set on both writes that touch existing state, enforced by the
 *     store's own SQL rather than by a read here.
 *
 * What none of that does is keep a publish away from live traffic, and this module
 * used to claim it did. workflows.create makes a DISABLED definition and nothing
 * here flips that switch, but workflows.publish takes any definitionId: publishing
 * into a definition an operator has ALREADY enabled replaces what the platform
 * executes for real events at once, because dispatch resolves the deployed version
 * live (engine/definition-trigger-routing.ts:95-98) and the deploy claims that
 * definition's trigger bindings on the way past
 * (db/repositories/definitions/atomic.ts:131-142). `enabled` in the reply is therefore
 * inherited from the definition and not a verdict on the publish, and
 * `liveOnRealEvents` is the field that says which of the two just happened.
 *
 * The role gate answers "who", not "on whose behalf": an admin token whose agent
 * has just read a ticket marked external_untrusted is the actor this cannot tell
 * apart from any other. So both writes report which of a graph's pinned
 * repositories the repository catalog does not enable, and a publish is announced
 * to the operators' channel, on the principle that the answer to a legitimate
 * client doing something consequential is to make it visible rather than to
 * forbid it.
 */

type CreateData = {
  definitionId: number;
  name: string;
  // Always 0 for a definition that was just created with no graph. Returned
  // anyway, because it is what save_draft takes as expectedDraftRevision, and an
  // agent that has to guess the first revision guesses 1.
  draftRevision: number;
};

type SaveDraftData = {
  definitionId: number;
  draftRevision: number;
  // Over the version the store WROTE, read back rather than over the arguments:
  // the store canonicalizes a graph on its way in
  // (services/workflow-definitions/policy-operations.ts:672), so a digest of
  // the request would disagree with the digest workflows.publish reports for the
  // very same version and neither agent nor operator could tell which one moved.
  graphHash: string;
  // See pinnedRepositoriesNotEnabled below. Reported on a draft too, because the
  // draft is where the pin is chosen and the publish is where it starts being
  // acted on, and an operator reading the audit trail backwards wants both.
  pinnedRepositoriesNotEnabled: string[];
  /**
   * What the editor's own validation says about this graph, and why not.
   *
   * The draft is STORED either way, exactly as the editor stores one that is
   * not yet deployable (ADR-010 decision 15: workflow authoring over MCP gets
   * the same issue as the editor). Refusing it here would leave an agent unable
   * to build a graph in steps toward an integration a person has yet to
   * connect, and would make this surface disagree with the editor about the
   * same graph.
   *
   * What must be impossible is reading a success without the reason it cannot
   * ship, so this sits beside the revision an agent came for rather than behind
   * a second call. The issues are the editor's own, with the integration named
   * in each message.
   *
   * It is NOT a promise about workflows.publish, and the name is the closest
   * honest one rather than an exact one. `validateWorkflowDefinitionCandidate`
   * resolves no pinned Harness Profile versions, while the deploy gate does, so
   * a graph pinning a version this deployment cannot resolve reads deployable
   * here and is refused there. Making this call database-bound would close that
   * gap and open a worse one: it would answer differently from the editor's own
   * draft save, which runs exactly this function (validate.post.ts), and "MCP
   * and the editor never disagree about one graph" is the rule this stage is
   * built on. The two are reconciled by teaching that one function about
   * profiles, which is the engine's call and not this stage's.
   */
  deployable: boolean;
  deploymentIssues: SaveDraftIssue[];
  /**
   * How many issues there were, which is not always how many are listed.
   *
   * An agent that fixed the fifty it was shown, saved again and met fifty more
   * would have no way to learn there had ever been a cap; it would read each
   * round as new damage it had just caused. So the count is reported even when
   * nothing was dropped.
   */
  deploymentIssueCount: number;
  /**
   * What happened to the node positions the graph carried. They are layout,
   * stored beside the graph and never part of its hash, the way the editor
   * stores them:
   *
   * - `saved`: they are now where the editor draws each node;
   * - `unchanged`: they were already stored exactly so;
   * - `not_sent`: every node sat on one point, which says nothing about where
   *   anything goes, so the stored positions were left as they were and the
   *   editor lays out a graph that has none;
   * - `not_saved`: the draft is saved but the positions are not, because
   *   somebody moved nodes in the editor at the same moment (or the write
   *   failed); save again to place them.
   */
  positions: "saved" | "unchanged" | "not_sent" | "not_saved";
};

/** One editor issue, as an agent reads it: where in the graph, and what to fix. */
type SaveDraftIssue = {
  code: string;
  severity: string;
  /** The node the issue belongs to, when the walk could attach one. */
  nodeId: string | null;
  /** A JSON pointer into the graph the agent sent, which is how it finds the
   *  thing to fix. Null for an issue about the definition as a whole. */
  path: string | null;
  message: string;
};

/**
 * Enough for every node of a graph to have one thing wrong with it and then
 * some, and bounded so a pathological definition cannot push this response past
 * the envelope's byte budget, where the whole `data` would be replaced by a
 * digest and the agent would lose the revision it came for.
 */
const MAX_REPORTED_DEPLOYMENT_ISSUES = 50;

type PublishData = {
  definitionId: number;
  deployedVersion: number;
  // What this deployment replaced, echoed from the argument it was pinned to, so an
  // agent holding only this reply has the number a rollback takes.
  replacedVersion: number | null;
  // Content identity for what actually went live, over the stored version and by
  // the same rule save_draft hashes by, so the two values compare. A revision
  // NUMBER is not identity: an agent resuming a plan can publish revision 5
  // believing it is its own graph, pass the compare-and-set, and arm somebody
  // else's. This is the field that catches that, after the fact but at all.
  graphHash: string;
  // The definition's own enable switch, inherited: publishing neither sets nor
  // clears it. False means the graph just deployed is only what a manual dispatch
  // resolves against; true means it is also what real ticket and pull request
  // events now execute, and this publish is what put it there.
  enabled: boolean;
  triggerTypes: string[];
  // True when this publish VERIFIED that at least one trigger of the graph it
  // deployed can fire: the definition is enabled and that trigger's own
  // prerequisite exists. Never inferred from `enabled` alone, which is what it used
  // to be: an enabled definition whose only trigger is a paused schedule or a
  // webhook whose endpoint was never minted answers real events with nothing.
  liveOnRealEvents: boolean;
  // The trigger nodes on the other side of that check: every trigger node whose
  // ability to fire this publish could NOT establish. All of them when the
  // definition is disabled; a schedule row that is paused (a human intention a
  // deploy has no business overriding: the redeploy upsert at
  // db/repositories/schedule-triggers.ts:44-49 leaves paused_at out of its set)
  // or revoked; a webhook node with no endpoint row, which is what a deployment
  // without WEBHOOK_TRIGGER_ENCRYPTION_KEY leaves behind
  // (services/workflow-definitions/live-trigger-sync.ts:94); and, honestly
  // rather than optimistically, every trigger node when the check itself could not
  // be run.
  dormantTriggerNodeIds: string[];
  // "provider:owner/repo" for every repository the published graph PINS that the
  // repository catalog does not enable. A pin extends nothing: an event from a
  // repository nobody enabled is refused whatever the graph pins, and a run that
  // started some other way cannot reach one either, because the run carries the
  // catalog's enabled list from its start. The deployment gate checks a graph's
  // shape rather than this.
  // Empty on a deployment whose catalog is not activated yet, because there every
  // accessible repository still counts as enabled.
  //
  // Worth knowing where these strings then live: this whole value is stored as the
  // idempotency key's response for the key's lifetime (idempotency-store.ts), so a
  // repository path outlives the call in that row. It is not in the audit row,
  // which carries the count alone.
  pinnedRepositoriesNotEnabled: string[];
};

type LegacyGraphData = {
  schema: "legacy-v1";
  message: string;
};

type GraphData = {
  definitionId: number;
  name: string;
  // The definition's own enable switch, so a reader that fetched the graph to edit
  // it also learns whether it is answering real events right now.
  enabled: boolean;
  // The token workflows.save_draft takes as expectedDraftRevision. 0 (and draft
  // null) for a definition created with no graph yet.
  draftRevision: number;
  // The token workflows.publish takes as expectedDeployedVersion. null (and deployed
  // null) when nothing is deployed.
  deployedVersion: number | null;
  // The stored draft/deployed graphs in the exact {schemaVersion, nodes, edges}
  // shape workflows.save_draft accepts, read back through the SAME version-row path
  // save_draft hashes, with the definition's stored layout put back on the nodes
  // so a round trip keeps where the editor draws them. Positions are not part of
  // the hash (the store saves every version with nodes at 0,0), so re-saving an
  // unmodified draft still canonicalizes to the same bytes and the same hash.
  draft: WorkflowDefinition | null;
  deployed: WorkflowDefinition | LegacyGraphData | null;
  // sha256 over the canonical JSON of each stored version, by the same rule
  // save_draft and publish hash, so an agent can confirm a round trip without
  // re-deriving it.
  draftGraphHash: string | null;
  deployedGraphHash: string | null;
};

type SetEnabledData = {
  definitionId: number;
  name: string;
  // The resulting state and the triggers that are now (or, on a disable, no longer)
  // live for real events.
  enabled: boolean;
  triggerTypes: string[];
};

/**
 * The pinned repositories the repository catalog does not enable, read off a
 * graph.
 *
 * The service tier owns the rule now
 * (`services/repository-catalog/pins.ts`), because the dashboard's Deploy
 * button needs exactly this answer and used to compute its own from its own
 * copy of the catalog. Two surfaces deriving one fact is how they end up
 * disagreeing about it, so the REST deploy route and the two tools below call
 * one function. Aliased to the old local name so the call sites read as they
 * did.
 */
const pinsNotEnabledInCatalog = pinnedRepositoriesNotEnabled;

/**
 * The audit row's own signal for the finding above, as one more targetRef. A flag
 * and a count and nothing else: targetRefs are stored verbatim
 * (services/mcp/audit-store.ts:62), so the repository paths stay in the reply and the channel,
 * where a person reads them once, rather than in a table kept for a year. Always
 * appended, including as ":0", so a row proves the check ran instead of leaving an
 * operator unable to tell "every pin is enabled" from "nobody looked".
 */
function catalogRef(notEnabled: readonly string[]): string {
  return `pinned_repos_not_enabled:${notEnabled.length}`;
}

/** Both stored graph shapes carry an id and a type on every node, which is all the
 *  trigger checks below read. */
function triggerNodesOf(graph: WorkflowDefinition): Array<{ id: string; type: WorkflowBlockType }> {
  const nodes: Array<{ id: string; type: WorkflowBlockType }> = graph.nodes;
  return nodes.filter((node) => isTriggerBlockType(node.type));
}

/**
 * The trigger nodes of a freshly deployed graph that this publish could not show to
 * be able to fire. Deliberately a check and not a deduction: for two trigger types
 * the row that lets them fire lives outside the definition, and a deploy that
 * succeeded does not establish that it is there and usable.
 *
 *   - a schedule fires from a row in workflow_schedules, and the evaluator skips a
 *     paused or revoked one (schedule-store.ts, listEvaluableSchedules). paused_at
 *     survives a redeploy on purpose, so "published" and "will fire" are genuinely
 *     different questions here;
 *   - a webhook delivery authenticates against an endpoint row. The deployment gate
 *     already refuses a webhook trigger when webhook encryption is unconfigured, so
 *     what is left for this check is a mint that failed (it is best-effort,
 *     services/workflow-definitions/live-trigger-sync.ts:100-104) and an endpoint
 *     an operator revoked;
 *   - every other trigger type routes through the binding table, which THIS deploy
 *     claimed in the same statement that moved the head, for an enabled definition
 *     (db/repositories/definitions/atomic.ts:131-142). That one is established by the deploy having succeeded.
 *
 * A disabled definition reaches none of them, so all of its trigger nodes are
 * dormant.
 */
async function dormantTriggerNodes(
  services: McpToolDependencies["services"],
  definitionId: number,
  graph: WorkflowDefinition,
  enabled: boolean,
): Promise<string[]> {
  const triggers = triggerNodesOf(graph);
  if (!enabled) return triggers.map((node) => node.id);

  const dormant: string[] = [];
  const scheduleRows = triggers.some((node) => node.type === "trigger_schedule")
    ? await services.listSchedulesForDefinition(definitionId)
    : [];
  for (const node of triggers) {
    if (node.type === "trigger_schedule") {
      const row = scheduleRows.find((schedule) => schedule.nodeId === node.id);
      if (!row || row.pausedAt !== null || row.revokedAt !== null) dormant.push(node.id);
      continue;
    }
    if (node.type === "trigger_webhook") {
      const endpoint = await services.getWebhookEndpointForNode(definitionId, node.id);
      if (!endpoint || endpoint.revokedAt !== null) dormant.push(node.id);
    }
  }
  return dormant;
}

/**
 * What the operators' channel is told about a publish. Composed as sentences rather
 * than one nested template because each sentence is a separate decision:
 *
 *   - a republish of the version already deployed is named as one, since the copy
 *     "as version 7, replacing version 7" reads like a mistake, and the deploy is
 *     real either way (it re-claims the bindings and re-syncs the schedules);
 *   - the draft's author is named only when it is not the publisher, which is the
 *     case that surprises people: one client composes a graph, another publishes it;
 *   - the pinned repositories are named in FULL here, unlike in the audit row. This
 *     is the channel a human reads, the paths are what makes the warning actionable,
 *     and the pin genuinely widens what the platform will clone and open pull
 *     requests on;
 *   - the deep link and the rollback number, so the reader's next move is a click
 *     rather than a search.
 *
 * Every caller-supplied label goes through announcementLabel, because a workflow
 * name and a repository path are both text an agent chose and both land inside a
 * message an operator is meant to trust.
 */
function publishAnnouncement(publish: {
  name: string;
  definitionId: number;
  deployedVersion: number;
  replacedVersion: number | null;
  draftAuthor: string | null;
  enabled: boolean;
  triggerTypes: string[];
  dormant: string[];
  liveOnRealEvents: boolean;
  notEnabled: string[];
}): string {
  const name = announcementLabel(publish.name);
  const target = `workflow "${name}" (definition ${publish.definitionId})`;
  const sentences: string[] = [
    publish.replacedVersion === publish.deployedVersion
      ? `re-deployed version ${publish.deployedVersion} of ${target} without changing which version is live.`
      : `published ${target} as version ${publish.deployedVersion}${
          publish.replacedVersion === null
            ? ""
            : `, replacing version ${publish.replacedVersion}`
        }.`,
  ];
  if (publish.draftAuthor !== null) {
    sentences.push(`The graph was drafted by ${announcementLabel(publish.draftAuthor)}.`);
  }
  const dormantTail =
    publish.dormant.length === 0
      ? ""
      : ` Not verified able to fire: ${publish.dormant.map((id) => announcementLabel(id)).join(", ")} (a paused or revoked schedule, a missing webhook endpoint, or a check that could not be run).`;
  if (!publish.enabled) {
    sentences.push("The definition is disabled, so only a manual dispatch runs this graph.");
  } else if (publish.liveOnRealEvents) {
    sentences.push(
      `The definition is ENABLED, so real events (${publish.triggerTypes.join(", ")}) now run this graph.${dormantTail}`,
    );
  } else {
    sentences.push(
      `The definition is enabled, but no trigger of this graph was verified able to fire.${dormantTail}`,
    );
  }
  if (publish.notEnabled.length > 0) {
    // The catalog decides both halves now: it refuses the events, and a run
    // that starts some other way cannot reach the repository either, because
    // the run carries the same enabled list. The wording is the contract's, so
    // the editor's deploy confirmation says it in the same words; only the
    // labels are flattened here, which is this channel's own rule.
    sentences.push(
      pinnedRepositoriesNotEnabledSentence(publish.notEnabled, announcementLabel),
    );
  }
  const link = `<${workflowDefinitionUrl(dashboardOrigin(), publish.definitionId)}|open in the editor>`;
  sentences.push(
    publish.replacedVersion === null || publish.replacedVersion === publish.deployedVersion
      ? `Review it here: ${link}.`
      : `Review it, or roll back to version ${publish.replacedVersion}, here: ${link}.`,
  );
  return sentences.join(" ");
}

/** The issues as the dashboard's editor lists them, each one behind the JSON
 * pointer into the graph the agent sent, which is the only way it can find the
 * block to fix. Nothing else of the failure travels: no file, no query, no stack. */
function issueText(issues: readonly WorkflowDefinitionValidationIssue[]): string {
  // Redacted, because a publish is refused with the issues the deployment gate
  // raised and that gate resolves contracts for an admin: its sentence for an
  // unusable integration names the variable that is missing, and an error
  // message does not travel through the envelope sanitizer.
  return redactIntegrationVariableNames(
    issues
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .join("; "),
  );
}

/** The same issues as structured rows, for a save that stored the draft anyway. */
function reportableIssues(
  issues: readonly WorkflowDefinitionValidationIssue[],
): SaveDraftIssue[] {
  return issues.slice(0, MAX_REPORTED_DEPLOYMENT_ISSUES).map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    nodeId: issue.nodeId ?? null,
    path: issue.path ?? null,
    message: issue.message,
  }));
}

/**
 * Store the positions a saved graph carried as the definition's layout, the
 * way the editor stores a node somebody dragged: beside the graph, with the
 * layout revision as its compare-and-set, merged over what was there so a
 * node this graph does not name keeps its place and an edge keeps its bend.
 *
 * Never allowed to fail the save it follows: the draft has already landed,
 * and an error here would tell the caller a completed save failed and seal
 * its idempotency key over a version that exists.
 */
async function keepSentPositions(
  deps: McpToolDependencies,
  definition: { id: number; layout: WorkflowDefinitionLayout; layoutRevision: number },
  graph: WorkflowDefinition,
  actor: ReturnType<typeof storeActor>,
): Promise<SaveDraftData["positions"]> {
  if (positionsCarryNoLayout(graph.nodes)) return "not_sent";
  const stored = normalizeWorkflowDefinitionLayout(definition.layout);
  const sent = Object.fromEntries(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  const unchanged = graph.nodes.every(
    (node) => stored.nodes[node.id]?.x === node.x && stored.nodes[node.id]?.y === node.y,
  );
  if (unchanged) return "unchanged";
  try {
    await deps.services.saveWorkflowDefinitionLayout({
      definitionId: definition.id,
      layout: { nodes: { ...stored.nodes, ...sent }, edges: stored.edges },
      expectedLayoutRevision: definition.layoutRevision,
      actor,
    });
    return "saved";
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        definitionId: definition.id,
        requestId: deps.requestId,
      },
      "mcp_save_draft_positions_not_saved",
    );
    return "not_saved";
  }
}

/** Where a definition's two compare-and-set revisions stand now. */
interface DefinitionHeads {
  draftRevision: number;
  deployedVersion: number | null;
}

/**
 * Read after a stale-revision refusal, so the refusal can say what the caller has
 * to send instead. Best effort: the refusal stands without it.
 */
async function currentHeads(
  deps: McpToolDependencies,
  definitionId: number,
): Promise<DefinitionHeads | undefined> {
  try {
    const definition = await deps.services.getWorkflowDefinition(definitionId);
    return definition
      ? { draftRevision: definition.draftRevision, deployedVersion: definition.deployedVersion }
      : undefined;
  } catch {
    return undefined;
  }
}

/** "Draft changed; reload before saving", "Definition changed; reload before
 *  deploying" and their kin: a compare-and-set that met a newer row. */
const STALE_REVISION = /; reload before \w+$/u;

function isStaleRevision(error: unknown): boolean {
  return (
    error instanceof WorkflowDefinitionStoreError &&
    error.statusCode === 409 &&
    STALE_REVISION.test(error.message)
  );
}

/** The step that gets a refused write through, by which conflict the store named. */
function conflictNextStep(message: string, heads: DefinitionHeads | undefined): string {
  if (STALE_REVISION.test(message)) {
    const where = heads
      ? ` It is now at draftRevision ${heads.draftRevision}, deployedVersion ${heads.deployedVersion ?? "null"}.`
      : "";
    return `${where} Read it again with workflows.get_graph and send the revisions it reports, with your change applied to the graph it returns.`;
  }
  if (message === "Name already in use") {
    return " Pick another name; workflows.list names the ones in use.";
  }
  if (message.startsWith("Its trigger")) {
    return " workflows.list shows which definitions are enabled; workflows.set_enabled turns one off.";
  }
  return "";
}

/** Over the canonical JSON of the graph, the same rule the payload hash and the
 * audit row hash by, so an agent can reproduce it from the bytes it sent. */
function graphDigest(definition: unknown): string {
  return `sha256:${hashCanonicalJson(definition)}`;
}

/**
 * The store's own refusals, mapped onto codes an agent can act on and forwarded
 * with their messages, which are fixed strings the dashboard already shows people:
 * a validation issue names the block and what is wrong with it, and no internal
 * path or stack goes anywhere near them.
 *
 * Every mapped status leaves the definition untouched, which is why all of them
 * hand the key back. 422 and 400 are raised before any statement runs; a 404 or a
 * 409 means the compare-and-set matched no row, and since the save and the deploy
 * are each a single SQL statement, a statement that selected nothing inserted and
 * updated nothing. Anything else is rethrown as it is, so the wrapper seals the
 * key: the 500s in this store are raised AFTER the head has already moved
 * (services/workflow-definitions/policy-operations.ts:758), and a key handed back
 * there would buy a second deployment.
 */
export function throwPublicStoreError(error: unknown, heads?: DefinitionHeads): never {
  // Before the base class below, which it extends: a deployment gate failure is a
  // 422 carrying the issues, not a generic conflict.
  if (error instanceof WorkflowDefinitionValidationError) {
    throw refusal(
      "VALIDATION_FAILED",
      `Workflow cannot be deployed: ${issueText(error.issues)}`,
    );
  }
  if (error instanceof WorkflowDefinitionStoreError) {
    // Redacted for the reason issueText is: policy-operations.ts builds a 400
    // from the deployment issues it resolved for an ADMIN, so the message can
    // name the variable an integration is missing. Unreachable only while
    // workflows.create seeds a null graph, which is not a property to rely on.
    if (error.statusCode === 400) {
      throw refusal("VALIDATION_FAILED", redactIntegrationVariableNames(error.message));
    }
    if (error.statusCode === 409 && error.message === RETIRED_SCHEMA_MESSAGE) {
      throw refusal("VALIDATION_FAILED", RETIRED_SCHEMA_MESSAGE);
    }
    if (error.statusCode === 404) {
      throw refusal("NOT_FOUND", redactIntegrationVariableNames(error.message));
    }
    // Not retryable: every conflict here meets the same row when the same call is
    // sent again (a newer draft, a name in use, a trigger another definition
    // holds, an archived definition). What the caller does instead is the next
    // step the message names.
    if (error.statusCode === 409) {
      const said = redactIntegrationVariableNames(error.message);
      const step = conflictNextStep(error.message, heads);
      throw refusal("CONFLICT", step ? `${said.replace(/\.?$/u, ".")}${step}` : said);
    }
  }
  throw error;
}

export function registerWorkflowAuthoringTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(
    server,
    "workflows.create",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.create",
        // The id does not exist yet, so the name is the only thing that names the
        // row this call is about, and it is what an operator searches the audit
        // trail by. A name is a label, never a graph.
        targetRefs: [input.name],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({ name: input.name })}`,
        operation: async (): Promise<CreateData> => {
          const actor = storeActor(deps.actor);
          let created: Awaited<ReturnType<typeof deps.services.createWorkflowDefinition>>;
          try {
            created = await deps.services.createWorkflowDefinition({
              name: input.name,
              // No seed on purpose. The dashboard's create seeds a default graph,
              // a template or a duplicate, and each of those is a choice about
              // what the workflow already does; an agent that wants a graph sends
              // one to save_draft, where it is validated like any other. An empty
              // definition is also inert: publish refuses it until a draft exists.
              seed: null,
              actor,
            });
          } catch (error) {
            throwPublicStoreError(error);
          }
          return {
            definitionId: created.definition.id,
            name: created.definition.name,
            draftRevision: created.definition.draftRevision,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "workflows.save_draft",
    async (input) => {
      // Read off the graph the caller sent, which is legitimate HERE and only here:
      // the pins are in the arguments, so no query is needed to count them and the
      // refs can be settled before the wrapper writes its "attempted" row. Like
      // every other ref it describes the ATTEMPT, and a row whose outcome is
      // VALIDATION_FAILED already says the graph it counted was never stored.
      const notEnabled = pinsNotEnabledInCatalog(
        input.definition,
        await deps.loadRepositoryCatalog(),
      );
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.save_draft",
        // Which definition, and which revision this save replaces. Never the
        // graph: targetRefs are stored verbatim (services/mcp/audit-store.ts:62), and the only
        // record this tool leaves of a graph is a digest.
        targetRefs: [
          String(input.definitionId),
          String(input.expectedDraftRevision),
          catalogRef(notEnabled),
        ],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({
          definitionId: input.definitionId,
          expectedDraftRevision: input.expectedDraftRevision,
          definition: input.definition,
        })}`,
        operation: async (): Promise<SaveDraftData> => {
          // The repo's own reader of an unknown candidate, the one the editor's
          // validate endpoint builds on (validate.post.ts:27, which adds prompt
          // authoring issues on top). The catalog schema in
          // front of this admitted the graph by SIZE only, because the transport
          // gate cannot load the block registry, so this is where the one
          // authority on a legal graph is applied, and the store then parses the
          // same schema again before it stores anything.
          //
          // Connected, so a graph the dashboard accepts is not refused here for
          // carrying a block of an integration this deployment has connected.
          // Agent-facing, so the issue a model reads back names the integration
          // and the page to fix it on, never the variable to paste a value into.
          const contracts = agentFacingBlockContracts(
            await deps.loadDeploymentIntegrations(),
          );
          const candidate = validateWorkflowDefinitionCandidate(
            input.definition,
            contracts.resolveContract,
            contracts.blockParamsSchemas,
            contracts.configuredVcsProviders,
            contracts.analyzeValues,
          );
          if (!candidate.parsed) {
            throw refusal(
              "VALIDATION_FAILED",
              declaresRetiredSchema(input.definition)
                ? RETIRED_SCHEMA_MESSAGE
                : `Invalid definition: ${issueText(candidate.response.issues)}`,
            );
          }
          // The DEPLOYMENT issues it also reports are deliberately not blocking
          // here: the dashboard saves a draft that is not yet deployable too, and
          // an agent building a graph in steps would otherwise be unable to store
          // work in progress. deployWorkflowDefinition is the gate, and publish is
          // where it speaks.
          const actor = storeActor(deps.actor);
          let saved: Awaited<ReturnType<typeof deps.services.saveWorkflowDefinitionDraft>>;
          try {
            saved = await deps.services.saveWorkflowDefinitionDraft({
              definitionId: input.definitionId,
              definition: candidate.parsed,
              // Compare-and-set, and unlike prompts.update this one IS atomic:
              // the expected revision is a predicate inside the store's single
              // insert statement (db/repositories/definitions/operations.ts:373), so a draft that moved on between
              // this call and the write selects no candidate row and nothing is
              // saved. Two agents, or an agent and a person in the editor, cannot
              // silently overwrite each other's graph.
              expectedDraftRevision: input.expectedDraftRevision,
              actor,
            });
          } catch (error) {
            throwPublicStoreError(
              error,
              isStaleRevision(error) ? await currentHeads(deps, input.definitionId) : undefined,
            );
          }
          // Read back rather than hashed from the request: the store canonicalizes a
          // graph before it stores it, so only the stored version can produce a
          // digest that means the same thing as the one publish reports. The
          // version row and not saved.draft, which has the editor's layout applied
          // over it and would hash to something no other reader sees.
          const stored = await deps.services.getWorkflowDefinitionVersion(
            saved.definition.id,
            saved.draftRevision,
          );
          if (!stored) {
            // The store just wrote this row and read it back itself
            // (services/workflow-definitions/policy-operations.ts:681-685),
            // so this is the row disappearing under us. Not retryable under the same
            // key, and not dressed up as a validation problem.
            //
            // NOT refusal(): that helper hard-codes effectNotApplied, which is the
            // one flag that hands the idempotency key back, and it is only true for
            // a refusal that provably wrote nothing. By this line the draft version
            // row exists, so releasing the key would buy a second write against
            // somebody's definition under the same key. Constructed directly to keep
            // effectNotApplied false and leave the lease held.
            throw new McpPublicError("CONFLICT", "Saved draft version was not readable", true);
          }
          const positions = await keepSentPositions(
            deps,
            saved.definition,
            candidate.parsed,
            actor,
          );
          // The graph is not echoed. This value is stored as the idempotency key's
          // response for its whole lifetime and hashed into the audit row's
          // outputHash, and a workflow graph belongs in neither.
          return {
            definitionId: saved.definition.id,
            draftRevision: saved.draftRevision,
            graphHash: graphDigest(stored.definition),
            pinnedRepositoriesNotEnabled: notEnabled,
            deployable: candidate.response.issues.length === 0,
            deploymentIssues: reportableIssues(candidate.response.issues),
            deploymentIssueCount: candidate.response.issues.length,
            positions,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "workflows.publish",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.publish",
        // Which definition, which draft revision goes live, and which deployment
        // it replaces: the three facts an operator needs to reconstruct what this
        // deployment changed. What the graph pins cannot be named from the
        // arguments, so it rides the outcome row through outcomeTargetRefs below
        // instead of being read out here, in front of the rate limiter, the
        // attempted row and the authorization check (execute-tool.ts:240-247).
        targetRefs: [
          String(input.definitionId),
          String(input.expectedDraftRevision),
          input.expectedDeployedVersion === null
            ? "none"
            : String(input.expectedDeployedVersion),
        ],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({
          definitionId: input.definitionId,
          expectedDraftRevision: input.expectedDraftRevision,
          expectedDeployedVersion: input.expectedDeployedVersion,
        })}`,
        // How many repositories the DEPLOYED graph pins that the catalog does not
        // enable, on the row that records the deployment. A refused publish
        // deployed nothing, so it has nothing to count.
        outcomeTargetRefs: (data) => [catalogRef(data.pinnedRepositoriesNotEnabled)],
        operation: async (): Promise<PublishData> => {
          const actor = storeActor(deps.actor);
          let deployed: Awaited<ReturnType<typeof deps.services.deployWorkflowDefinition>>;
          try {
            // deployWorkflowDefinition IS the dashboard's publish path, not a
            // layer under it: deploy.post.ts authenticates, parses the two
            // expected versions and calls exactly this, one wrapper down
            // (deploy.post.ts:55 into deployment.ts:44). The
            // gate, the compare-and-set on both versions, the trigger-ownership
            // claim, the webhook endpoint mint and the schedule sync all live in
            // the store, so this tool cannot be the way around any of them. Adding
            // a check here that the route does not do would be worse, not safer:
            // the two paths would then publish under different rules.
            deployed = await deps.services.deployWorkflowDefinition({
              definitionId: input.definitionId,
              expectedDraftRevision: input.expectedDraftRevision,
              expectedDeployedVersion: input.expectedDeployedVersion,
              actor,
            });
          } catch (error) {
            throwPublicStoreError(
              error,
              isStaleRevision(error) ? await currentHeads(deps, input.definitionId) : undefined,
            );
          }
          // Everything below reads the graph THIS deploy pinned, from the store's own
          // read of the version row, so the digest, the pins and the trigger nodes
          // all describe one snapshot rather than three reads of a moving target.
          const graph = deployed.version.definition;
          const notEnabled = pinsNotEnabledInCatalog(
            graph,
            await deps.loadRepositoryCatalog(),
          );
          const triggerNodeCount = triggerNodesOf(graph).length;
          let dormant: string[];
          try {
            dormant = await dormantTriggerNodes(
              deps.services,
              deployed.definition.id,
              graph,
              deployed.definition.enabled,
            );
          } catch (error) {
            // The deployment has landed; only the question "can it fire" is
            // unanswered. Reporting every trigger as unverified is the honest shape
            // of that, and it is strictly the direction that does not over-claim.
            // Raising instead would tell the caller a completed publish failed.
            logger.warn(
              {
                err: error instanceof Error ? error.message : String(error),
                definitionId: deployed.definition.id,
                requestId: deps.requestId,
              },
              "mcp_publish_trigger_liveness_unverified",
            );
            dormant = triggerNodesOf(graph).map((node) => node.id);
          }
          // Verified, not deduced: at least one trigger node of the published graph
          // was shown to have what it needs to fire.
          const liveOnRealEvents = triggerNodeCount > dormant.length;
          const replacedVersion = input.expectedDeployedVersion;
          // Announced from inside the operation, so a replay of the same
          // idempotency key answers from the stored response without telling the
          // channel twice, and only a deployment that landed is announced.
          await announceAuthoringChange(
            deps,
            publishAnnouncement({
              name: deployed.definition.name,
              definitionId: deployed.definition.id,
              deployedVersion: deployed.version.version,
              replacedVersion,
              draftAuthor:
                deployed.version.createdById === actor.id
                  ? null
                  : deployed.version.createdByLabel,
              enabled: deployed.definition.enabled,
              triggerTypes: deployed.definition.triggerTypes,
              dormant,
              liveOnRealEvents,
              notEnabled,
            }),
          );
          return {
            definitionId: deployed.definition.id,
            deployedVersion: deployed.version.version,
            replacedVersion,
            graphHash: graphDigest(graph),
            enabled: deployed.definition.enabled,
            triggerTypes: deployed.definition.triggerTypes,
            liveOnRealEvents,
            dormantTriggerNodeIds: dormant,
            pinnedRepositoriesNotEnabled: notEnabled,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}

/**
 * The two tools AIW-286 added, kept in their own registrar for one reason only:
 * tools/list enumerates in registration order and the contract publishes in
 * FIRST_SLICE_TOOLS order, so the two orders have to agree. These names were
 * appended to the END of that list to keep the published bytes of everything before
 * them unchanged, so server.ts registers this LAST, after runs.stats, rather than
 * beside create/save_draft/publish where the code would otherwise sit.
 *
 * workflows.get_graph is the read half of authoring: it returns an existing
 * definition's graph, draft and deployed, in the exact shape workflows.save_draft
 * takes back, with the two revision tokens a save and a publish are gated on.
 * workflows.set_enabled is the definition's own enable switch, the one field a
 * publish inherits rather than sets.
 */
export function registerWorkflowGraphTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(
    server,
    "workflows.get_graph",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "workflows.get_graph",
        targetRefs: [String(input.definitionId)],
        operation: async (): Promise<GraphData> => {
          const definition = await deps.services.getWorkflowDefinition(input.definitionId);
          // NOT_FOUND for the same two states the dashboard's GET route hides behind
          // a 404 ([id].get.ts): a missing row and an archived one. An archived
          // definition still has versions, but it is retired and cannot be saved or
          // published, so handing its graph back would only invite a write that the
          // store then refuses with "Definition is archived".
          if (!definition || definition.archivedAt) {
            throw new McpPublicError("NOT_FOUND", "Unknown definition", false);
          }
          // The head version IS the draft (every save appends a version and the max
          // is the draft head), and the deployed pointer names the live one. Both are
          // read through mapVersionRow, so their `.definition` is the canonical
          // {schemaVersion, nodes, edges} save_draft reads back and hashes -- not the
          // layout-applied draft shape returned for the editor,
          // which would hash to something no other reader sees.
          const [draftVersion, deployedVersion] = await Promise.all([
            deps.services.getCurrentWorkflowDefinitionVersion(input.definitionId),
            deps.services.getDeployedWorkflowDefinitionVersion(input.definitionId),
          ]);
          const draft = runnableDefinitionOf(draftVersion) ?? null;
          const deployedGraph = runnableDefinitionOf(deployedVersion) ?? null;
          const layout = normalizeWorkflowDefinitionLayout(definition.layout);
          const placed = (graph: WorkflowDefinition) =>
            applyWorkflowDefinitionLayout(graph, layout);
          return {
            definitionId: definition.id,
            name: definition.name,
            enabled: definition.enabled,
            draftRevision: definition.draftRevision,
            deployedVersion: definition.deployedVersion,
            draft: draft ? placed(draft) : null,
            deployed:
              deployedVersion?.schema === "legacy-v1"
                ? { schema: "legacy-v1" as const, message: RETIRED_SCHEMA_MESSAGE }
                : deployedGraph
                  ? placed(deployedGraph)
                  : null,
            // Over the stored version, not the placed one: the hash names the
            // graph, and where a node is drawn is not part of it.
            draftGraphHash: draft ? graphDigest(draft) : null,
            deployedGraphHash: deployedGraph ? graphDigest(deployedGraph) : null,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "workflows.set_enabled",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.set_enabled",
        // Which definition and which direction the switch was moved. Never the graph:
        // this tool does not touch one, and the direction is what an operator reading
        // the audit trail wants next to the id.
        targetRefs: [String(input.definitionId), input.enabled ? "enable" : "disable"],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({
          definitionId: input.definitionId,
          enabled: input.enabled,
        })}`,
        operation: async (): Promise<SetEnabledData> => {
          const actor = storeActor(deps.actor);
          let updated: Awaited<ReturnType<typeof deps.services.updateWorkflowDefinition>>;
          try {
            // updateWorkflowDefinition IS the dashboard's PATCH path
            // ([id].patch.ts:30, one wrapper down through definition-authoring.ts:161):
            // the deployable-version gate, the "one enabled owner
            // per trigger" overlap check that names the conflicting definition, the
            // compare-and-set on the definition row, and the webhook/schedule
            // arming of the live head all live in the store, so this tool cannot be
            // the way around any of them.
            updated = await deps.services.updateWorkflowDefinition({
              definitionId: input.definitionId,
              enabled: input.enabled,
              actor,
            });
          } catch (error) {
            throwPublicStoreError(error);
          }
          return {
            definitionId: updated.id,
            name: updated.name,
            enabled: updated.enabled,
            triggerTypes: updated.triggerTypes,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
