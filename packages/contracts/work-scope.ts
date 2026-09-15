/**
 * Work scope: the one durable record, per subject of work, of which
 * repositories that work touches and why, the decision trail it folds from,
 * and the repository policy a trigger node carries.
 *
 * Shared rather than worker-owned because the worker writes the record, the
 * MCP surface reads the trail, and the dashboard edits both the record and the
 * trigger policy. The dashboard cannot import the engine, so the two pure
 * functions that turn a trigger's configuration into its effective policy live
 * here with the shapes they read.
 *
 * Nothing here has a default. A default on the trigger field would change the
 * canonical JSON, and with it the graph hash, of every stored definition the
 * next time it is saved.
 */
import { z } from "zod";
import type { WorkflowBlockType } from "./block-catalog.generated";
import type { WorkflowRepositoryScope } from "./domain";
import {
  REPOSITORY_CATALOG_LABEL_MAX_LENGTH,
  REPOSITORY_CATALOG_PATH_PATTERN,
  repositoryCatalogKey,
  repositoryCatalogProviderSchema,
} from "./repository-catalog";
import type { PrTriggerType } from "./trigger-events";

const WORK_SCOPE_RATIONALE_MAX_LENGTH = 500;
const WORK_SCOPE_MAP_TEXT_MAX_LENGTH = 1600;
const TRIGGER_POLICY_LISTED_KEYS_MAX = 50;
const WORK_SCOPE_EDIT_CHANGES_MAX = 16;
const WORK_SCOPE_WRITE_PLAN_KEYS_MAX = 16;
const WORK_SCOPE_WRITE_PLAN_TRAIL_MAX = 32;
const WORK_SCOPE_ASKED_REPOSITORIES_MAX = 8;

export const WORK_SCOPE_ENTRY_STATES = ["selected", "excluded", "unavailable"] as const;
export const workScopeEntryStateSchema = z.enum(WORK_SCOPE_ENTRY_STATES);
export type WorkScopeEntryState = z.infer<typeof workScopeEntryStateSchema>;

export const WORK_SCOPE_UNAVAILABLE_REASONS = ["not_enabled", "unusable"] as const;
export const workScopeUnavailableReasonSchema = z.enum(WORK_SCOPE_UNAVAILABLE_REASONS);
export type WorkScopeUnavailableReason = z.infer<typeof workScopeUnavailableReasonSchema>;

/** Why a question about a repository was raised, recorded at ask time,
 *  because a "none" answer means something different for each reason: not
 *  enabled or unusable are recorded as unavailable, outside policy as
 *  excluded, selection records nothing. */
export const WORK_SCOPE_ASK_REASONS = ["not_enabled", "unusable", "outside_policy", "selection"] as const;
export const workScopeAskReasonSchema = z.enum(WORK_SCOPE_ASK_REASONS);
export type WorkScopeAskReason = z.infer<typeof workScopeAskReasonSchema>;

/** Index order IS precedence: index 0 wins. */
export const WORK_SCOPE_ORIGINS = [
  "person",
  "workflow_owned_branch",
  "ticket_text",
  "trigger_policy",
  "inferred",
] as const;
export const workScopeOriginSchema = z.enum(WORK_SCOPE_ORIGINS);
export type WorkScopeOrigin = z.infer<typeof workScopeOriginSchema>;

/** Lower wins. Persisted beside the entry so the database itself can refuse a
 *  lower origin overwriting a higher one. */
export function workScopeOriginRank(origin: WorkScopeOrigin): number {
  return WORK_SCOPE_ORIGINS.indexOf(origin);
}

export const WORK_SCOPE_REFUSAL_REASONS = [
  "outside_catalog",
  "outside_policy",
  "excluded",
  "unavailable",
  "workspace_cap",
  // More than three repositories were requested at once; the extras are
  // refused without a question.
  "request_limit",
  "rounds_exhausted",
] as const;
export const workScopeRefusalReasonSchema = z.enum(WORK_SCOPE_REFUSAL_REASONS);
export type WorkScopeRefusalReason = z.infer<typeof workScopeRefusalReasonSchema>;

function isRepositoryKey(key: string): boolean {
  const separator = key.indexOf(":");
  if (separator < 0) return false;
  const path = key.slice(separator + 1);
  return (
    repositoryCatalogProviderSchema.safeParse(key.slice(0, separator)).success &&
    path.length <= REPOSITORY_CATALOG_LABEL_MAX_LENGTH &&
    REPOSITORY_CATALOG_PATH_PATTERN.test(path)
  );
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** The normalised catalog key a run's frozen enabled list already carries:
 *  lower case "provider:path", e.g. "github:blazity/ai-workflow-demo". The
 *  path follows the catalog's own rule, so a GitLab project in nested groups
 *  is a key and a bare "owner/name" is not. */
export const repositoryKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isRepositoryKey, {
    message: 'repository key must look like "github:owner/name"',
  });
export type RepositoryKey = z.infer<typeof repositoryKeySchema>;

export const workScopeActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("person"),
      actorId: z.string().min(1),
      actorLabel: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run"),
      runId: z.string().min(1),
      definitionId: z.number().int().positive(),
      definitionVersion: z.number().int().positive(),
      model: z.string().min(1).optional(),
    })
    .strict(),
]);
export type WorkScopeActor = z.infer<typeof workScopeActorSchema>;

export const workScopeEntrySchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    state: workScopeEntryStateSchema,
    unavailableReason: workScopeUnavailableReasonSchema.optional(),
    origin: workScopeOriginSchema,
    rationale: z.string().max(WORK_SCOPE_RATIONALE_MAX_LENGTH),
    decidedBy: workScopeActorSchema,
    /** ISO 8601. */
    decidedAt: z.string().min(1),
  })
  .strict()
  // A reason on a selected entry would be read by nobody and then trusted by
  // whoever reads it next, so the pairing is exact in both directions.
  .refine(
    (entry) => (entry.state === "unavailable") === (entry.unavailableReason !== undefined),
    {
      message: "unavailableReason is present exactly when the state is unavailable.",
      path: ["unavailableReason"],
    },
  );
export type WorkScopeEntry = z.infer<typeof workScopeEntrySchema>;

export const workScopeSchema = z
  .object({
    subjectKey: z.string().min(1),
    version: z.number().int().min(0),
    entries: z.array(workScopeEntrySchema),
  })
  .strict();
export type WorkScope = z.infer<typeof workScopeSchema>;

/** A repository a question named, and why it was asked: not enabled or
 *  unusable are recorded as unavailable if the answer is "none", outside
 *  policy is recorded as excluded, and selection records nothing. */
export const workScopeAskedRepositorySchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    askedBecause: workScopeAskReasonSchema,
  })
  .strict();
export type WorkScopeAskedRepository = z.infer<typeof workScopeAskedRepositorySchema>;

export const workScopeAskedRepositoriesSchema = z
  .array(workScopeAskedRepositorySchema)
  .min(1)
  .max(WORK_SCOPE_ASKED_REPOSITORIES_MAX)
  .refine(
    (repositories) => hasUniqueValues(repositories.map((repository) => repository.repositoryKey)),
    { message: "Asked repositories must be unique." },
  );

export const workScopeQuestionAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("repositories"),
      repositoryKeys: z
        .array(repositoryKeySchema)
        .min(1)
        .max(WORK_SCOPE_ASKED_REPOSITORIES_MAX)
        .refine(hasUniqueValues, { message: "Answered repositories must be unique." }),
    })
    .strict(),
  z.object({ kind: z.literal("unrecognised") }).strict(),
]);
export type WorkScopeQuestionAnswer = z.infer<typeof workScopeQuestionAnswerSchema>;

export const workScopeTrailEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("entry_written"),
      entry: workScopeEntrySchema,
      previousState: workScopeEntryStateSchema.nullable(),
      clarificationId: z.string().min(1).optional(),
    })
    .strict(),
  // `entry` is the row as it was before the delete.
  z
    .object({
      kind: z.literal("entry_removed"),
      entry: workScopeEntrySchema,
      removedBy: workScopeActorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("question_asked"),
      clarificationId: z.string().min(1),
      repositories: workScopeAskedRepositoriesSchema,
    })
    .strict(),
  // A person's answer as the run read it. With `question_asked` under the
  // same clarification id it gives the full question and answer history of a
  // subject, including answers that wrote no entry (a none to a selection
  // question, an unreadable answer).
  z
    .object({
      kind: z.literal("question_answered"),
      clarificationId: z.string().min(1),
      answer: workScopeQuestionAnswerSchema,
      answeredBy: workScopeActorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("request_refused"),
      repositoryKey: repositoryKeySchema,
      reason: workScopeRefusalReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("map_shown"),
      text: z.string().max(WORK_SCOPE_MAP_TEXT_MAX_LENGTH),
      repositoryKeys: z.array(repositoryKeySchema),
    })
    .strict(),
]);
export type WorkScopeTrailEvent = z.infer<typeof workScopeTrailEventSchema>;

/** subjectKey and runId are never both null: a panel edit has no run,
 *  a schedule run has no subject. */
export const workScopeTrailRowSchema = z
  .object({
    id: z.number().int().positive(),
    subjectKey: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    at: z.string().min(1),
    event: workScopeTrailEventSchema,
  })
  .strict()
  .refine((row) => row.subjectKey !== null || row.runId !== null, {
    message: "A trail row names a subject, a run, or both.",
    path: ["subjectKey"],
  });
export type WorkScopeTrailRow = z.infer<typeof workScopeTrailRowSchema>;

/** The one shape a caller hands the store for a single write. Every array may
 *  be empty, and so may the whole plan. */
export const workScopeWritePlanSchema = z
  .object({
    upserts: z
      .array(
        z
          .object({
            entry: workScopeEntrySchema,
            replacesExpired: z.boolean(),
          })
          .strict()
          // Replacing an expired entry means a repository recorded as
          // unavailable, not_enabled, has since been enabled and is now
          // selected. It is the one case a lower origin may overwrite a higher
          // one, so it may not ride along on any other state.
          .refine((upsert) => !upsert.replacesExpired || upsert.entry.state === "selected", {
            message: "replacesExpired is valid only on a selected entry.",
            path: ["replacesExpired"],
          }),
      )
      .max(WORK_SCOPE_WRITE_PLAN_KEYS_MAX),
    // A delete names the origin its writer observed, so the store deletes only
    // a row still carrying it: a person who took the repository over in the
    // meantime is not undone by a run dropping its text match.
    deletes: z
      .array(
        z
          .object({ repositoryKey: repositoryKeySchema, origin: workScopeOriginSchema })
          .strict(),
      )
      .max(WORK_SCOPE_WRITE_PLAN_KEYS_MAX),
    trail: z.array(workScopeTrailEventSchema).max(WORK_SCOPE_WRITE_PLAN_TRAIL_MAX),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const upsertKeys = plan.upserts.map((upsert) => upsert.entry.repositoryKey);
    if (!hasUniqueValues(upsertKeys)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["upserts"],
        message: "A write plan upserts each repository at most once.",
      });
    }
    const deleteKeys = plan.deletes.map((deletion) => deletion.repositoryKey);
    if (!hasUniqueValues(deleteKeys)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deletes"],
        message: "A write plan deletes each repository at most once.",
      });
    }
    const upserted = new Set(upsertKeys);
    for (const [index, key] of deleteKeys.entries()) {
      if (!upserted.has(key)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deletes", index],
        message: `A write plan cannot both upsert and delete "${key}".`,
      });
    }
  });
export type WorkScopeWritePlan = z.infer<typeof workScopeWritePlanSchema>;

/** Shape only. Which candidates and expansions a given trigger type may carry
 *  is `validateTriggerRepositoryPolicy`, refused when a version is published,
 *  so a draft that is half way through an edit still saves. */
export const triggerRepositoryPolicySchema = z
  .object({
    candidates: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("enabled_catalog") }).strict(),
      // The six pull request trigger types only.
      z.object({ kind: z.literal("event_repository_and_related") }).strict(),
      z
        .object({
          kind: z.literal("listed"),
          repositoryKeys: z
            .array(repositoryKeySchema)
            .min(1)
            .max(TRIGGER_POLICY_LISTED_KEYS_MAX)
            .refine(hasUniqueValues, { message: "Listed repositories must be unique." }),
        })
        .strict(),
    ]),
    expansion: z.enum(["attach", "ask_once", "never"]),
  })
  .strict();
export type TriggerRepositoryPolicy = z.infer<typeof triggerRepositoryPolicySchema>;

/** A person's edit. One write, whole change set, one version. */
export const workScopeEditRequestSchema = z
  .object({
    subjectKey: z.string().min(1),
    /** 0 when the subject has no record yet. */
    expectedVersion: z.number().int().min(0),
    changes: z
      .array(
        z
          .object({
            repositoryKey: repositoryKeySchema,
            action: z.enum(["select", "exclude", "remove"]),
            // Becomes the entry's rationale, so it takes the entry's bound.
            rationale: z.string().max(WORK_SCOPE_RATIONALE_MAX_LENGTH).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(WORK_SCOPE_EDIT_CHANGES_MAX)
      .refine((changes) => hasUniqueValues(changes.map((change) => change.repositoryKey)), {
        message: "An edit changes each repository at most once.",
      }),
  })
  .strict();
export type WorkScopeEditRequest = z.infer<typeof workScopeEditRequestSchema>;

const PULL_REQUEST_TRIGGER_TYPES: readonly WorkflowBlockType[] = [
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
] satisfies readonly PrTriggerType[];

function triggerKindDefaultPolicy(
  triggerType: WorkflowBlockType,
  webhookHasSubjectPath: boolean,
): TriggerRepositoryPolicy | null {
  if (triggerType === "trigger_ticket_ai") {
    return { candidates: { kind: "enabled_catalog" }, expansion: "attach" };
  }
  if (PULL_REQUEST_TRIGGER_TYPES.includes(triggerType)) {
    return { candidates: { kind: "event_repository_and_related" }, expansion: "attach" };
  }
  // Nobody is awake to answer a schedule.
  if (triggerType === "trigger_schedule") {
    return { candidates: { kind: "enabled_catalog" }, expansion: "never" };
  }
  // Without a subject path every delivery is a new subject, so an answer
  // would never be read twice.
  if (triggerType === "trigger_webhook") {
    return {
      candidates: { kind: "enabled_catalog" },
      expansion: webhookHasSubjectPath ? "ask_once" : "never",
    };
  }
  return null;
}

/**
 * The policy a trigger node runs under: the configured one, else the kind
 * default with the definition pin as its candidate set when the pin names
 * repositories. `null` for a block that cannot carry a policy, which includes
 * `trigger_plan_approved`, because an approved plan carries its own frozen
 * scope.
 *
 * A pin with only `providers` counts as no pin: providers are applied where
 * they always were, and a candidate set built from them would be the whole
 * provider rather than a list.
 */
export function resolveTriggerRepositoryPolicy(input: {
  triggerType: WorkflowBlockType;
  configured?: TriggerRepositoryPolicy;
  definitionPin?: WorkflowRepositoryScope;
  webhookHasSubjectPath: boolean;
}): TriggerRepositoryPolicy | null {
  const kindDefault = triggerKindDefaultPolicy(input.triggerType, input.webhookHasSubjectPath);
  if (kindDefault === null) return null;
  if (input.configured) return input.configured;
  const pinned = input.definitionPin?.repositories ?? [];
  if (pinned.length === 0) return kindDefault;
  return {
    candidates: {
      kind: "listed",
      repositoryKeys: [
        ...new Set(
          pinned.map((repository) =>
            repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath }),
          ),
        ),
      ],
    },
    expansion: kindDefault.expansion,
  };
}

export type TriggerRepositoryPolicyIssueCode =
  | "event_repository_outside_pull_request"
  | "ask_once_on_schedule"
  | "ask_once_without_subject_path"
  | "duplicate_repository_key";

export interface TriggerRepositoryPolicyIssue {
  code: TriggerRepositoryPolicyIssueCode;
  /** Relative to the policy, so a caller prefixes where the policy sits. */
  path: (string | number)[];
  message: string;
}

/**
 * What a well-shaped policy may not say on this trigger type. Empty when it is
 * valid. Duplicate keys are also refused by the schema; they are repeated here
 * so a caller holding an unparsed policy, such as the editor, gets the same
 * answer.
 */
export function validateTriggerRepositoryPolicy(
  triggerType: WorkflowBlockType,
  policy: TriggerRepositoryPolicy,
  options: { webhookHasSubjectPath: boolean },
): TriggerRepositoryPolicyIssue[] {
  const issues: TriggerRepositoryPolicyIssue[] = [];
  if (
    policy.candidates.kind === "event_repository_and_related" &&
    !PULL_REQUEST_TRIGGER_TYPES.includes(triggerType)
  ) {
    issues.push({
      code: "event_repository_outside_pull_request",
      path: ["candidates", "kind"],
      message:
        "Only a pull request trigger has an event repository, so this trigger cannot take its candidates from one.",
    });
  }
  if (policy.expansion === "ask_once" && triggerType === "trigger_schedule") {
    issues.push({
      code: "ask_once_on_schedule",
      path: ["expansion"],
      message: "A schedule cannot ask about repositories, because nobody is there to answer.",
    });
  }
  if (
    policy.expansion === "ask_once" &&
    triggerType === "trigger_webhook" &&
    !options.webhookHasSubjectPath
  ) {
    issues.push({
      code: "ask_once_without_subject_path",
      path: ["expansion"],
      message:
        "A webhook can ask about repositories only when it configures a subject path, because without one every delivery is a new subject.",
    });
  }
  if (policy.candidates.kind === "listed") {
    const seen = new Set<string>();
    for (const [index, key] of policy.candidates.repositoryKeys.entries()) {
      const normalized = key.trim().toLowerCase();
      if (seen.has(normalized)) {
        issues.push({
          code: "duplicate_repository_key",
          path: ["candidates", "repositoryKeys", index],
          message: `Repository "${normalized}" is listed more than once.`,
        });
      }
      seen.add(normalized);
    }
  }
  return issues;
}
