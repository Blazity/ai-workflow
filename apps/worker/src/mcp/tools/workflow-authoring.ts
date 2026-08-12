import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";
import { workflowBlockRegistryContextFromEnv } from "../../workflow-definition/models.js";
import {
  createWorkflowDefinition,
  deployWorkflowDefinition,
  saveWorkflowDefinitionDraft,
  WorkflowDefinitionStoreError,
  WorkflowDefinitionValidationError,
} from "../../workflow-definition/store.js";
import { validateWorkflowDefinitionCandidate } from "../../workflow-definition/validation.js";
import type { McpToolDependencies } from "../contracts.js";
import { executeMcpMutation } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { registerCatalogTool } from "../tool-catalog.js";
import { refusal, storeActor } from "./authoring-support.js";

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
 *     store's own SQL rather than by a read here;
 *   - a new definition is created DISABLED, and nothing here can enable it, so an
 *     agent cannot arm a workflow against real ticket or pull request events.
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
  graphHash: string;
};

type PublishData = {
  definitionId: number;
  deployedVersion: number;
  // The definition's own enable switch, which publishing does not touch. False
  // means the ticket and pull request triggers in the graph just deployed still
  // ignore real events, and only a person can change that, so an agent is told
  // rather than left to assume a publish armed the workflow.
  enabled: boolean;
  triggerTypes: string[];
};

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
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.save_draft",
        // Which definition, and which revision this save replaces. Never the
        // graph: targetRefs are stored verbatim (audit-store.ts:58), and the only
        // record this tool leaves of a graph is a digest.
        targetRefs: [String(input.definitionId), String(input.expectedDraftRevision)],
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
          // The graph is not echoed. This value is stored as the idempotency key's
          // response for its whole lifetime and hashed into the audit row's
          // outputHash, and a workflow graph belongs in neither.
          return {
            definitionId: saved.definition.id,
            draftRevision: saved.draftRevision,
            graphHash: graphDigest(input.definition),
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
        // deployment changed.
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
          return {
            definitionId: deployed.definition.id,
            deployedVersion: deployed.version.version,
            enabled: deployed.definition.enabled,
            triggerTypes: deployed.definition.triggerTypes,
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
