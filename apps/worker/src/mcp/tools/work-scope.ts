/**
 * The work scope record, as tools.
 *
 * Two, for the two things a person does with it: read which repositories a
 * subject's work may touch and how that was decided, and change it. They are the
 * MCP half of the same pair of HTTP routes, under the same rules, because every
 * dashboard action on this record has an equivalent here.
 *
 * The service cluster is the seam, never the route handler. Both calls go
 * through `services/work-scope`, which is where the decision table, the catalog
 * bound and the optimistic version check live, so a tool cannot reach the tables
 * past a rule the dashboard obeys. The routes above that service do status codes
 * and nothing else, and this file does MCP error codes and nothing else.
 *
 * One deliberate difference from the dashboard, and it is not a rule: the label
 * recorded on an entry names the MCP client rather than a person's own name, so
 * a person reading the record later can tell an agent's edit from a colleague's.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  workScopeEditRequestSchema,
  type WorkScopeEntry,
  type WorkScopeTrailRow,
} from "@shared/contracts";
import {
  applyConnectedWorkScopeEdit,
  readConnectedWorkScopeRecord,
} from "../../services/work-scope/index.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { mcpEnvelopeResult, registerCatalogTool } from "../tool-catalog.js";

type WorkScopeRecordData = {
  subjectKey: string;
  carriesRecord: boolean;
  version: number;
  entries: WorkScopeEntry[];
  trail: WorkScopeTrailRow[];
  nextTrailBeforeId: number | null;
};

type WorkScopeEditData = {
  scope: { subjectKey: string; version: number; entries: WorkScopeEntry[] };
};

/** Refused before anything was written, so the idempotency key is unspent and a
 *  corrected call may reuse it. */
function refused(code: McpPublicError["code"], message: string): McpPublicError {
  return new McpPublicError(code, message, false, undefined, true);
}

export function registerWorkScopeTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(server, "work_scope.get", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "work_scope.get",
      targetRefs: [input.subjectKey],
      // A subject kind that keeps no record answers `carriesRecord: false`
      // rather than an error: an agent asking whether a subject carries one is
      // entitled to the answer, and a read cannot cause a bad write.
      operation: async (): Promise<WorkScopeRecordData> =>
        readConnectedWorkScopeRecord({
          subjectKey: input.subjectKey,
          trail: {
            ...(input.trailLimit === undefined ? {} : { limit: input.trailLimit }),
            ...(input.trailBefore === undefined ? {} : { beforeId: input.trailBefore }),
          },
        }),
    });
    // No trust override: a rationale is typed by a person and a repository key
    // comes from a catalog an operator filled in, so the default
    // external_untrusted is the honest label for both.
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "work_scope.edit", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "work_scope.edit",
      // The subject, and every repository the call decides about. Both are
      // identifiers an operator can search the audit for; the rationale is not,
      // and stays in the payload digest.
      targetRefs: [input.subjectKey, ...input.changes.map((change) => change.repositoryKey)],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async (): Promise<WorkScopeEditData> => {
        // The catalog schema bounds the lengths; this is what decides the shape,
        // so a repository key that is not one is refused here rather than
        // recorded as an entry nothing can ever match.
        const parsed = workScopeEditRequestSchema.safeParse({
          subjectKey: input.subjectKey,
          expectedVersion: input.expectedVersion,
          changes: input.changes.map((change) => ({
            repositoryKey: change.repositoryKey,
            action: change.action,
            ...(change.rationale === undefined ? {} : { rationale: change.rationale }),
          })),
        });
        if (!parsed.success) {
          throw refused(
            "VALIDATION_FAILED",
            `This edit is not a shape the record accepts: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")} ${issue.message}`)
              .join("; ")}`,
          );
        }
        const outcome = await applyConnectedWorkScopeEdit({
          request: parsed.data,
          editor: {
            // The policy for this tool refuses the service role, so there is a
            // person behind userId; the fallback keeps the type honest rather
            // than covering a case that can reach here.
            id: deps.actor.userId ?? deps.actor.subject,
            label: `MCP ${deps.actor.clientId}`,
          },
          now: deps.now(),
        });
        switch (outcome.kind) {
          case "applied":
            return { scope: outcome.scope };
          case "conflict":
            // The route answers this one with a body, because the version to
            // read again is the whole point of the refusal. MCP has no payload
            // channel on an error, so the version is stated in the sentence
            // instead of being left for the caller to go and look up.
            throw refused(
              "CONFLICT",
              `This subject's work scope is at version ${outcome.latestVersion}, not the expectedVersion you sent. Somebody wrote since you read it. Nothing was written. Read work_scope.get again and decide against what it now says.`,
            );
          case "not_enabled":
            throw refused(
              "VALIDATION_FAILED",
              `The repository catalog does not enable ${outcome.repositoryKeys.join(", ")}, so the whole edit was refused and nothing was written. Enable it with repositories.set_enabled, or leave it out of this edit.`,
            );
          case "subject_carries_no_record":
            throw refused(
              "VALIDATION_FAILED",
              `${outcome.subjectKey} carries no work scope record, so there is nothing to edit. Only a ticket, a pull request and a webhook delivery with a resolved subject keep one.`,
            );
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}
