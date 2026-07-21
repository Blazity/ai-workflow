import type { WorkflowBlockType } from "./domain.js";
import type { DEFAULT_AGENT_PROMPTS } from "./default-prompts.js";

export const DEFAULT_PROMPT_NAME_BY_AGENT: Partial<
  Record<WorkflowBlockType, keyof typeof DEFAULT_AGENT_PROMPTS>
> = {
  planning_agent: "research-plan",
  implementation_agent: "implement",
  review_agent: "review",
};
