import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROMPT_FALLBACKS } from "./prompts";

// `summary` and `feedback` are published verbatim into the PR body, the ticket
// comment and the PR review, so the built-in prompts must forbid platform
// bookkeeping (session memory, sandbox rules) in that text.
describe("published-text rules in the built-in prompts", () => {
  it("tells the implementation agent what the summary must not contain", () => {
    const implement = PROMPT_FALLBACKS["implement"];
    assert.ok(implement.includes("### What the summary must and must not contain"));
    assert.ok(
      implement.includes("is published verbatim into the pull request description a human reads"),
    );
    assert.ok(
      implement.includes(
        "Do NOT mention session memory, `ai-workflow/memory`, or any other platform-managed path.",
      ),
    );
    assert.ok(
      implement.includes("it is not part of the change and must never appear in the summary"),
    );
    assert.ok(implement.includes("Do NOT narrate the rules you followed."));
    assert.ok(
      implement.includes(
        "Not pushing, not opening a PR, and not committing a platform-managed path are the normal contract of every run",
      ),
    );
    assert.ok(implement.includes("Do NOT describe sandbox mechanics"));
    assert.ok(
      implement.includes('that belongs in `error` with `result: "failed"`, not in `summary`'),
    );
  });

  it("tells the review agent what the feedback must not contain", () => {
    const review = PROMPT_FALLBACKS["review"];
    assert.ok(review.includes("### What the feedback must and must not contain"));
    assert.ok(review.includes("is published into the pull request review a human reads"));
    assert.ok(
      review.includes(
        "Do NOT mention session memory, `ai-workflow/memory`, or any other platform-managed path.",
      ),
    );
    assert.ok(review.includes("Do NOT narrate the rules you followed."));
    assert.ok(
      review.includes(
        'If review itself could not be completed, that belongs in `error` with `result: "failed"`, not in `feedback`',
      ),
    );
  });

  it("forbids the research plan from planning session-memory steps", () => {
    const research = PROMPT_FALLBACKS["research-plan"];
    assert.ok(
      research.includes(
        "Reading, writing or committing `ai-workflow/memory/[TASK_ID].md`. Session memory is handled by the Process section above; it is never a step in the plan.",
      ),
    );
  });
});
