import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { isTriggerBlockType } from "@shared/contracts";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import { env } from "../../../env.js";
import { workflowDefinitionUrl } from "../../lib/dashboard-links.js";
import { logger } from "../../lib/logger.js";
import { isRepoAllowed } from "../../lib/repo-allowlist.js";
import { listSchedulesForDefinition } from "../../schedule-trigger/schedule-store.js";
import { getWebhookEndpointForNode } from "../../webhook-trigger/endpoint-store.js";
import type { Db } from "../../db/client.js";
import { workflowBlockRegistryContextFromEnv } from "../../workflow-definition/models.js";
import {
  createWorkflowDefinition,
  deployWorkflowDefinition,
  getCurrentWorkflowDefinitionVersion,
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
  saveWorkflowDefinitionDraft,
  updateWorkflowDefinition,
  WorkflowDefinitionStoreError,
  WorkflowDefinitionValidationError,
} from "../../workflow-definition/store.js";
import { validateWorkflowDefinitionCandidate } from "../../workflow-definition/validation.js";
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
 *     (policy.ts), with request-context.ts stripping the scope out of an
 *     unattended token's actor;
 *   - every graph goes through workflow-definition/schema.ts, and a publish
 *     through the deployment gate inside deployWorkflowDefinition, which is the
 *     whole of what the dashboard's Deploy button calls
 *     (routes/api/v1/workflow-definitions/[id]/deploy.post.ts:51);
 *   - compare-and-set on both writes that touch existing state, enforced by the
 *     store's own SQL rather than by a read here.
 *
 * What none of that does is keep a publish away from live traffic, and this module
 * used to claim it did. workflows.create makes a DISABLED definition and nothing
 * here flips that switch, but workflows.publish takes any definitionId: publishing
 * into a definition an operator has ALREADY enabled replaces what the platform
 * executes for real events at once, because dispatch resolves the deployed version
 * live (store.ts:605-612) and the deploy claims that definition's trigger bindings
 * on the way past (store.ts:1178-1185). `enabled` in the reply is therefore
 * inherited from the definition and not a verdict on the publish, and
 * `liveOnRealEvents` is the field that says which of the two just happened.
 *
 * The role gate answers "who", not "on whose behalf": an admin token whose agent
 * has just read a ticket marked external_untrusted is the actor this cannot tell
 * apart from any other. So both writes report what a graph pins beyond the
 * operator's AGENT_ALLOWED_REPOS, and a publish is announced to the operators'
 * channel, on the principle that the answer to a legitimate client doing something
 * consequential is to make it visible rather than to forbid it.
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
  // the store canonicalizes a graph on its way in (store.ts:859), so a digest of
  // the request would disagree with the digest workflows.publish reports for the
  // very same version and neither agent nor operator could tell which one moved.
  graphHash: string;
  // See repositoriesOutsideAllowlist below. Reported on a draft too, because the
  // draft is where the pin is chosen and the publish is where it starts being
  // acted on, and an operator reading the audit trail backwards wants both.
  repositoriesOutsideAllowlist: string[];
};

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
  // deploy has no business overriding, store.ts:1003-1004) or revoked; a webhook
  // node with no endpoint row, which is what a deployment without
  // WEBHOOK_TRIGGER_ENCRYPTION_KEY leaves behind (store.ts:973); and, honestly
  // rather than optimistically, every trigger node when the check itself could not
  // be run.
  dormantTriggerNodeIds: string[];
  // "provider:owner/repo" for every repository the published graph PINS that
  // AGENT_ALLOWED_REPOS does not itself permit. A pinned repository extends that
  // allowlist by design (lib/repo-allowlist.ts:89-103) and the deployment gate
  // checks a graph's shape rather than this permission, so a publish that widens
  // what the platform will clone and open pull requests on says so here. Empty
  // whenever no allowlist is configured, because then nothing is outside one: that
  // fail-open default is the multi-repo product default, and repo-allowlist.ts
  // warns about it where it is read.
  //
  // Worth knowing where these strings then live: this whole value is stored as the
  // idempotency key's response for the key's lifetime (idempotency-store.ts), so a
  // repository path outlives the call in that row. It is not in the audit row,
  // which carries the count alone.
  repositoriesOutsideAllowlist: string[];
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
  // save_draft hashes (mapVersionRow, no editor layout applied over them), so
  // re-saving an unmodified draft canonicalizes to the same bytes and the same hash.
  draft: WorkflowDefinition | null;
  deployed: WorkflowDefinition | null;
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
 * The pinned repositories the global allowlist does not already permit, read off a
 * graph. isRepoAllowed is the platform's own predicate and is deliberately not
 * reimplemented here: it owns the empty-means-unrestricted default and the
 * case-insensitive comparison, and a second copy of either would eventually
 * disagree with the adapters that enforce it.
 *
 * Takes `unknown` because one caller holds a graph nobody has parsed yet: on the
 * draft path the schema has not run when the reply is composed, so a pin whose
 * provider is not even a string still has to produce a label rather than a crash.
 */
function pinsOutsideAllowlist(definition: unknown): string[] {
  const scope = (definition as { repositoryScope?: unknown } | null | undefined)
    ?.repositoryScope;
  const pinned = (scope as { repositories?: unknown } | null | undefined)?.repositories;
  if (!Array.isArray(pinned)) return [];
  const outside: string[] = [];
  for (const entry of pinned) {
    const repository = entry as { provider?: unknown; repoPath?: unknown };
    if (typeof repository.repoPath !== "string") continue;
    if (isRepoAllowed(repository.repoPath)) continue;
    outside.push(
      typeof repository.provider === "string"
        ? `${repository.provider}:${repository.repoPath}`
        : repository.repoPath,
    );
  }
  return outside;
}

/**
 * The audit row's own signal for the finding above, as one more targetRef. A flag
 * and a count and nothing else: targetRefs are stored verbatim
 * (audit-store.ts:58), so the repository paths stay in the reply and the channel,
 * where a person reads them once, rather than in a table kept for a year. Always
 * appended, including as ":0", so a row proves the check ran instead of leaving an
 * operator unable to tell "nothing outside the allowlist" from "nobody looked".
 */
function allowlistRef(outside: readonly string[]): string {
  return `repos_outside_allowlist:${outside.length}`;
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
 *     store.ts:981) and an endpoint an operator revoked;
 *   - every other trigger type routes through the binding table, which THIS deploy
 *     claimed in the same statement that moved the head, for an enabled definition
 *     (store.ts:1178-1185). That one is established by the deploy having succeeded.
 *
 * A disabled definition reaches none of them, so all of its trigger nodes are
 * dormant.
 */
async function dormantTriggerNodes(
  db: Db,
  definitionId: number,
  graph: WorkflowDefinition,
  enabled: boolean,
): Promise<string[]> {
  const triggers = triggerNodesOf(graph);
  if (!enabled) return triggers.map((node) => node.id);

  const dormant: string[] = [];
  const scheduleRows = triggers.some((node) => node.type === "trigger_schedule")
    ? await listSchedulesForDefinition(db, definitionId)
    : [];
  for (const node of triggers) {
    if (node.type === "trigger_schedule") {
      const row = scheduleRows.find((schedule) => schedule.nodeId === node.id);
      if (!row || row.pausedAt !== null || row.revokedAt !== null) dormant.push(node.id);
      continue;
    }
    if (node.type === "trigger_webhook") {
      const endpoint = await getWebhookEndpointForNode(db, definitionId, node.id);
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
  outsideAllowlist: string[];
}): string {
  const name = announcementLabel(publish.name);
  const target = `workflow "${name}" (definition ${publish.definitionId})`;
  const sentences: string[] = [];
  sentences.push(
    publish.replacedVersion === publish.deployedVersion
      ? `re-deployed version ${publish.deployedVersion} of ${target} without changing which version is live.`
      : `published ${target} as version ${publish.deployedVersion}${
          publish.replacedVersion === null
            ? ""
            : `, replacing version ${publish.replacedVersion}`
        }.`,
  );
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
  if (publish.outsideAllowlist.length > 0) {
    sentences.push(
      `It pins ${publish.outsideAllowlist.length === 1 ? "a repository" : `${publish.outsideAllowlist.length} repositories`} outside AGENT_ALLOWED_REPOS: ${publish.outsideAllowlist
        .map((repository) => announcementLabel(repository))
        .join(", ")}.`,
    );
  }
  const link = `<${workflowDefinitionUrl(env.DASHBOARD_ORIGIN, publish.definitionId)}|open in the editor>`;
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
  return issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
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
 * (store.ts:1208), and a key handed back there would buy a second deployment.
 */
function throwPublicStoreError(error: unknown): never {
  // Before the base class below, which it extends: a deployment gate failure is a
  // 422 carrying the issues, not a generic conflict.
  if (error instanceof WorkflowDefinitionValidationError) {
    throw refusal(
      "VALIDATION_FAILED",
      `Workflow cannot be deployed: ${issueText(error.issues)}`,
    );
  }
  if (error instanceof WorkflowDefinitionStoreError) {
    if (error.statusCode === 400) throw refusal("VALIDATION_FAILED", error.message);
    if (error.statusCode === 404) throw refusal("NOT_FOUND", error.message);
    // Retryable because the message says which conflict it is: a draft that moved
    // on is worth re-reading and re-sending, an archived definition is not.
    if (error.statusCode === 409) throw refusal("CONFLICT", error.message, true);
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
          let created: Awaited<ReturnType<typeof createWorkflowDefinition>>;
          try {
            created = await createWorkflowDefinition(deps.db, {
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
      const outsideAllowlist = pinsOutsideAllowlist(input.definition);
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.save_draft",
        // Which definition, and which revision this save replaces. Never the
        // graph: targetRefs are stored verbatim (audit-store.ts:58), and the only
        // record this tool leaves of a graph is a digest.
        targetRefs: [
          String(input.definitionId),
          String(input.expectedDraftRevision),
          allowlistRef(outsideAllowlist),
        ],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({
          definitionId: input.definitionId,
          expectedDraftRevision: input.expectedDraftRevision,
          definition: input.definition,
        })}`,
        operation: async (): Promise<SaveDraftData> => {
          // The repo's own reader of an unknown candidate, the one the editor's
          // validate endpoint calls (validate.post.ts:14). The catalog schema in
          // front of this admitted the graph by SIZE only, because the transport
          // gate cannot load the block registry, so this is where the one
          // authority on a legal graph is applied, and the store then parses the
          // same schema again before it stores anything.
          //
          // Not workflowDefinitionSchema directly, which is a union of the two
          // stored shapes: a union failure says "invalid_union" at the root and
          // nothing else, and an agent cannot fix a graph from that. This picks
          // the branch the candidate's own schemaVersion names, so every issue
          // arrives against the block it belongs to.
          const candidate = validateWorkflowDefinitionCandidate(
            input.definition,
            workflowBlockRegistryContextFromEnv(),
          );
          if (!candidate.parsed) {
            throw refusal(
              "VALIDATION_FAILED",
              `Invalid definition: ${issueText(candidate.response.issues)}`,
            );
          }
          // The DEPLOYMENT issues it also reports are deliberately not blocking
          // here: the dashboard saves a draft that is not yet deployable too, and
          // an agent building a graph in steps would otherwise be unable to store
          // work in progress. deployWorkflowDefinition is the gate, and publish is
          // where it speaks.
          const actor = storeActor(deps.actor);
          let saved: Awaited<ReturnType<typeof saveWorkflowDefinitionDraft>>;
          try {
            saved = await saveWorkflowDefinitionDraft(deps.db, {
              definitionId: input.definitionId,
              definition: candidate.parsed,
              // Compare-and-set, and unlike prompts.update this one IS atomic:
              // the expected revision is a predicate inside the store's single
              // insert statement (store.ts:868), so a draft that moved on between
              // this call and the write selects no candidate row and nothing is
              // saved. Two agents, or an agent and a person in the editor, cannot
              // silently overwrite each other's graph.
              expectedDraftRevision: input.expectedDraftRevision,
              actor,
            });
          } catch (error) {
            throwPublicStoreError(error);
          }
          // Read back rather than hashed from the request: the store canonicalizes a
          // graph before it stores it, so only the stored version can produce a
          // digest that means the same thing as the one publish reports. The
          // version row and not saved.draft, which has the editor's layout applied
          // over it and would hash to something no other reader sees.
          const stored = await getWorkflowDefinitionVersion(
            deps.db,
            saved.definition.id,
            saved.draftRevision,
          );
          if (!stored) {
            // The store just wrote this row and read it back itself (store.ts:900),
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
          // The graph is not echoed. This value is stored as the idempotency key's
          // response for its whole lifetime and hashed into the audit row's
          // outputHash, and a workflow graph belongs in neither.
          return {
            definitionId: saved.definition.id,
            draftRevision: saved.draftRevision,
            graphHash: graphDigest(stored.definition),
            repositoriesOutsideAllowlist: outsideAllowlist,
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
        // attempted row and the authorization check (execute-tool.ts:210-224).
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
        // How many repositories the DEPLOYED graph pins past the allowlist, on the
        // row that records the deployment. A refused publish deployed nothing, so
        // it has nothing to count.
        outcomeTargetRefs: (data) => [allowlistRef(data.repositoriesOutsideAllowlist)],
        operation: async (): Promise<PublishData> => {
          const actor = storeActor(deps.actor);
          let deployed: Awaited<ReturnType<typeof deployWorkflowDefinition>>;
          try {
            // deployWorkflowDefinition IS the dashboard's publish path, not a
            // layer under it: deploy.post.ts authenticates, parses the two
            // expected versions and calls exactly this (deploy.post.ts:51). The
            // gate, the compare-and-set on both versions, the trigger-ownership
            // claim, the webhook endpoint mint and the schedule sync all live in
            // the store, so this tool cannot be the way around any of them. Adding
            // a check here that the route does not do would be worse, not safer:
            // the two paths would then publish under different rules.
            deployed = await deployWorkflowDefinition(deps.db, {
              definitionId: input.definitionId,
              expectedDraftRevision: input.expectedDraftRevision,
              expectedDeployedVersion: input.expectedDeployedVersion,
              actor,
            });
          } catch (error) {
            throwPublicStoreError(error);
          }
          // Everything below reads the graph THIS deploy pinned, from the store's own
          // read of the version row, so the digest, the pins and the trigger nodes
          // all describe one snapshot rather than three reads of a moving target.
          const graph = deployed.version.definition;
          const outsideAllowlist = pinsOutsideAllowlist(graph);
          const triggerNodeCount = triggerNodesOf(graph).length;
          let dormant: string[];
          try {
            dormant = await dormantTriggerNodes(
              deps.db,
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
              outsideAllowlist,
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
            repositoriesOutsideAllowlist: outsideAllowlist,
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
          const definition = await getWorkflowDefinition(deps.db, input.definitionId);
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
          // layout-applied shape getWorkflowDefinitionDraft returns for the editor,
          // which would hash to something no other reader sees.
          const [draftVersion, deployedVersion] = await Promise.all([
            getCurrentWorkflowDefinitionVersion(deps.db, input.definitionId),
            getDeployedWorkflowDefinitionVersion(deps.db, input.definitionId),
          ]);
          const draft = draftVersion?.definition ?? null;
          const deployed = deployedVersion?.definition ?? null;
          return {
            definitionId: definition.id,
            name: definition.name,
            enabled: definition.enabled,
            draftRevision: definition.draftRevision,
            deployedVersion: definition.deployedVersion,
            draft,
            deployed,
            draftGraphHash: draft ? graphDigest(draft) : null,
            deployedGraphHash: deployed ? graphDigest(deployed) : null,
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
          let updated: Awaited<ReturnType<typeof updateWorkflowDefinition>>;
          try {
            // updateWorkflowDefinition IS the dashboard's PATCH path
            // ([id].patch.ts:41): the deployable-version gate, the "one enabled owner
            // per trigger" overlap check that names the conflicting definition, the
            // compare-and-set on the definition row, and the webhook/schedule
            // arming of the live head all live in the store, so this tool cannot be
            // the way around any of them.
            updated = await updateWorkflowDefinition(deps.db, {
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
