import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  isManuallyDispatchableTrigger,
  RETIRED_SCHEMA_MESSAGE,
  TRIGGER_BLOCK_TYPES,
  type WorkflowBlockType,
} from "@shared/contracts";
import { isLegacyStoredWorkflowDefinition } from "../../services/mcp/app-dependencies.js";

import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { registerCatalogTool } from "../tool-catalog.js";

const DEFAULT_WORKFLOWS_LIMIT = 50;
const DEFAULT_PROMPTS_LIMIT = 50;

// Membership tests over stored strings, so the two shared helpers are never
// handed a value they would index a record with: isTriggerBlockType does exactly
// that (workflow-graph.ts:148) and throws on an unknown type, which a retired
// block in an old deployed graph would be.
const TRIGGER_TYPES: readonly string[] = TRIGGER_BLOCK_TYPES;

type WorkflowTrigger = {
  triggerNodeId: string;
  triggerType: string;
  // The other half of the trigger catalog fires from an approval, a signed
  // delivery or a clock (workflow-graph.ts:118), and a manual dispatch of one is
  // refused as not_eligible. Saying so here is what keeps an agent from paying a
  // preflight to find out.
  manuallyDispatchable: boolean;
};

type WorkflowListData = {
  workflows: Array<{
    definitionId: number;
    name: string;
    enabled: boolean;
    deployedVersion: number | null;
    deployedSchema: "v2" | "legacy-v1";
    retiredMessage?: typeof RETIRED_SCHEMA_MESSAGE;
    triggers: WorkflowTrigger[];
  }>;
  // Page-local, exactly as tickets.list_runs uses it: the page never claims to
  // be the whole list, and there is no total anywhere in this payload.
  truncated: boolean;
};

type PromptListData = {
  prompts: Array<{
    promptId: number;
    slug: string;
    name: string;
    currentVersion: number;
  }>;
  truncated: boolean;
};

type PromptGetData = {
  promptId: number;
  slug: string;
  name: string;
  version: number;
  body: string;
  archived: boolean;
};

// The two fields a dispatch needs, read structurally rather than through
// upgradeStoredWorkflowDefinition: that one parses the whole graph and THROWS on
// a stored shape today's schema no longer accepts, which would turn one retired
// block in one deployed version into an INTERNAL_ERROR for the entire page. Both
// stored schema versions keep nodes as { id, type, ... }, so these are the same
// node ids manual-dispatch resolves against (manual-dispatch/resolve.ts:144).
// Same shape of minimal structural read as prompt-library/store.ts:44.
const graphScanSchema = z
  .object({ nodes: z.array(z.unknown()).catch([]) })
  .catch({ nodes: [] });
const graphNodeSchema = z.object({ id: z.string().min(1), type: z.string().min(1) });

function triggersOf(storedDefinition: unknown): WorkflowTrigger[] {
  const triggers: WorkflowTrigger[] = [];
  for (const node of graphScanSchema.parse(storedDefinition).nodes) {
    const parsed = graphNodeSchema.safeParse(node);
    if (!parsed.success || !TRIGGER_TYPES.includes(parsed.data.type)) continue;
    triggers.push({
      triggerNodeId: parsed.data.id,
      triggerType: parsed.data.type,
      manuallyDispatchable: isManuallyDispatchableTrigger(
        parsed.data.type as WorkflowBlockType,
      ),
    });
  }
  return triggers;
}

export function registerDiscoveryTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "workflows.list",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "workflows.list",
        targetRefs: [],
        operation: async (): Promise<WorkflowListData> => {
          const limit = input.limit ?? DEFAULT_WORKFLOWS_LIMIT;
          // Deliberately not listWorkflowDefinitions: it has no SQL LIMIT, it
          // rolls a max(version) up over every definition's whole history, and it
          // carries canvas layout blobs this payload has no use for. Slicing its
          // answer afterwards is the mistake this slice already had to fix once.
          const rows = await deps.services.listWorkflowDefinitionPage(limit);

          const truncated = rows.length > limit;
          const page = truncated ? rows.slice(0, limit) : rows;

          // Triggers come from the DEPLOYED version, never the draft head,
          // because that is the snapshot a dispatch resolves against: offering a
          // node id that only exists in the draft would be an argument every
          // preflight refuses. One query for the whole page (the same
          // (id, version) OR-set prompt-library/store.ts:355 uses for its heads),
          // so the page costs two queries rather than one per definition.
          const deployed = page.filter((row) => row.deployedVersion != null);
          const versionRows = await deps.services.readDeployedDefinitionVersions(
            deployed.map((row) => ({
              definitionId: row.id,
              version: row.deployedVersion!,
            })),
          );
          const deploymentByDefinition = new Map<
            number,
            {
              deployedSchema: "v2" | "legacy-v1";
              retiredMessage?: typeof RETIRED_SCHEMA_MESSAGE;
              triggers: WorkflowTrigger[];
            }
          >(
            versionRows.map((row) => {
              const retired = isLegacyStoredWorkflowDefinition(row.definition);
              return [
                row.definitionId,
                retired
                  ? {
                      deployedSchema: "legacy-v1" as const,
                      retiredMessage: RETIRED_SCHEMA_MESSAGE,
                      triggers: [],
                    }
                  : {
                      deployedSchema: "v2" as const,
                      triggers: triggersOf(row.definition),
                    },
              ];
            }),
          );

          return {
            workflows: page.map((row) => ({
              definitionId: row.id,
              name: row.name,
              enabled: row.enabled,
              deployedVersion: row.deployedVersion,
              deployedSchema:
                deploymentByDefinition.get(row.id)?.deployedSchema ?? "v2",
              ...(deploymentByDefinition.get(row.id)?.retiredMessage
                ? {
                    retiredMessage:
                      deploymentByDefinition.get(row.id)!.retiredMessage,
                  }
                : {}),
              // Empty for a definition with no deployed version, and also for a
              // deployed pointer with no readable row behind it: both mean there
              // is nothing an agent can dispatch today.
              triggers: deploymentByDefinition.get(row.id)?.triggers ?? [],
            })),
            truncated,
          };
        },
      });
      // No trust override: a workflow's name and its node ids are text somebody
      // typed into the editor.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "prompts.list",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "prompts.list",
        targetRefs: [],
        operation: async (): Promise<PromptListData> => {
          const limit = input.limit ?? DEFAULT_PROMPTS_LIMIT;
          // Not listPrompts either, for the same reason plus one more: it pulls
          // every prompt's head BODY (up to 50k each) to build its list rows, and
          // this list returns no bodies at all.
          const rows = await deps.services.listPromptPage(limit);

          const truncated = rows.length > limit;
          const page = truncated ? rows.slice(0, limit) : rows;
          if (page.length === 0) return { prompts: [], truncated };

          const heads = await deps.services.readPromptHeadVersions(
            page.map((row) => row.id),
          );
          const versionByPrompt = new Map(
            heads.map((head) => [head.promptId, head.currentVersion]),
          );

          const prompts: PromptListData["prompts"] = [];
          for (const row of page) {
            const currentVersion = versionByPrompt.get(row.id);
            // A prompt with no version at all is an orphan row that prompts.get
            // could not serve either, so the list drops it exactly as the
            // dashboard's own list does (prompt-library/store.ts:378).
            if (currentVersion == null) continue;
            prompts.push({
              promptId: row.id,
              slug: row.slug,
              name: row.name,
              currentVersion,
            });
          }
          return { prompts, truncated };
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
    "prompts.get",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "prompts.get",
        targetRefs: input.slug === undefined
          ? input.promptId === undefined
            ? []
            : [String(input.promptId)]
          : [input.slug],
        operation: async (): Promise<PromptGetData> => {
          // Enforced here because the catalog can only hold a strict object: the
          // message names both fields, since neither the gate nor the SDK can say
          // which one is missing when the rule is "exactly one".
          if ((input.promptId === undefined) === (input.slug === undefined)) {
            throw new McpPublicError(
              "VALIDATION_FAILED",
              "Send exactly one of promptId or slug.",
              false,
            );
          }
          const prompt =
            input.slug !== undefined
              ? await deps.services.findPromptBySlug(input.slug)
              : await deps.services.getPrompt(input.promptId!);
          if (!prompt) throw new McpPublicError("NOT_FOUND", "Prompt not found", false);
          const version = await deps.services.getCurrentPromptVersion(prompt.id);
          // Distinct message from the one above: the prompt exists and the agent
          // did name it correctly, so retrying under another id or slug would
          // only take it further from the truth.
          if (!version) {
            throw new McpPublicError("NOT_FOUND", "Prompt has no current version", false);
          }
          return {
            promptId: prompt.id,
            slug: prompt.slug,
            name: prompt.name,
            version: version.version,
            body: version.body,
            archived: prompt.archivedAt !== null,
          };
        },
      });
      // A prompt body is instruction-shaped by construction, and it stays
      // external_untrusted for exactly that reason: it is the text a run will be
      // given, not text this agent was told to follow.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
