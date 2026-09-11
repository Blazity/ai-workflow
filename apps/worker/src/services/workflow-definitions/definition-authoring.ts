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
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import { getDb, type Db } from "../../db/client.js";
import { getCurrentSystemHarnessProfileReference } from "../../db/repositories/harness-profiles.js";
import { logger } from "../../infra/logger.js";
import { dashboardUserLabel } from "../../pre-pr-checks/store.js";
import { defaultWorkflowDefinitionV2 } from "../../workflow-definition/default.js";
import { workflowBlockRegistryContextFromEnv } from "../../workflow-definition/models.js";
import { validateWorkflowDefinitionCandidateWithPromptAuthoring } from "../../workflow-definition/prompt-authoring.js";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinitionDraft,
  getCurrentWorkflowDefinitionVersion,
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionDraft,
  saveWorkflowDefinitionDraft,
  saveWorkflowDefinitionLayout,
  updateWorkflowDefinition,
  WorkflowDefinitionStoreError,
  type WorkflowDefinitionActor,
  type WorkflowDefinitionDraftRow,
  type WorkflowDefinitionRow,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import { workflowDefinitionTemplate } from "../../workflow-definition/templates.js";
import { agentRuntimeSettings } from "../settings/index.js";

/** The acting user as a request knows them, before the store's audit label has
 *  been looked up. */
export interface WorkflowDefinitionRequestActor {
  role: DashboardRole;
  userId: string;
}

/** The store records who changed a definition by a human-readable label, which
 *  lives in another table, so every write path resolves it first. */
export async function resolveWorkflowDefinitionActor(
  db: Db,
  actor: WorkflowDefinitionRequestActor,
): Promise<WorkflowDefinitionActor> {
  return {
    role: actor.role,
    id: actor.userId,
    label: await dashboardUserLabel(db, actor.userId),
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
}): Promise<CreateWorkflowDefinitionResult> {
  const db = getDb();
  const { agentKind, includeReview, includeLeakReview } = agentRuntimeSettings();
  const profileReference = await getCurrentSystemHarnessProfileReference(db, agentKind);
  const seedOptions = {
    includeReview,
    includeLeakReview,
    provider: agentKind,
    profileReference,
  };

  let seed: WorkflowDefinition;
  if (input.source.kind === "duplicate") {
    const sourceId = input.source.definitionId;
    const sourceRow = await getWorkflowDefinition(db, sourceId);
    if (!sourceRow || sourceRow.archivedAt) return { ok: false, reason: "unknown_definition" };

    const draft = await getWorkflowDefinitionDraft(db, sourceId);
    const deployed = await getDeployedWorkflowDefinitionVersion(db, sourceId);
    const current = await getCurrentWorkflowDefinitionVersion(db, sourceId);
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

  const created = await createWorkflowDefinitionDraft(db, {
    name: input.name,
    seed,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });
  return {
    ok: true,
    definition: created.definition,
    draft: created.draft,
    currentVersion: await getCurrentWorkflowDefinitionVersion(db, created.definition.id),
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
  const db = getDb();
  return updateWorkflowDefinition(db, {
    definitionId: input.definitionId,
    name: input.name,
    enabled: input.enabled,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });
}

/** Retire a definition from the listing without deleting its history. */
export async function archiveWorkflowDefinitionById(input: {
  definitionId: number;
  actor: WorkflowDefinitionRequestActor;
}): Promise<void> {
  const db = getDb();
  await archiveWorkflowDefinition(db, {
    definitionId: input.definitionId,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });
}

export interface SavedWorkflowDefinitionDraft {
  definition: WorkflowDefinitionRow;
  draftRow: WorkflowDefinitionDraftRow;
  validation: Awaited<
    ReturnType<typeof validateWorkflowDefinitionCandidateWithPromptAuthoring>
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
  const db = getDb();
  const saved = await saveWorkflowDefinitionDraft(db, {
    definitionId: input.definitionId,
    definition: input.definition,
    expectedDraftRevision: input.expectedDraftRevision,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });

  try {
    const validation = await validateWorkflowDefinitionCandidateWithPromptAuthoring(
      db,
      saved.draft,
      workflowBlockRegistryContextFromEnv(),
    );
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
  const db = getDb();
  return saveWorkflowDefinitionLayout(db, {
    definitionId: input.definitionId,
    layout: input.layout,
    expectedLayoutRevision: input.expectedLayoutRevision,
    actor: await resolveWorkflowDefinitionActor(db, input.actor),
  });
}
