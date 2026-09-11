import { describe, expect, it } from "vitest";
import {
  clarificationAnswerRequestSchema,
  dashboardInviteAcceptRequestSchema,
  dashboardInviteCreateRequestSchema,
  dashboardSsoHandoffConsumeRequestSchema,
  dashboardUserRoleUpdateRequestSchema,
  harnessLocalSkillImportBodySchema,
  harnessProfileCreateRequestSchema,
  harnessProfileDraftUpdateRequestSchema,
  harnessProfileForkRequestSchema,
  harnessProfileRevisionRequestSchema,
  harnessProfileSkillRefreshRequestSchema,
  harnessProfileUncheckedRevisionRequestSchema,
  harnessProfileVersionRestoreRequestSchema,
  harnessSkillDiscoverBodySchema,
  harnessSkillImportBodySchema,
  jsonSchemaInspectRequestSchema,
  manualDispatchInputSchema,
  manualDispatchRequestSchema,
  parseRequestBody,
  prePrCheckRestoreRequestSchema,
  prePrCheckSaveRequestSchema,
  promptLibraryCreateRequestSchema,
  promptLibraryRestoreRequestSchema,
  promptLibrarySaveVersionRequestSchema,
  promptLibraryUpdateMetaRequestSchema,
  schedulePreviewRequestSchema,
  webhookRotateSecretRequestSchema,
  webhookSetSecretBodySchema,
  webhookTestDeliveryRequestSchema,
  workflowDefinitionCandidateRequestSchema,
  workflowDefinitionCreateRequestSchema,
  workflowDefinitionDeployRequestSchema,
  workflowDefinitionDraftSaveRequestSchema,
  workflowDefinitionLayoutPatchRequestSchema,
  workflowDefinitionMetaPatchRequestSchema,
  workflowDefinitionPromptPreviewRequestSchema,
  workflowDefinitionRollbackRequestSchema,
} from "@shared/contracts";

import {
  itRefusesNonObjectBodyWith,
  itTreatsNonObjectBodyAsEmpty,
} from "../../test-support/non-object-body.js";

/**
 * What a JSON body that is not an object answers, for every schema that has one.
 *
 * Two behaviours, and which one a schema has is the handler's, not a choice made
 * here. Most handlers read their body with `readBody(...) ?? {}` and then picked
 * fields off the result, so a scalar, an array and null arrived with no fields
 * and were answered exactly like `{}`: those schemas are wrapped in
 * `objectOrEmpty` and asserted with the first helper. The rest checked the body
 * themselves before reading a field and refused it with a sentence of their own:
 * those carry that sentence on the object level and are asserted with the
 * second. The table lives in one file because it is one property of the whole
 * request surface, and because the schema tests next door read as what each
 * field means.
 */

describe("admin bodies", () => {
  itTreatsNonObjectBodyAsEmpty(
    "dashboardInviteCreateRequestSchema",
    dashboardInviteCreateRequestSchema,
    { ok: false, message: "Missing email" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "dashboardUserRoleUpdateRequestSchema",
    dashboardUserRoleUpdateRequestSchema,
    { ok: false, message: "Invalid role" },
  );
});

describe("harness profile bodies", () => {
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileCreateRequestSchema",
    harnessProfileCreateRequestSchema,
    { ok: false, message: "Profile draft is required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileDraftUpdateRequestSchema",
    harnessProfileDraftUpdateRequestSchema,
    { ok: false, message: "Draft and expectedRevision are required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileRevisionRequestSchema",
    harnessProfileRevisionRequestSchema,
    { ok: false, message: "expectedRevision is required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileUncheckedRevisionRequestSchema",
    harnessProfileUncheckedRevisionRequestSchema,
    { ok: true, value: {} },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileForkRequestSchema",
    harnessProfileForkRequestSchema,
    { ok: false, message: "expectedRevision is required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileVersionRestoreRequestSchema",
    harnessProfileVersionRestoreRequestSchema,
    { ok: false, message: "version and expectedRevision are required" },
  );
});

describe("harness skill bodies", () => {
  itTreatsNonObjectBodyAsEmpty(
    "harnessProfileSkillRefreshRequestSchema",
    harnessProfileSkillRefreshRequestSchema,
    { ok: false, message: "artifactHash and expectedRevision are required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessSkillDiscoverBodySchema",
    harnessSkillDiscoverBodySchema,
    { ok: false, message: "GitHub skill source is required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessSkillImportBodySchema",
    harnessSkillImportBodySchema,
    { ok: false, message: "Exact source and selected paths are required" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "harnessLocalSkillImportBodySchema",
    harnessLocalSkillImportBodySchema,
    { ok: false, message: "Selected skills are required" },
  );
});

describe("prompt library bodies", () => {
  itTreatsNonObjectBodyAsEmpty(
    "promptLibraryCreateRequestSchema",
    promptLibraryCreateRequestSchema,
    { ok: false, message: "Invalid name" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "promptLibraryUpdateMetaRequestSchema",
    promptLibraryUpdateMetaRequestSchema,
    { ok: true, value: {} },
  );
  itTreatsNonObjectBodyAsEmpty(
    "promptLibrarySaveVersionRequestSchema",
    promptLibrarySaveVersionRequestSchema,
    { ok: false, message: "Invalid body" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "promptLibraryRestoreRequestSchema",
    promptLibraryRestoreRequestSchema,
    { ok: false, message: "Invalid version" },
  );
});

describe("workflow definition bodies", () => {
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionCreateRequestSchema",
    workflowDefinitionCreateRequestSchema,
    { ok: false, message: "Invalid name" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionMetaPatchRequestSchema",
    workflowDefinitionMetaPatchRequestSchema,
    { ok: true, value: {} },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionDraftSaveRequestSchema",
    workflowDefinitionDraftSaveRequestSchema,
    { ok: false, message: "Invalid draft revision" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionDeployRequestSchema",
    workflowDefinitionDeployRequestSchema,
    { ok: false, message: "Invalid draft revision" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionRollbackRequestSchema",
    workflowDefinitionRollbackRequestSchema,
    { ok: false, message: "Invalid version" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionLayoutPatchRequestSchema",
    workflowDefinitionLayoutPatchRequestSchema,
    { ok: false, message: "Invalid workflow layout" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionCandidateRequestSchema",
    workflowDefinitionCandidateRequestSchema,
    { ok: true, value: {} },
  );
  itTreatsNonObjectBodyAsEmpty(
    "workflowDefinitionPromptPreviewRequestSchema",
    workflowDefinitionPromptPreviewRequestSchema,
    { ok: false, message: "Invalid block id" },
  );
});

describe("trigger and clarification bodies", () => {
  itTreatsNonObjectBodyAsEmpty(
    "webhookRotateSecretRequestSchema",
    webhookRotateSecretRequestSchema,
    { ok: true, value: {} },
  );
  itTreatsNonObjectBodyAsEmpty(
    "webhookSetSecretBodySchema",
    webhookSetSecretBodySchema,
    { ok: true, value: {} },
  );
  itTreatsNonObjectBodyAsEmpty(
    "jsonSchemaInspectRequestSchema",
    jsonSchemaInspectRequestSchema,
    { ok: false, message: "source must be a JSON Schema string" },
  );
  itTreatsNonObjectBodyAsEmpty(
    "clarificationAnswerRequestSchema",
    clarificationAnswerRequestSchema,
    { ok: false, message: "invalid_answer" },
  );
});

describe("bodies the handler refused itself", () => {
  itRefusesNonObjectBodyWith(
    "dashboardInviteAcceptRequestSchema",
    dashboardInviteAcceptRequestSchema,
    "Invalid request body",
  );
  itRefusesNonObjectBodyWith(
    "dashboardSsoHandoffConsumeRequestSchema",
    dashboardSsoHandoffConsumeRequestSchema,
    "Missing SSO handoff token",
  );
  itRefusesNonObjectBodyWith(
    "prePrCheckSaveRequestSchema",
    prePrCheckSaveRequestSchema,
    "Invalid config: config is required.",
  );
  itRefusesNonObjectBodyWith(
    "prePrCheckRestoreRequestSchema",
    prePrCheckRestoreRequestSchema,
    "Invalid version",
  );
});

describe("dispatch bodies the handler refused itself", () => {
  itRefusesNonObjectBodyWith(
    "webhookTestDeliveryRequestSchema",
    webhookTestDeliveryRequestSchema,
    "payload is required",
  );
  itRefusesNonObjectBodyWith(
    "manualDispatchInputSchema",
    manualDispatchInputSchema,
    "Invalid dispatch input",
  );
  itRefusesNonObjectBodyWith(
    "manualDispatchRequestSchema",
    manualDispatchRequestSchema,
    "Invalid dispatch request",
  );

  it("refuses a scalar preview body, and takes an array as far as the timezone", () => {
    // The preview handler asked `typeof body === "object"`, which an array
    // passes, so an array reached the timezone check and still does.
    for (const body of ["abc", 42, true, null]) {
      expect(parseRequestBody(schedulePreviewRequestSchema, body)).toEqual({
        ok: false,
        message: "Invalid preview request",
      });
    }
    expect(parseRequestBody(schedulePreviewRequestSchema, [])).toEqual({
      ok: false,
      message: "timezone is required",
    });
  });
});
