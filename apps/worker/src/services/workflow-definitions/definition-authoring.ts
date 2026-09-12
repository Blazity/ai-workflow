/**
 * Authoring a definition: creating one, renaming it, saving its draft and its
 * layout, archiving it, and answering the editor's questions about a candidate
 * graph it has not saved yet.
 *
 * Everything here binds its own connection and resolves the acting user into
 * the label the store records. The refusals that are about the request rather
 * than about permission (an id that names nothing, a template that does not
 * exist, a candidate that is not a v2 graph) come back as values, so the
 * transport above decides what each becomes on the wire.
 */
import type {
  DashboardRole,
  WorkflowDefinition,
  WorkflowDefinitionLayoutInput,
} from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE, type SettingsSnapshot } from "@shared/contracts";
import { canEditWorkflowDefinitions } from "@shared/contracts";
import { getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";
import { logger } from "../../infra/logger.js";
import { defaultWorkflowDefinitionV2 } from "../../engine/definition/default.js";
import {
  WorkflowDefinitionStoreError,
  type WorkflowDefinitionActor,
  type WorkflowDefinitionDraftRow,
  type WorkflowDefinitionRow,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import {
  getConnectedWorkflowDefinition,
} from "../../db/repositories/definitions/connected.js";
import { workflowDefinitionTemplate } from "../../engine/definition/templates.js";
import { agentRuntimeSettings } from "../settings/index.js";
import { currentSystemHarnessProfileReference } from "../harness/index.js";
import {
  archiveConnectedWorkflowDefinition,
  createConnectedWorkflowDefinitionDraft,
  saveConnectedWorkflowDefinitionDraft,
  saveConnectedWorkflowDefinitionLayout,
  updateConnectedWorkflowDefinition,
  validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring,
} from "./policy-operations.js";
import {
  readConnectedCurrentWorkflowDefinitionVersion,
  readConnectedDeployedWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";
import { readConnectedWorkflowDefinitionDraft } from "../../engine/definition-draft-read.js";

function requireWorkflowDefinitionEditor(role: DashboardRole): void {
  if (!canEditWorkflowDefinitions(role)) {
    throw new WorkflowDefinitionStoreError(403, "Forbidden");
  }
}

/** The acting user as a request knows them, before the store's audit label has
 *  been looked up. */
export interface WorkflowDefinitionRequestActor {
  role: DashboardRole;
  userId: string;
}

/** The store records who changed a definition by a human-readable label, which
 *  lives in another table, so every write path resolves it first. */
export async function resolveWorkflowDefinitionActor(
  actor: WorkflowDefinitionRequestActor,
): Promise<WorkflowDefinitionActor> {
  return {
    role: actor.role,
    id: actor.userId,
    label: await getConnectedDashboardUserLabel(actor.userId),
  };
}

/** Where a new definition's first draft comes from. */
export type WorkflowDefinitionSeedSource =
  | { kind: "default" }
  | { kind: "template"; templateId: string }
  | { kind: "duplicate"; definitionId: number };

export type CreateWorkflowDefinitionResult =
  | {
      ok: true;
      definition: WorkflowDefinitionRow;
      draft: WorkflowDefinition;
      currentVersion: WorkflowDefinitionVersionRow | null;
    }
  | { ok: false; reason: "unknown_definition" | "unknown_template" };

/**
 * Create a definition and its first draft.
 *
 * Duplicating prefers the source's draft over its deployed head, and its
 * deployed head over whatever version is merely current, so a copy carries the
 * newest authored state rather than the newest running one. A source with no
 * draft whose stored state is the retired v1 schema is refused outright: there
 * is nothing this system can seed a v2 draft from.
 */
export async function createWorkflowDefinitionFromSource(input: {
  name: string;
  source: WorkflowDefinitionSeedSource;
  actor: WorkflowDefinitionRequestActor;
  settings: SettingsSnapshot;
}): Promise<CreateWorkflowDefinitionResult> {
  requireWorkflowDefinitionEditor(input.actor.role);
  const { agentKind, includeReview, includeLeakReview } = agentRuntimeSettings(input.settings);
  const profileReference = await currentSystemHarnessProfileReference(agentKind);
  const seedOptions = {
    includeReview,
    includeLeakReview,
    provider: agentKind,
    profileReference,
  };

  let seed: WorkflowDefinition;
  if (input.source.kind === "duplicate") {
    const sourceId = input.source.definitionId;
    const sourceRow = await getConnectedWorkflowDefinition(sourceId);
    if (!sourceRow || sourceRow.archivedAt) return { ok: false, reason: "unknown_definition" };

    const draft = await readConnectedWorkflowDefinitionDraft(sourceId);
    const deployed = await readConnectedDeployedWorkflowDefinitionVersion(sourceId);
    const current = await readConnectedCurrentWorkflowDefinitionVersion(sourceId);
    const storedSource = deployed ?? current;
    if (!draft && storedSource?.schema === "legacy-v1") {
      throw new WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
    }
    seed =
      draft?.draft ??
      (storedSource?.schema === "v2" ? storedSource.definition : undefined) ??
      defaultWorkflowDefinitionV2(seedOptions);
  } else if (input.source.kind === "template") {
    const template = workflowDefinitionTemplate(input.source.templateId, seedOptions);
    if (!template) return { ok: false, reason: "unknown_template" };
    seed = template.definition;
  } else {
    seed = defaultWorkflowDefinitionV2(seedOptions);
  }

  const created = await createConnectedWorkflowDefinitionDraft({
    name: input.name,
    seed,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });
  return {
    ok: true,
    definition: created.definition,
    draft: created.draft,
    currentVersion: await readConnectedCurrentWorkflowDefinitionVersion(created.definition.id),
  };
}

/** Rename a definition, enable or disable it, or both. An absent field is left
 *  alone rather than cleared. */
export async function updateWorkflowDefinitionMeta(input: {
  definitionId: number;
  name?: string;
  enabled?: boolean;
  actor: WorkflowDefinitionRequestActor;
}): Promise<WorkflowDefinitionRow> {
  requireWorkflowDefinitionEditor(input.actor.role);
  const updated = await updateConnectedWorkflowDefinition({
    definitionId: input.definitionId,
    name: input.name,
    enabled: input.enabled,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });
  return updated;
}

/** Retire a definition from the listing without deleting its history. */
export async function archiveWorkflowDefinitionById(input: {
  definitionId: number;
  actor: WorkflowDefinitionRequestActor;
}): Promise<void> {
  requireWorkflowDefinitionEditor(input.actor.role);
  await archiveConnectedWorkflowDefinition({
    definitionId: input.definitionId,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });
}

export interface SavedWorkflowDefinitionDraft {
  definition: WorkflowDefinitionRow;
  draftRow: WorkflowDefinitionDraftRow;
  validation: Awaited<
    ReturnType<typeof validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring>
  >["response"] | null;
  validationError: string | null;
}

/**
 * Save the draft, then validate what was saved.
 *
 * The save is what the operator asked for and the validation is advice about
 * it, so a validation backend that is down must not lose the draft: the failure
 * is logged and reported alongside the saved draft instead of thrown.
 */
export async function saveWorkflowDefinitionDraftAndValidate(input: {
  definitionId: number;
  definition: WorkflowDefinition;
  expectedDraftRevision: number;
  actor: WorkflowDefinitionRequestActor;
}): Promise<SavedWorkflowDefinitionDraft> {
  requireWorkflowDefinitionEditor(input.actor.role);
  const saved = await saveConnectedWorkflowDefinitionDraft({
    definitionId: input.definitionId,
    definition: input.definition,
    expectedDraftRevision: input.expectedDraftRevision,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });

  try {
    const validation = await validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring(saved.draft);
    return {
      definition: saved.definition,
      draftRow: saved,
      validation: validation.response,
      validationError: null,
    };
  } catch (validationFailure) {
    logger.warn(
      {
        definitionId: input.definitionId,
        draftRevision: saved.draftRevision,
        error:
          validationFailure instanceof Error
            ? validationFailure.message
            : String(validationFailure),
      },
      "workflow_draft_validation_failed_after_save",
    );
    return {
      definition: saved.definition,
      draftRow: saved,
      validation: null,
      validationError: "Validation is temporarily unavailable. Your draft was saved.",
    };
  }
}

/** Save where the editor placed the nodes. Compare-and-set on its own revision,
 *  separate from the draft's, so moving a node never conflicts with editing it. */
export async function saveWorkflowDefinitionLayoutRevision(input: {
  definitionId: number;
  layout: WorkflowDefinitionLayoutInput;
  expectedLayoutRevision: number;
  actor: WorkflowDefinitionRequestActor;
}): Promise<WorkflowDefinitionRow> {
  requireWorkflowDefinitionEditor(input.actor.role);
  return saveConnectedWorkflowDefinitionLayout({
    definitionId: input.definitionId,
    layout: input.layout,
    expectedLayoutRevision: input.expectedLayoutRevision,
    actor: await resolveWorkflowDefinitionActor(input.actor),
  });
}
