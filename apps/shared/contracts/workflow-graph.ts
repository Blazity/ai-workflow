import type { WorkflowBlockType } from "./domain.js";

export type BlockCategory = "trigger" | "action" | "control";

export interface BlockTypeSpec {
  category: BlockCategory;
  ports: string[];
  allowsFailurePort: boolean;
}

export const DEFAULT_OUT_PORT = "out";
export const FAILURE_PORT = "failed";

export const BLOCK_TYPE_SPECS: Record<WorkflowBlockType, BlockTypeSpec> = {
  trigger_ticket_ai: { category: "trigger", ports: [DEFAULT_OUT_PORT], allowsFailurePort: false },
  planning_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  implementation_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  review_agent: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  run_pre_pr_checks: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  open_pr: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  update_ticket_status: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
  send_slack_message: { category: "action", ports: [DEFAULT_OUT_PORT], allowsFailurePort: true },
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
  planning_agent: ["provider", "model"],
  implementation_agent: ["provider", "model"],
  review_agent: ["provider", "model"],
  run_pre_pr_checks: ["maxFixCycles"],
  open_pr: [],
  update_ticket_status: ["target"],
  send_slack_message: ["message"],
  branch: ["condition"],
  loop: ["maxAttempts", "onExhaust"],
  terminate: ["terminalStatus", "postComment"],
};
