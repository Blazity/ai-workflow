import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_NAME_BY_AGENT } from "@shared/contracts";

describe("DEFAULT_PROMPT_NAME_BY_AGENT", () => {
  it("maps only first-party default agents to their versioned library prompts", () => {
    expect(DEFAULT_PROMPT_NAME_BY_AGENT).toEqual({
      planning_agent: "research-plan",
      implementation_agent: "implement",
      review_agent: "review",
    });
    expect(DEFAULT_PROMPT_NAME_BY_AGENT.generic_agent).toBeUndefined();
  });
});
