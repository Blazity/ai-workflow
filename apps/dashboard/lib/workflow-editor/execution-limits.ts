import type {
  WorkflowDefinition,
  WorkflowExecutionBudgets,
} from "@shared/contracts";

export type WorkflowExecutionLimitKey = keyof WorkflowExecutionBudgets;

export function executionLimitsFromDefinition(
  definition: WorkflowDefinition,
): WorkflowExecutionBudgets {
  return { ...(definition.budgets ?? {}) };
}

export function setExecutionLimit(
  limits: WorkflowExecutionBudgets,
  key: WorkflowExecutionLimitKey,
  value: number | undefined,
): WorkflowExecutionBudgets {
  const next = { ...limits };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
