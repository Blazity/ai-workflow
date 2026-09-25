import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WorkflowBlockContract, WorkflowBlockGroup } from "@shared/contracts";

import { blockConfigurationSchema } from "../block-configuration-schema.js";
import { agentFacingBlockContracts } from "../integration-facts.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { registerCatalogTool } from "../tool-catalog.js";

/**
 * One block as the list names it: enough to choose, never the contract.
 *
 * The whole contracts made this list 85 KB, which went out twice per call and
 * was written to a file by the client instead of shown to the model. An agent
 * picks a block from a line and reads the one it picked with blocks.get.
 */
type BlockSummary = {
  type: string;
  label: string;
  group: WorkflowBlockGroup;
  /** The integration that contributes the block, or null for core's own. */
  integration: string | null;
  purpose: string;
  available: boolean;
  unavailableReason: string | null;
};

type BlocksListData = {
  blocks: BlockSummary[];
};

type BlockDetail = WorkflowBlockContract & {
  /** JSON Schema of what a node of this type takes as `configuration`. */
  configurationSchema: Record<string, unknown>;
};

/** What `integration` names for core's own blocks. */
const CORE = "core";

/** A description's first sentence, on one line and bounded, which is what a
 *  reader choosing between forty blocks needs from it. */
const PURPOSE_MAX_LENGTH = 160;

function purposeOf(description: string): string {
  const flat = description.replace(/\s+/gu, " ").trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(flat)?.[1] ?? flat;
  return sentence.length <= PURPOSE_MAX_LENGTH
    ? sentence
    : `${sentence.slice(0, PURPOSE_MAX_LENGTH - 3).trimEnd()}...`;
}

// Credential-derived (which agent, VCS and messaging providers this deployment
// has configured) and cheap to recompute -- the same block data the dashboard's
// editor read binds on every load -- so it is read fresh per call rather than
// cached. A provider that comes online mid-process (a rotated token, a newly
// configured Slack channel) is then visible on the very next call instead of
// waiting for a restart. The agent default comes from the built-in Harness
// Profile because this catalog call has no run-specific profile.
async function readBlocks(deps: McpToolDependencies) {
  // Through the connected variant, so the catalog an agent reads holds the
  // blocks of the integrations this deployment has connected and says which of
  // them are usable. Reading the core-only map here would let an agent build a
  // graph the dashboard accepts and this tool's own save then refuses.
  //
  // Agent-facing: the verdict is the editor's own, and the sentence beside it
  // is the one a model may read. The admin's version names the variable that is
  // missing, which is the one thing ADR-010 decision 15 keeps off this surface.
  const deployment = await deps.loadDeploymentIntegrations();
  const contracts = agentFacingBlockContracts(deployment);
  return {
    registry: contracts.blockRegistry() as Record<string, WorkflowBlockContract>,
    paramsSchemas: contracts.blockParamsSchemas as Record<string, unknown>,
    integrationOf: (type: string) => deployment.blocks.get(type)?.integrationId ?? null,
  };
}

export function registerBlockTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "blocks.list",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "blocks.list",
        targetRefs: [input.group ?? "", input.integration ?? ""].filter(Boolean),
        operation: async (): Promise<BlocksListData> => {
          const { registry, integrationOf } = await readBlocks(deps);
          const blocks = Object.values(registry)
            .map((contract): BlockSummary => ({
              type: contract.type,
              label: contract.presentation.label,
              group: contract.presentation.group,
              integration: integrationOf(contract.type),
              purpose: purposeOf(contract.presentation.description),
              available: contract.availability.available,
              unavailableReason: contract.availability.unavailableReason,
            }))
            .filter((block) => input.group === undefined || block.group === input.group)
            .filter(
              (block) =>
                input.integration === undefined ||
                (block.integration ?? CORE) === input.integration,
            )
            .sort((a, b) => a.type.localeCompare(b.type));
          return { blocks };
        },
      });
      // No trust override: descriptions are this deployment's own copy today, but
      // the same envelope shape every other read answers with is one fewer thing
      // an agent has to special-case.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "blocks.get",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "blocks.get",
        targetRefs: [input.type],
        operation: async (): Promise<BlockDetail> => {
          const { registry, paramsSchemas } = await readBlocks(deps);
          const contract = registry[input.type];
          if (!contract) {
            throw new McpPublicError(
              "NOT_FOUND",
              // The type sent is not repeated back: it is the caller's text.
              "Unknown block type. blocks.list names every block type this deployment offers.",
              false,
            );
          }
          return {
            ...contract,
            configurationSchema: await blockConfigurationSchema(paramsSchemas[input.type]),
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
