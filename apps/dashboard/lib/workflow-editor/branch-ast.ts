import type {
  JsonValue,
  WorkflowBranchConfigurationV2,
} from "@shared/contracts";

export function parseWorkflowBranchConfigurationV2(
  configuration: Readonly<Record<string, JsonValue>>,
): WorkflowBranchConfigurationV2 | null {
  if (
    (configuration.combinator !== "all" &&
      configuration.combinator !== "any") ||
    !Array.isArray(configuration.conditions)
  ) {
    return null;
  }
  return configuration as unknown as WorkflowBranchConfigurationV2;
}

export function summarizeWorkflowBranchConfiguration(
  configuration: WorkflowBranchConfigurationV2,
): string {
  if (configuration.conditions.length === 0) return "Condition needs setup";
  const joiner = configuration.combinator === "all" ? " AND " : " OR ";
  return configuration.conditions
    .map((condition) =>
      condition.operator === "has_value" ||
      condition.operator === "has_no_value"
        ? condition.operator.replaceAll("_", " ")
        : `${condition.operator.replaceAll("_", " ")} ${String(condition.value ?? "")}`,
    )
    .join(joiner);
}
