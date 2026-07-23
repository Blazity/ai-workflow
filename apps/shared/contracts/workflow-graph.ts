import type { WorkflowBlockType } from "./domain.js";

export type BlockCategory = "trigger" | "action" | "control";

export interface BlockTypeSpec {
  category: BlockCategory;
  ports: string[];
  allowsFailurePort: boolean;
}

export const DEFAULT_OUT_PORT = "out";
export const FAILURE_PORT = "failed";

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

export const BLOCK_TYPE_SPECS: Record<WorkflowBlockType, BlockTypeSpec> = {
  trigger_ticket_ai: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  trigger_plan_approved: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  trigger_pr_created: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  trigger_pr_checks_failed: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  trigger_pr_review: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  trigger_pr_merged: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  planning_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  implementation_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  review_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  fix_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  generic_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  prepare_workspace: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  finalize_workspace: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  run_pre_pr_checks: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  run_checks: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  call_llm: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  transform: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  fetch_pr_context: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  open_pr: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  update_ticket_status: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  post_ticket_comment: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  post_pr_comment: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  send_slack_message: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  send_plan_approval: { category: "action", ports: [], allowsFailurePort: false },
  human_question: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  arthur_injection_check: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  branch: { category: "control", ports: ["true", "false"], allowsFailurePort: false },
  loop: { category: "control", ports: ["continue", "exhausted"], allowsFailurePort: false },
  terminate: { category: "control", ports: [], allowsFailurePort: false },
};

/** Ports an editor may wire from: the spec ports plus the failure port when allowed. */
export function wirablePorts(type: WorkflowBlockType): string[] {
  const spec = BLOCK_TYPE_SPECS[type];
  return spec.allowsFailurePort ? [...spec.ports, FAILURE_PORT] : [...spec.ports];
}

export const TRIGGER_BLOCK_TYPES: readonly WorkflowBlockType[] = (
  Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[]
).filter((type) => BLOCK_TYPE_SPECS[type].category === "trigger");

/** True when a block type can start a run (its category is "trigger"). */
export function isTriggerBlockType(type: WorkflowBlockType): boolean {
  return BLOCK_TYPE_SPECS[type].category === "trigger";
}

export const BLOCK_PARAM_KEYS: Record<WorkflowBlockType, readonly string[]> = {
  trigger_ticket_ai: [],
  trigger_plan_approved: [],
  trigger_pr_created: ["providers", "scope"],
  trigger_pr_checks_failed: [
    "providers",
    "scope",
    "checkNames",
    "githubAppSlugs",
    "gitlabPipelineSources",
  ],
  trigger_pr_review: ["providers", "scope", "on"],
  trigger_pr_merged: ["providers", "scope"],
  planning_agent: ["provider", "model", "prompt"],
  implementation_agent: ["provider", "model", "prompt"],
  review_agent: ["provider", "model", "prompt"],
  fix_agent: ["provider", "model", "instructions", "maxMinutes"],
  generic_agent: ["provider", "model", "prompt", "outputSchema", "workspaceMode"],
  prepare_workspace: [],
  finalize_workspace: [],
  run_pre_pr_checks: ["maxFixCycles"],
  run_checks: ["commands"],
  call_llm: ["prompt", "system", "model", "provider", "outputSchema"],
  transform: [],
  fetch_pr_context: [],
  open_pr: ["title", "body"],
  update_ticket_status: ["target"],
  post_ticket_comment: ["body"],
  post_pr_comment: ["body", "target"],
  send_slack_message: ["message", "sendOn"],
  send_plan_approval: ["mirrorComment"],
  human_question: ["questions", "suggestedAnswers"],
  arthur_injection_check: [],
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
  open_pr: ["title", "body"],
  send_slack_message: ["message"],
  human_question: ["questions"],
  terminate: ["postComment"],
};
