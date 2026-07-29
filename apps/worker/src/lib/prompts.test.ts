import { describe, it, expect } from "vitest";

import { PROMPT_FALLBACKS } from "./prompts.js";

// `summary` and `feedback` are published verbatim into the PR body, the ticket
// comment and the PR review, so the built-in prompts must forbid platform
// bookkeeping (session memory, sandbox rules) in that text.
describe("published-text rules in the built-in prompts", () => {
  it("tells the implementation agent what the summary must not contain", () => {
    const implement = PROMPT_FALLBACKS["implement"];
    expect(implement).toContain("### What the summary must and must not contain");
    expect(implement).toContain(
      "is published verbatim into the pull request description a human reads",
    );
    expect(implement).toContain(
      "Do NOT mention session memory, `blazebot/memory`, or any other platform-managed path.",
    );
    expect(implement).toContain(
      "it is not part of the change and must never appear in the summary",
    );
    expect(implement).toContain("Do NOT narrate the rules you followed.");
    expect(implement).toContain(
      "Not pushing, not opening a PR, and not committing a platform-managed path are the normal contract of every run",
    );
    expect(implement).toContain("Do NOT describe sandbox mechanics");
    expect(implement).toContain(
      'that belongs in `error` with `result: "failed"`, not in `summary`',
    );
  });

  it("tells the review agent what the feedback must not contain", () => {
    const review = PROMPT_FALLBACKS["review"];
    expect(review).toContain("### What the feedback must and must not contain");
    expect(review).toContain("is published into the pull request review a human reads");
    expect(review).toContain(
      "Do NOT mention session memory, `blazebot/memory`, or any other platform-managed path.",
    );
    expect(review).toContain("Do NOT narrate the rules you followed.");
    expect(review).toContain(
      'If review itself could not be completed, that belongs in `error` with `result: "failed"`, not in `feedback`',
    );
  });

  it("forbids the research plan from planning session-memory steps", () => {
    const research = PROMPT_FALLBACKS["research-plan"];
    expect(research).toContain(
      "Reading, writing or committing `blazebot/memory/[TASK_ID].md`. Session memory is handled by the Process section above; it is never a step in the plan.",
    );
  });
});
