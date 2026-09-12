import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as contracts from "@shared/contracts";

/**
 * Every request body this worker accepts, and what validates it.
 *
 * A grep for the typed `readBody<T>` form proves only that nobody is asserting a
 * shape they never checked. It cannot prove the opposite, that a body is
 * actually validated, so this table does: every handler that reads a JSON body
 * appears in JSON_BODY_SCHEMAS with the contract schema that parses it, and
 * every handler that reads something else appears in NO_JSON_BODY with the
 * reason no JSON schema applies. A new route that lands in neither fails here,
 * which is the point: the failure arrives when the route is written, not when a
 * malformed body reaches a service that trusted it.
 *
 * The schema names are checked against the contracts package's own exports, so
 * a table entry naming a schema that was renamed or never exported fails too.
 */

/** Route file, relative to this directory, to the schema names it parses with. */
const JSON_BODY_SCHEMAS: Record<string, string[]> = {
  "api/dashboard-auth/invite/accept.post.ts": ["dashboardInviteAcceptRequestSchema"],
  "api/dashboard-auth/sso/consume.post.ts": ["dashboardSsoHandoffConsumeRequestSchema"],
  "api/v1/clarifications/[id]/answer.post.ts": ["clarificationAnswerRequestSchema"],
  "api/v1/harness-profiles.post.ts": ["harnessProfileCreateRequestSchema"],
  "api/v1/harness-profiles/[id].patch.ts": ["harnessProfileDraftUpdateRequestSchema"],
  "api/v1/harness-profiles/[id]/archive.post.ts": ["harnessProfileRevisionRequestSchema"],
  "api/v1/harness-profiles/[id]/fork.post.ts": ["harnessProfileForkRequestSchema"],
  "api/v1/harness-profiles/[id]/publish.post.ts": ["harnessProfileRevisionRequestSchema"],
  "api/v1/harness-profiles/[id]/remove.post.ts": ["harnessProfileUncheckedRevisionRequestSchema"],
  "api/v1/harness-profiles/[id]/restore.post.ts": ["harnessProfileVersionRestoreRequestSchema"],
  "api/v1/harness-profiles/[id]/skills/refresh.post.ts": ["harnessProfileSkillRefreshRequestSchema"],
  "api/v1/harness-profiles/[id]/unarchive.post.ts": ["harnessProfileUncheckedRevisionRequestSchema"],
  "api/v1/harness-skills/discover.post.ts": ["harnessSkillDiscoverBodySchema"],
  "api/v1/harness-skills/import.post.ts": ["harnessSkillImportBodySchema"],
  "api/v1/harness-skills/local.post.ts": ["harnessLocalSkillImportBodySchema"],
  "api/v1/invites.post.ts": ["dashboardInviteCreateRequestSchema"],
  "api/v1/json-schema/inspect.post.ts": ["jsonSchemaInspectRequestSchema"],
  "api/v1/pre-pr-checks.put.ts": ["prePrCheckSaveRequestSchema"],
  "api/v1/pre-pr-checks/restore.post.ts": ["prePrCheckRestoreRequestSchema"],
  "api/v1/prompt-library.post.ts": ["promptLibraryCreateRequestSchema"],
  "api/v1/prompt-library/[id].patch.ts": ["promptLibraryUpdateMetaRequestSchema"],
  "api/v1/prompt-library/[id].put.ts": ["promptLibrarySaveVersionRequestSchema"],
  "api/v1/prompt-library/[id]/restore.post.ts": ["promptLibraryRestoreRequestSchema"],
  "api/v1/repository-catalog/[id].put.ts": ["repositoryCatalogUpsertRequestSchema"],
  "api/v1/repository-catalog/[id]/enabled.patch.ts": ["repositoryCatalogEnabledRequestSchema"],
  "api/v1/repository-catalog/activate.post.ts": ["repositoryCatalogActivateRequestSchema"],
  "api/v1/users/[userId]/role.patch.ts": ["dashboardUserRoleUpdateRequestSchema"],
  "api/v1/workflow-definitions.post.ts": ["workflowDefinitionCreateRequestSchema"],
  "api/v1/workflow-definitions/[id].patch.ts": ["workflowDefinitionMetaPatchRequestSchema"],
  "api/v1/workflow-definitions/[id].put.ts": ["workflowDefinitionDraftSaveRequestSchema"],
  "api/v1/workflow-definitions/[id]/catalog.post.ts": ["workflowDefinitionCandidateRequestSchema"],
  "api/v1/workflow-definitions/[id]/deploy.post.ts": ["workflowDefinitionDeployRequestSchema"],
  "api/v1/workflow-definitions/[id]/layout.patch.ts": ["workflowDefinitionLayoutPatchRequestSchema"],
  "api/v1/workflow-definitions/[id]/prompt-preview.post.ts": ["workflowDefinitionPromptPreviewRequestSchema"],
  "api/v1/workflow-definitions/[id]/restore.post.ts": ["workflowDefinitionRollbackRequestSchema"],
  "api/v1/workflow-definitions/[id]/rollback.post.ts": ["workflowDefinitionRollbackRequestSchema"],
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/manual-dispatch.post.ts": ["manualDispatchRequestSchema"],
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/manual-dispatch/preflight.post.ts": ["manualDispatchInputSchema"],
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/schedule/preview.post.ts": ["schedulePreviewRequestSchema"],
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/webhook/rotate.post.ts": ["webhookRotateSecretRequestSchema"],
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/webhook/set-secret.post.ts": ["webhookSetSecretBodySchema"],
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/webhook/test-delivery.post.ts": ["webhookTestDeliveryRequestSchema"],
  "api/v1/workflow-definitions/[id]/validate.post.ts": ["workflowDefinitionCandidateRequestSchema"],
};

/**
 * Route file to the one line saying why no JSON schema applies to it.
 *
 * The classifier behind this table proves one thing only, that the handler
 * never calls `readBody`, so each reason says which of the two ways that
 * happens: the route reads the body in another format (raw bytes, form data,
 * the MCP transport's own framing), or it reads no body at all.
 */
const NO_JSON_BODY: Record<string, string> = {
  "api/v1/approvals/[id]/approve.post.ts":
    "reads no body: the decision is the route and the approval is named in the path, so there is nothing to send.",
  "api/v1/approvals/[id]/reject.post.ts":
    "reads no body: the decision is the route and the approval is named in the path, so there is nothing to send.",
  "api/v1/invites/[inviteId]/cancel.post.ts":
    "reads no body: acts on the invite named in the path, and the action is the route rather than a field.",
  "api/v1/invites/[inviteId]/resend.post.ts":
    "reads no body: acts on the invite named in the path, and the action is the route rather than a field.",
  "api/v1/memory.delete.ts":
    "reads no body: addressed entirely by query parameters, which the handler reads and checks one by one.",
  "api/v1/prompt-library/[id].delete.ts":
    "reads no body: deletes the prompt named in the path and carries nothing besides that identifier.",
  "api/v1/runs/[runId]/cancel.post.ts":
    "reads no body: cancels the run named in the path; the operator supplies no reason with the request.",
  "api/v1/system/health.post.ts":
    "reads no body: starts a scan of this deployment's own configuration, so the request carries no input.",
  "api/v1/workflow-definitions/[id].delete.ts":
    "reads no body: deletes the definition named in the path and carries nothing besides that identifier.",
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/schedule/pause.post.ts":
    "reads no body: flips the schedule named in the path, and the direction of the flip is the route.",
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/schedule/resume.post.ts":
    "reads no body: flips the schedule named in the path, and the direction of the flip is the route.",
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/webhook/reveal.post.ts":
    "reads no body: reveals the stored secret of the trigger named in the path and sends nothing up.",
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/webhook/revoke.post.ts":
    "reads no body: flips the revoked flag of the trigger named in the path; the direction is the route.",
  "api/v1/workflow-definitions/[id]/triggers/[nodeId]/webhook/unrevoke.post.ts":
    "reads no body: flips the revoked flag of the trigger named in the path; the direction is the route.",
  "mcp-auth/consent.post.ts":
    "reads another format: an HTML form post from the consent page, read as form data because that is what a browser sends.",
  "mcp-auth/login.post.ts":
    "reads another format: an HTML form post from the login page, read as form data because that is what a browser sends.",
  "mcp.delete.ts":
    "reads no body: ends the MCP session named by a header; the transport owns that exchange and reads no body.",
  "mcp.post.ts":
    "reads another format: the MCP transport reads a byte-bounded body itself and answers a bad envelope as a JSON-RPC error, checked against the MCP contract rather than an HTTP body schema.",
  "webhooks/custom/[endpointId].post.ts":
    "reads another format: raw bytes, because the endpoint's signature is computed over exactly what arrived.",
  "webhooks/github.post.ts":
    "reads another format: raw bytes, because the provider's signature is computed over exactly what arrived.",
  "webhooks/gitlab.post.ts":
    "reads another format: raw bytes, because the provider's token check reads the body only after the header is trusted.",
  "webhooks/jira.post.ts":
    "reads another format: raw bytes, because the provider's signature is computed over exactly what arrived.",
  "webhooks/resend.post.ts":
    "reads another format: raw bytes, because the provider's signature is computed over exactly what arrived.",
  "webhooks/slack.post.ts":
    "reads another format: raw bytes, because the provider's signature is computed over exactly what arrived.",
};

const routesRoot = import.meta.dirname;

describe("request body schema coverage", () => {
  it("never asserts a body shape instead of checking it", () => {
    const asserted = mutatingRouteFiles()
      .filter(({ source }) => /\breadBody\s*</u.test(source))
      .map(({ path }) => path);

    // `readBody<Whatever>(event)` is a claim about a value nobody looked at. The
    // shape has to come from a schema that ran, so this form has no place left.
    expect(asserted).toEqual([]);
  });

  it("validates every JSON body with a schema this package exports", () => {
    const found: Record<string, string[]> = {};
    for (const { path, source } of mutatingRouteFiles()) {
      if (!readsJsonBody(source)) continue;
      const names = [
        ...source.matchAll(/parseRequestBody\(\s*([A-Za-z0-9_]+)/gu),
      ].map((match) => match[1]!);
      // Source order, not sorted: it is the order the handler parses in, and
      // sorting here would need an array copy this package's lib target has no
      // non-mutating method for.
      found[path] = [...new Set(names)];
    }

    expect(found).toEqual(JSON_BODY_SCHEMAS);
    for (const [path, names] of Object.entries(found)) {
      expect(names, `${path} parses no contract schema`).not.toEqual([]);
      for (const name of names) {
        expect(contracts, `${path} names a schema the contracts package does not export`)
          .toHaveProperty(name);
      }
    }
  });

  it("accounts for every route that reads no JSON body", () => {
    const found = new Set(
      mutatingRouteFiles()
        .filter(({ source }) => !readsJsonBody(source))
        .map(({ path }) => path),
    );

    expect(found).toEqual(new Set(Object.keys(NO_JSON_BODY)));
    for (const [path, reason] of Object.entries(NO_JSON_BODY)) {
      expect(reason.length, `${path} has no reason recorded`).toBeGreaterThan(20);
    }
  });
});

function readsJsonBody(source: string): boolean {
  return /\breadBody\s*[<(]/u.test(source);
}

function mutatingRouteFiles(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(post|put|patch|delete)\.[cm]?ts$/u.test(entry.name)) continue;
      if (/\.(test|spec)\.[cm]?ts$/u.test(entry.name)) continue;
      out.push({ path: relative(routesRoot, full), source: readFileSync(full, "utf8") });
    }
  };
  walk(routesRoot);
  return out;
}
