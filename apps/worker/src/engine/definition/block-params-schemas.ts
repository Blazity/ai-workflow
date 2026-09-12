/**
 * Every block type's parameter schema, in one map.
 *
 * A workflow definition's configuration is validated per block type, and the
 * schema for a type comes from two places: the block manifests, which own the
 * params their executor reads, and the configurations declared here, which own
 * the v2 runtime surface a manifest does not describe (trigger selection, rate
 * limits, loop carries, prompt authoring). Composing them here rather than
 * inside the definition rules keeps those rules free of the block modules: they
 * take this map as a parameter.
 *
 * The `satisfies` at the bottom is the exhaustiveness check. It stays at the
 * composition site, so a new block type fails to compile here rather than
 * validating against nothing at run time.
 */
import { z } from "zod";
import {
  PROMPT_SLOT_NAME_PATTERN,
  WEBHOOK_AUTH_SCHEMES,
  isSafeWorkflowInputName,
  repositoryScriptGroupNameSchema,
  type WorkflowBlockType,
} from "@shared/contracts";
import {
  prepareWorkspaceParams,
  finalizeWorkspaceParams,
  fixAgentParams,
  genericAgentParams,
  callLlmParams,
  fetchPrContextParams,
  investigateParams,
  runChecksParams,
  postTicketCommentParams,
  postPrCommentParams,
  humanQuestionParams,
  arthurInjectionCheckParams,
  leakReviewParams,
  sendPlanApprovalParams,
} from "./params.generated.js";
import {
  transformConfigurationSchema,
  workflowInputBindingV2Schema,
  v2BranchConfigurationSchema,
  v2LoopConfiguration,
  vcsProviderSelection,
} from "@shared/workflow-graph";

const emptyParams = z.object({}).strict();
const agentParams = z
  .object({
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/).optional(),
    provider: z.enum(["claude", "codex"]).optional(),
    prompt: z.string().trim().min(1).max(50000).optional(),
  })
  .strict();
const reviewStates = z.enum(["changes_requested", "commented"]);
const prTriggerScope = z.enum(["workflow_owned", "any"]);

/** Optional per-node start budget. Both keys optional: absent means unlimited.
 * rateLimitWindow is the fixed UTC window rateLimitMax applies to. */
const triggerRateLimitParams = {
  rateLimitMax: z.number().int().min(1).optional(),
  rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
};

const v2TriggerPrCreatedConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("workflow_owned"),
    ...triggerRateLimitParams,
  })
  .strict();
const v2TriggerPrReadyConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("any"),
    ...triggerRateLimitParams,
  })
  .strict();
const v2TriggerPrUpdatedConfiguration = v2TriggerPrReadyConfiguration;
const v2TriggerPrChecksFailedConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("workflow_owned"),
    checkNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    ignoreCheckNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    githubAppSlugs: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .default(["github-actions"]),
    gitlabPipelineSources: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .default(["merge_request_event"]),
    maxFixAttemptsPerPr: z.number().int().min(1).max(10).default(2),
    ...triggerRateLimitParams,
  })
  .strict();
const v2TriggerPrReviewConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github"]),
    on: z.array(reviewStates).min(1).default(["changes_requested"]),
    scope: prTriggerScope.default("workflow_owned"),
    maxRunsPerPr: z.number().int().min(1).max(30).default(10),
    ...triggerRateLimitParams,
  })
  .strict();
const v2TriggerPrMergedConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("workflow_owned"),
    ...triggerRateLimitParams,
  })
  .strict();
/** Dot-path into the delivered JSON body ("ticket.subject"). Reuses the shared
 * segment rule (`[A-Za-z0-9_-]+` per segment, no prototype-mutating names) so a
 * mapping authored here cannot traverse anywhere a binding could not. */
const webhookPayloadPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isSafeWorkflowInputName, {
    message: "Payload path contains an empty or unsafe segment.",
  });
/** Every key is optional: the block registry supplies the mapping defaults, and
 * the endpoint row carries the auth scheme, re-synced from this config on every
 * deploy (like any other block parameter). */
const v2TriggerWebhookConfiguration = z
  .object({
    provider: z.enum(["zendesk", "sentry"]).optional(),
    sourceIdPath: webhookPayloadPath.optional(),
    sourceUrlPath: webhookPayloadPath.optional(),
    customerContextPath: webhookPayloadPath.optional(),
    authScheme: z.enum(WEBHOOK_AUTH_SCHEMES).optional(),
    headerName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/,
        "Header name must be a valid HTTP header token.",
      )
      .optional(),
    requireTimestamp: z.boolean().optional(),
    timestampHeader: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/,
        "Header name must be a valid HTTP header token.",
      )
      .optional(),
    // Ceiling kept tight (15 minutes) so replay protection cannot be widened into
    // a multi-hour, two-sided replay window. The default stays 300 seconds.
    timestampToleranceSeconds: z.number().int().min(30).max(900).optional(),
    subjectPath: webhookPayloadPath.optional(),
    mapSubject: webhookPayloadPath.optional(),
    mapDescription: webhookPayloadPath.optional(),
    mapRequester: webhookPayloadPath.optional(),
    mapPriority: webhookPayloadPath.optional(),
    ...triggerRateLimitParams,
  })
  .strict()
  // Replay protection folds the timestamp into the HMAC signed message, so it is
  // meaningless for shared_token (a constant header has nothing to sign). Reject
  // the combination instead of silently no-opping into a false sense of safety.
  .superRefine((config, ctx) => {
    if (config.requireTimestamp === true && config.authScheme === "shared_token") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requireTimestamp"],
        message: "Replay protection requires the HMAC SHA-256 scheme.",
      });
    }
  });
/**
 * Smallest catch-up window an author may configure.
 *
 * The dial reads like "how stale a run may be", but what it actually buys is
 * "how many consecutive missed ticks I tolerate", because the scheduler
 * evaluates once a minute. At 1 minute, measured, a single two-minute stall of
 * the tick loses the run outright, and so does a steady 75 second delay; at 60
 * the same stall costs nothing. An author tightening this to avoid stale work
 * would instead be handing every hiccup of the platform cron a silently
 * swallowed run, so the floor is set where one lost tick is still survivable.
 */
const MIN_CATCH_UP_GRACE_MINUTES = 5;

/** Cron syntax is checked by the deployment validator, not by this schema.
 * Empty cron/taskTitle/taskDescription stay legal at this level so a
 * partially configured draft still saves; deployment separately refuses to
 * publish an incomplete one. */
const v2TriggerScheduleConfiguration = z
  .object({
    cron: z.string().default(""),
    timezone: z.string().default("UTC"),
    overlapPolicy: z.enum(["skip", "queue", "allow"]).default("skip"),
    /** Floor of 5, see MIN_CATCH_UP_GRACE_MINUTES. */
    catchUpGraceMinutes: z
      .number()
      .int()
      .min(
        MIN_CATCH_UP_GRACE_MINUTES,
        `catchUpGraceMinutes must be at least ${MIN_CATCH_UP_GRACE_MINUTES} minutes: the scheduler evaluates once a minute, so a smaller tolerance means a single missed tick silently loses the run.`,
      )
      .default(60),
    taskTitle: z.string().default(""),
    taskDescription: z.string().default(""),
    ...triggerRateLimitParams,
  })
  .strict();
/** Accepted and ignored. The repair loop maxFixCycles bounded is gone, but
 *  every definition deployed against it still carries the key, and a strict
 *  schema that drops a key stops those definitions from loading at all. The
 *  bound stays exactly as authored so nothing that used to be invalid becomes
 *  valid on the way past. */
const v2RunPrePrChecksConfiguration = z
  .object({ maxFixCycles: z.number().int().min(0).max(5).optional() })
  .strict();
/** run_scripts selects groups by name and nothing else. At least one: a node
 *  that runs no group verifies nothing while still reporting an outcome. */
const v2RunScriptsConfiguration = z
  .object({ groups: z.array(repositoryScriptGroupNameSchema).min(1) })
  .strict();
const v2OpenPrConfiguration = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
  })
  .strict();
const v2UpdateTicketStatusConfiguration = z
  .object({ target: z.string().trim().min(1).max(200) })
  .strict();
const v2SendSlackMessageConfiguration = z
  .object({
    message: z.string().trim().max(2000).optional(),
    sendOn: z.enum(["pr_ready", "always"]).optional(),
  })
  .strict();
const v2CreatePrCheckConfiguration = z
  .object({
    checkName: z.string().trim().min(1).max(200),
  })
  .strict();
const v2CompletePrCheckConfiguration = z
  .object({
    conclusion: z.enum(["success", "failure", "neutral"]),
    details: z.string().max(10_000).optional(),
    refreshHead: z.boolean().optional(),
  })
  .strict();
const v2TerminateConfiguration = z
  .object({
    terminalStatus: z.enum([
      "waiting_for_human",
      "failed",
      "skipped",
      "done",
    ]),
    postComment: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
const jsonSchemaDialect202012 = z
  .literal("https://json-schema.org/draft/2020-12/schema")
  .optional();
const v2PromptSlotBindings = z
  .record(
    z.string().regex(PROMPT_SLOT_NAME_PATTERN),
    workflowInputBindingV2Schema,
  )
  .optional();
const harnessProfileReferenceSchema = z
  .object({
    profileId: z.string().trim().min(1).max(200),
    version: z.number().int().positive(),
  })
  .strict()
  .optional();
const v2PromptAuthoringConfiguration = {
  harnessProfile: harnessProfileReferenceSchema,
  promptSlotBindings: v2PromptSlotBindings,
};

/** The v2 runtime consumes the same code-owned configuration surface as the
 * corresponding v1 executor. Transform and Branch keep their own typed
 * configuration validators, which the definition schema also parses directly. */
export const BLOCK_PARAMS_SCHEMAS = {
  trigger_ticket_ai: z.object(triggerRateLimitParams).strict(),
  trigger_plan_approved: emptyParams,
  trigger_pr_created: v2TriggerPrCreatedConfiguration,
  trigger_pr_ready: v2TriggerPrReadyConfiguration,
  trigger_pr_updated: v2TriggerPrUpdatedConfiguration,
  trigger_pr_checks_failed: v2TriggerPrChecksFailedConfiguration,
  trigger_pr_review: v2TriggerPrReviewConfiguration,
  trigger_pr_merged: v2TriggerPrMergedConfiguration,
  trigger_webhook: v2TriggerWebhookConfiguration,
  trigger_schedule: v2TriggerScheduleConfiguration,
  planning_agent: agentParams.extend(v2PromptAuthoringConfiguration),
  implementation_agent: agentParams.extend(v2PromptAuthoringConfiguration),
  review_agent: agentParams.extend(v2PromptAuthoringConfiguration),
  fix_agent: fixAgentParams.extend(v2PromptAuthoringConfiguration),
  generic_agent: genericAgentParams.extend({
    outputSchemaDialect: jsonSchemaDialect202012,
    ...v2PromptAuthoringConfiguration,
  }),
  prepare_workspace: prepareWorkspaceParams,
  finalize_workspace: finalizeWorkspaceParams,
  run_pre_pr_checks: v2RunPrePrChecksConfiguration,
  run_checks: runChecksParams,
  run_scripts: v2RunScriptsConfiguration,
  call_llm: callLlmParams.extend({
    outputSchemaDialect: jsonSchemaDialect202012,
  }),
  fetch_pr_context: fetchPrContextParams,
  investigate: investigateParams,
  open_pr: v2OpenPrConfiguration,
  update_ticket_status: v2UpdateTicketStatusConfiguration,
  post_ticket_comment: postTicketCommentParams,
  post_pr_comment: postPrCommentParams,
  create_pr_check: v2CreatePrCheckConfiguration,
  complete_pr_check: v2CompletePrCheckConfiguration,
  post_pr_review: emptyParams,
  send_slack_message: v2SendSlackMessageConfiguration,
  send_plan_approval: sendPlanApprovalParams,
  human_question: humanQuestionParams,
  arthur_injection_check: arthurInjectionCheckParams,
  leak_review: leakReviewParams,
  loop: v2LoopConfiguration,
  terminate: v2TerminateConfiguration,
  branch: v2BranchConfigurationSchema,
  transform: transformConfigurationSchema,
} satisfies Record<WorkflowBlockType, z.ZodTypeAny>;

export type BlockParamsSchemas = typeof BLOCK_PARAMS_SCHEMAS;
