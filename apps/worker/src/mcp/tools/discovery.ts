import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, eq, inArray, isNull, max, or } from "drizzle-orm";
import { z } from "zod";

import {
  isManuallyDispatchableTrigger,
  TRIGGER_BLOCK_TYPES,
  type WorkflowBlockType,
} from "@shared/contracts";

import {
  promptLibrary,
  promptLibraryVersions,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../../db/schema.js";
import {
  findPromptBySlug,
  getCurrentPromptVersion,
  getPrompt,
} from "../../prompt-library/store.js";
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
          const rows = await deps.db
            .select({
              id: workflowDefinitions.id,
              name: workflowDefinitions.name,
              enabled: workflowDefinitions.enabled,
              deployedVersion: workflowDefinitions.deployedVersion,
            })
            .from(workflowDefinitions)
            .where(isNull(workflowDefinitions.archivedAt))
            .orderBy(asc(workflowDefinitions.id))
            // One extra row, unreturned, is how truncation is detected without a
            // second count query.
            .limit(limit + 1);

          const truncated = rows.length > limit;
          const page = truncated ? rows.slice(0, limit) : rows;

          // Triggers come from the DEPLOYED version, never the draft head,
          // because that is the snapshot a dispatch resolves against: offering a
          // node id that only exists in the draft would be an argument every
          // preflight refuses. One query for the whole page (the same
          // (id, version) OR-set prompt-library/store.ts:355 uses for its heads),
          // so the page costs two queries rather than one per definition.
          const deployed = page.filter((row) => row.deployedVersion != null);
          const versionRows =
            deployed.length === 0
              ? []
              : await deps.db
                  .select({
                    definitionId: workflowDefinitionVersions.definitionId,
                    definition: workflowDefinitionVersions.definition,
                  })
                  .from(workflowDefinitionVersions)
                  .where(
                    or(
                      ...deployed.map((row) =>
                        and(
                          eq(workflowDefinitionVersions.definitionId, row.id),
                          eq(workflowDefinitionVersions.version, row.deployedVersion!),
                        ),
                      ),
                    ),
                  );
          const triggersByDefinition = new Map(
            versionRows.map((row) => [row.definitionId, triggersOf(row.definition)]),
          );

          return {
            workflows: page.map((row) => ({
              definitionId: row.id,
              name: row.name,
              enabled: row.enabled,
              deployedVersion: row.deployedVersion,
              // Empty for a definition with no deployed version, and also for a
              // deployed pointer with no readable row behind it: both mean there
              // is nothing an agent can dispatch today.
              triggers: triggersByDefinition.get(row.id) ?? [],
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
          const rows = await deps.db
            .select({
              id: promptLibrary.id,
              slug: promptLibrary.slug,
              name: promptLibrary.name,
            })
            .from(promptLibrary)
            .where(isNull(promptLibrary.archivedAt))
            .orderBy(asc(promptLibrary.id))
            .limit(limit + 1);

          const truncated = rows.length > limit;
          const page = truncated ? rows.slice(0, limit) : rows;
          if (page.length === 0) return { prompts: [], truncated };

          const heads = await deps.db
            .select({
              promptId: promptLibraryVersions.promptId,
              currentVersion: max(promptLibraryVersions.version),
            })
            .from(promptLibraryVersions)
            .where(
              inArray(
                promptLibraryVersions.promptId,
                page.map((row) => row.id),
              ),
            )
            .groupBy(promptLibraryVersions.promptId);
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
              ? await findPromptBySlug(deps.db, input.slug)
              : await getPrompt(deps.db, input.promptId!);
          if (!prompt) throw new McpPublicError("NOT_FOUND", "Prompt not found", false);
          const version = await getCurrentPromptVersion(deps.db, prompt.id);
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
