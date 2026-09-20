import {
  BLOCK_TYPE_SPECS,
  GENERATED_TRIGGER_BLOCK_TYPES,
  type BlockTypeSpec,
  type WorkflowBlockType,
} from "./block-catalog.generated";

export { BLOCK_TYPE_SPECS } from "./block-catalog.generated";
export type { BlockCategory, BlockTypeSpec, WorkflowBlockType } from "./block-catalog.generated";

export const DEFAULT_OUT_PORT = "out";
export const FAILURE_PORT = "failed";

/**
 * A block type an integration contributes: its integration's id, then the
 * block's own name. The id rule is the manifest's (`INTEGRATION_ID` in the
 * generator), written here because this package may not import the SDK.
 */
const INTEGRATION_BLOCK_TYPE = /^[a-z][a-z0-9]{2,31}_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Whether a stored definition may carry this block type.
 *
 * Core's catalog is generated from core's own blocks, so it holds neither a
 * block an integration contributes nor one whose integration this build has
 * stopped shipping. Refusing either here would make a definition published
 * yesterday unreadable today, and the node would vanish instead of saying what
 * is missing. Whether the block can actually RUN is a different question, and
 * the engine's block contract answers it by name.
 */
export function isStorableWorkflowBlockType(type: unknown): type is WorkflowBlockType {
  if (typeof type !== "string") return false;
  if (Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, type)) return true;
  return INTEGRATION_BLOCK_TYPE.test(type);
}

/**
 * The ports and category of a block type, for a caller holding only the type.
 *
 * A type core does not own answers with one action port. The graph uses this
 * where an edge names no port of its own, which an editor only ever writes for
 * a block that has exactly one; an integration block therefore names its first
 * port `out` (ADR-010), and the editor draws its real ports from the contract
 * the engine resolves, not from here.
 */
export function blockTypeSpecOf(type: WorkflowBlockType): BlockTypeSpec {
  return Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, type)
    ? BLOCK_TYPE_SPECS[type]
    : { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false };
}

const RESERVED_WORKFLOW_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** A block id or declared object field that dot-path bindings and conditions
 * can address without escaping. Numeric array indexes are handled separately
 * by the binding resolver and are intentionally not valid authored names. */
export function isWorkflowAddressablePathSegment(segment: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) &&
    !RESERVED_WORKFLOW_PATH_SEGMENTS.has(segment)
  );
}

/** A fixed or additional input name may use safe dot-separated segments.
 * Dots are part of the authored input name; each segment must remain safe for
 * object traversal and cannot use prototype-mutating property names. */
export function isSafeWorkflowInputName(name: string): boolean {
  if (name.trim() !== name) return false;
  const segments = name.split(".");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9_-]+$/.test(segment) &&
        !RESERVED_WORKFLOW_PATH_SEGMENTS.has(segment),
    )
  );
}

/** Ports an editor may wire from: the spec ports plus the failure port when allowed. */
export function wirablePorts(type: WorkflowBlockType): string[] {
  const spec = blockTypeSpecOf(type);
  return spec.allowsFailurePort ? [...spec.ports, FAILURE_PORT] : [...spec.ports];
}

const TRIGGER_BLOCK_TYPE_ORDER = [
  "trigger_ticket_ai",
  "trigger_plan_approved",
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
  "trigger_webhook",
  "trigger_schedule",
] as const satisfies readonly WorkflowBlockType[];

const GENERATED_TRIGGER_BLOCK_TYPE_SET = new Set(GENERATED_TRIGGER_BLOCK_TYPES);

export const TRIGGER_BLOCK_TYPES: readonly WorkflowBlockType[] =
  TRIGGER_BLOCK_TYPE_ORDER.filter(
    (type) => GENERATED_TRIGGER_BLOCK_TYPE_SET.has(type),
  );

/** Triggers a human can fire by hand from the editor. Both apps need this: the
 *  dashboard decides whether to offer "Run manually", and the worker fails closed
 *  on anything absent. It lives here so there is one list rather than a copy per
 *  app, and it is declared as two exhaustive halves rather than one allowlist
 *  because the omission is the failure mode: a deny-list in the dashboard silently
 *  offered manual dispatch for a schedule, whose modal then asked for a pull
 *  request URL and whose worker answered 422 with a message that was not true.
 *
 *  TRIGGER_BLOCK_TYPES uses the stable catalog order above, so the compiler
 *  cannot force a new trigger into one of these halves. A gate test asserts the
 *  two halves partition it exactly, the same way the block catalog mirror is
 *  gated. */
export const MANUALLY_DISPATCHABLE_TRIGGER_TYPES = [
  "trigger_ticket_ai",
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
] as const satisfies readonly WorkflowBlockType[];

/** The other half. A trigger belongs here when firing it by hand is meaningless
 *  rather than merely unimplemented: an approval fires from a decision, a webhook
 *  from a signed delivery, a schedule from its own row and clock. */
export const NON_DISPATCHABLE_TRIGGER_TYPES = [
  "trigger_plan_approved",
  "trigger_webhook",
  "trigger_schedule",
] as const satisfies readonly WorkflowBlockType[];

export type ManuallyDispatchableTrigger =
  (typeof MANUALLY_DISPATCHABLE_TRIGGER_TYPES)[number];

/**
 * Triggers whose run subject carries text somebody wrote: a ticket a person
 * filled in, and a delivery's own payload. An unbound input that names a
 * default gets something real on every run these start.
 *
 * Declared as two exhaustive halves rather than one list, the way
 * `MANUALLY_DISPATCHABLE_TRIGGER_TYPES` is, because the omission is the
 * failure mode: a trigger nobody classified would default to "authored" and
 * hand a screen a sentence we composed. A gate test asserts the halves
 * partition `TRIGGER_BLOCK_TYPES` exactly.
 */
export const AUTHORED_SUBJECT_TEXT_TRIGGER_TYPES = [
  "trigger_ticket_ai",
  "trigger_plan_approved",
  "trigger_webhook",
] as const satisfies readonly WorkflowBlockType[];

/**
 * The other half: core composes the subject snapshot, because the run has no
 * ticket to read. A pull request trigger is here even though such a run may
 * carry a ticket key, because "may" is not a guarantee, and publishing is
 * where a guarantee is what a graph author is owed: the snapshot of a pull
 * request without a ticket holds the pull request's URL and head, never its
 * body or its review comments.
 */
export const COMPOSED_SUBJECT_TEXT_TRIGGER_TYPES = [
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
  "trigger_schedule",
] as const satisfies readonly WorkflowBlockType[];

const AUTHORED_SUBJECT_TEXT_TRIGGER_SET: ReadonlySet<string> = new Set(
  AUTHORED_SUBJECT_TEXT_TRIGGER_TYPES,
);

/** Does every run this trigger starts carry subject text a person wrote? */
export function triggerCarriesAuthoredSubjectText(type: string): boolean {
  return AUTHORED_SUBJECT_TEXT_TRIGGER_SET.has(type);
}


export function isManuallyDispatchableTrigger(
  type: WorkflowBlockType,
): type is ManuallyDispatchableTrigger {
  return (MANUALLY_DISPATCHABLE_TRIGGER_TYPES as readonly WorkflowBlockType[]).includes(type);
}

export const V2_AGENT_BLOCK_TYPES = [
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
] as const satisfies readonly WorkflowBlockType[];

export function isV2AgentBlockType(
  type: WorkflowBlockType,
): type is (typeof V2_AGENT_BLOCK_TYPES)[number] {
  return (V2_AGENT_BLOCK_TYPES as readonly WorkflowBlockType[]).includes(type);
}

/** True when a block type can start a run (its category is "trigger"). */
export function isTriggerBlockType(type: WorkflowBlockType): boolean {
  return blockTypeSpecOf(type).category === "trigger";
}

export const BLOCK_PARAM_KEYS: Record<WorkflowBlockType, readonly string[]> = {
  trigger_ticket_ai: ["rateLimitMax", "rateLimitWindow", "repositoryPolicy"],
  trigger_plan_approved: [],
  trigger_pr_created: ["providers", "scope", "rateLimitMax", "rateLimitWindow", "repositoryPolicy"],
  trigger_pr_ready: ["providers", "scope", "rateLimitMax", "rateLimitWindow", "repositoryPolicy"],
  trigger_pr_updated: ["providers", "scope", "rateLimitMax", "rateLimitWindow", "repositoryPolicy"],
  trigger_pr_checks_failed: [
    "providers",
    "scope",
    "checkNames",
    "ignoreCheckNames",
    "githubAppSlugs",
    "gitlabPipelineSources",
    "maxFixAttemptsPerPr",
    "rateLimitMax",
    "rateLimitWindow",
    "repositoryPolicy",
  ],
  trigger_pr_review: [
    "providers",
    "scope",
    "on",
    "maxRunsPerPr",
    "rateLimitMax",
    "rateLimitWindow",
    "repositoryPolicy",
  ],
  trigger_pr_merged: ["providers", "scope", "rateLimitMax", "rateLimitWindow", "repositoryPolicy"],
  trigger_webhook: [
    "provider",
    "sourceIdPath",
    "sourceUrlPath",
    "customerContextPath",
    "authScheme",
    "headerName",
    "requireTimestamp",
    "timestampHeader",
    "timestampToleranceSeconds",
    "subjectPath",
    "mapSubject",
    "mapDescription",
    "mapRequester",
    "mapPriority",
    "rateLimitMax",
    "rateLimitWindow",
    "repositoryPolicy",
  ],
  trigger_schedule: [
    "cron",
    "timezone",
    "overlapPolicy",
    "catchUpGraceMinutes",
    "taskTitle",
    "taskDescription",
    "rateLimitMax",
    "rateLimitWindow",
    "repositoryPolicy",
  ],
  planning_agent: ["provider", "model", "prompt"],
  implementation_agent: ["provider", "model", "prompt"],
  review_agent: ["provider", "model", "prompt"],
  fix_agent: ["provider", "model", "instructions", "maxMinutes"],
  generic_agent: ["provider", "model", "prompt", "outputSchema", "workspaceMode"],
  prepare_workspace: [],
  finalize_workspace: [],
  run_pre_pr_checks: ["maxFixCycles"],
  run_checks: ["commands", "groups"],
  run_scripts: ["groups"],
  call_llm: ["prompt", "system", "model", "provider", "outputSchema"],
  transform: [],
  fetch_pr_context: [],
  investigate: [
    "providers",
    "slackChannels",
    "slackLookbackDays",
    "jiraJqlTemplate",
    "maxResults",
    "model",
  ],
  open_pr: ["title", "body"],
  update_ticket_status: ["target"],
  post_ticket_comment: ["body"],
  post_pr_comment: ["body", "target"],
  create_pr_check: ["checkName"],
  complete_pr_check: ["conclusion", "details", "refreshHead"],
  post_pr_review: [],
  send_slack_message: ["message", "sendOn"],
  send_plan_approval: ["mirrorComment"],
  human_question: ["questions", "suggestedAnswers"],
  leak_review: ["model", "llmScan", "maxDiffBytes"],
  branch: ["condition"],
  loop: ["maxAttempts", "onExhaust"],
  terminate: ["terminalStatus", "postComment"],
};

/**
 * String fields that intentionally carry user-authored prompt/prose content.
 * Machine-shaped strings such as Branch conditions and JSON Schema sources are
 * excluded so reference/token visitors never rewrite arbitrary data.
 */
export const WORKFLOW_PROMPT_PARAM_KEYS: Partial<
  Record<WorkflowBlockType, readonly string[]>
> = {
  planning_agent: ["prompt"],
  implementation_agent: ["prompt"],
  review_agent: ["prompt"],
  generic_agent: ["prompt"],
  call_llm: ["prompt", "system"],
  fix_agent: ["instructions"],
  post_ticket_comment: ["body"],
  post_pr_comment: ["body"],
  complete_pr_check: ["details"],
  open_pr: ["title", "body"],
  send_slack_message: ["message"],
  human_question: ["questions"],
  terminate: ["postComment"],
};
