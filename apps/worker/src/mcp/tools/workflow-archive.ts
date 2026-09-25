/**
 * Archiving a workflow, and taking the archive back.
 *
 * The dashboard's workflow editor calls this Delete, and it has only ever
 * archived: the row keeps every version and leaves every list. So the tools are
 * named for what happens, and the second one exists because an archive an
 * agent cannot undo would be a delete in all but name.
 *
 * Both go through the definitions service's own policy functions, the ones the
 * dashboard's DELETE reaches (`archiveConnectedWorkflowDefinition`, through
 * `definition-authoring.ts`), so the editor gate, the refusal of an enabled
 * definition and of the last live one, and the name rule on the way back are
 * the store's, never this file's. Nothing here adds a check the route does not
 * make: the two paths would then archive under different rules.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolDependencies } from "../contracts.js";
import { executeMcpMutation } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { mcpEnvelopeResult, registerCatalogTool } from "../tool-catalog.js";
import { storeActor } from "./authoring-support.js";
import { throwPublicStoreError } from "./workflow-authoring.js";

type ArchiveData = {
  definitionId: number;
  name: string;
  /** Read off the row the store returned rather than asserted, so a reply can
   *  never claim an archive that somebody took back in the same instant. */
  archived: boolean;
  archivedAt: string | null;
};

type UnarchiveData = {
  definitionId: number;
  name: string;
  archived: boolean;
  enabled: boolean;
  deployedVersion: number | null;
  draftRevision: number;
};

export function registerWorkflowArchiveTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(server, "workflows.archive", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "workflows.archive",
      targetRefs: [String(input.definitionId)],
      idempotencyKey: input.idempotencyKey,
      payloadHash: `sha256:${hashCanonicalJson({ definitionId: input.definitionId })}`,
      operation: async (): Promise<ArchiveData> => {
        let archived: Awaited<ReturnType<typeof deps.services.archiveWorkflowDefinition>>;
        try {
          archived = await deps.services.archiveWorkflowDefinition({
            definitionId: input.definitionId,
            actor: storeActor(deps.actor),
          });
        } catch (error) {
          throwPublicStoreError(error);
        }
        return {
          definitionId: archived.id,
          name: archived.name,
          archived: archived.archivedAt !== null,
          archivedAt: archived.archivedAt?.toISOString() ?? null,
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "workflows.unarchive", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "workflows.unarchive",
      targetRefs: [String(input.definitionId)],
      idempotencyKey: input.idempotencyKey,
      payloadHash: `sha256:${hashCanonicalJson({ definitionId: input.definitionId })}`,
      operation: async (): Promise<UnarchiveData> => {
        let restored: Awaited<ReturnType<typeof deps.services.unarchiveWorkflowDefinition>>;
        try {
          restored = await deps.services.unarchiveWorkflowDefinition({
            definitionId: input.definitionId,
            actor: storeActor(deps.actor),
          });
        } catch (error) {
          throwPublicStoreError(error);
        }
        return {
          definitionId: restored.id,
          name: restored.name,
          archived: restored.archivedAt !== null,
          enabled: restored.enabled,
          deployedVersion: restored.deployedVersion,
          draftRevision: restored.draftRevision,
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}
