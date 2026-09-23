/**
 * Whether a push on a pull request is one of ours.
 *
 * What rides on the answer is branch ownership. A push a person made takes the
 * branch away from the run that is working on it: the run is superseded and the
 * person's commits stand. A push the workflow itself made must not do that, or
 * every run would supersede itself at the moment it publishes. So a false
 * positive silently swallows somebody's work, and a false negative kills the
 * run that produced the commit. Both have happened here.
 *
 * The route is where the answer is used and `integration-webhook.test.ts` holds
 * that wiring. This file holds the decision, against the inputs a real delivery
 * carries.
 */
import { describe, expect, it } from "vitest";
import { isWorkflowGeneratedPush } from "./workflow-push-suppression.js";

/** A workflow-owned pull request whose recorded head is the one just pushed. */
const OWNED_AND_CURRENT = {
  currentHeadSha: "c0ffee1",
  producer: "ai-workflow-bot",
  botIdentity: "ai-workflow-bot",
  workflowPublishedHeadSha: "c0ffee1",
  workflowOwnedPullRequest: true,
} as const;

describe("isWorkflowGeneratedPush", () => {
  it("recognizes the head the run published", () => {
    expect(isWorkflowGeneratedPush(OWNED_AND_CURRENT)).toBe(true);
  });

  it("still recognizes our own push when the recorded head lags the event", () => {
    // The publisher pushes and the webhook arrives before the run has recorded
    // the new head, so the stored SHA is the previous one. Matching on the SHA
    // alone read this as a foreign push and superseded the run that had just
    // produced the commit. The bot identity backstops the SHA for exactly this
    // window.
    expect(isWorkflowGeneratedPush({
      ...OWNED_AND_CURRENT,
      currentHeadSha: "c0ffee2",
      workflowPublishedHeadSha: "c0ffee1",
    })).toBe(true);
  });

  it("lets a person's push take the branch back from a live run", () => {
    expect(isWorkflowGeneratedPush({
      ...OWNED_AND_CURRENT,
      currentHeadSha: "deadbee",
      producer: "alice",
    })).toBe(false);
  });

  it("leaves a pull request the workflow does not own alone", () => {
    // Same automation account, somebody else's branch: our login is not a
    // licence to swallow pushes on a pull request no run is publishing to.
    expect(isWorkflowGeneratedPush({
      currentHeadSha: "deadbee",
      producer: "ai-workflow-bot",
      botIdentity: "ai-workflow-bot",
    })).toBe(false);
  });

  it("matches the account across the shapes a provider spells it in", () => {
    // GitHub delivers an App as `<slug>[bot]`; an admin configures the slug,
    // and GitLab reports whatever case the account was created with.
    expect(isWorkflowGeneratedPush({
      ...OWNED_AND_CURRENT,
      currentHeadSha: "c0ffee2",
      producer: "AI-Workflow-Bot[bot]",
      botIdentity: "ai-workflow-bot",
    })).toBe(true);
  });

  it("dispatches a push on a repository we know nothing about", () => {
    // No ownership record and no configured bot login: everything the predicate
    // could compare is absent, and absent must never read as a match.
    expect(isWorkflowGeneratedPush({
      currentHeadSha: "deadbee",
      producer: "alice",
    })).toBe(false);
  });

  it("dispatches a delivery that carries no head at all", () => {
    // A payload with no head SHA against a pull request with no recorded head:
    // comparing two absent values as equal would swallow the whole delivery.
    expect(isWorkflowGeneratedPush({ producer: "alice" })).toBe(false);
  });

  it("does not let an unknown producer match an unconfigured bot", () => {
    expect(isWorkflowGeneratedPush({
      currentHeadSha: "deadbee",
      workflowOwnedPullRequest: true,
    })).toBe(false);
  });
});
