import { describe, it, expect } from "vitest";
import {
  normalizeGitLabEvent,
  normalizeGitLabEvents,
} from "./webhook.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "./review-markers.js";

/** A reply exactly as the ledger settler posts it into a review thread. */
function settlerReply(threadId: string): string {
  const marker = `<!-- ai-workflow:ledger:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
  return `Addressed in \`deadbeef\`.\nAdded the null check.\n\n${marker}`;
}

describe("normalizeGitLabEvent", () => {
  function mrPayload(action: string): any {
    return {
      object_kind: "merge_request",
      user: { username: "alice" },
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: {
        iid: 42,
        action,
        source_branch: "blazebot/aiw-3",
        target_branch: "main",
        title: "AIW-3",
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
        last_commit: { id: "sha1" },
      },
    };
  }

  function notePayload(): any {
    return {
      object_kind: "note",
      user: { id: 1, username: "alice" },
      project: {
        id: 5,
        path_with_namespace: "group/demo",
        web_url: "https://gitlab.example.com/group/demo",
      },
      object_attributes: {
        action: "create",
        noteable_type: "MergeRequest",
        note: "Please add a test",
        system: false,
      },
      merge_request: {
        id: 7,
        iid: 42,
        author_id: 8,
        source_branch: "blazebot/aiw-3",
        target_branch: "main",
        title: "AIW-3",
        last_commit: { id: "sha1" },
        draft: false,
      },
    };
  }

  it("maps an opened merge request to trigger_pr_created", () => {
    const evt = normalizeGitLabEvent("Merge Request Hook", mrPayload("open"), {
      deliveryId: "gitlab-delivery-1",
    });
    expect(evt).toEqual({
      delivery: {
        provider: "gitlab",
        producer: "alice",
        deliveryId: "gitlab-delivery-1",
      },
      triggerType: "trigger_pr_created",
      pr: {
        provider: "gitlab",
        repoPath: "group/demo",
        providerProjectId: 1,
        prNumber: 42,
        prUrl: "https://gitlab.com/group/demo/-/merge_requests/42",
        headRef: "blazebot/aiw-3",
        headSha: "sha1",
        baseRef: "main",
        title: "AIW-3",
        author: "alice",
        isDraft: false,
      },
    });
  });

  it("offers ready before created for one non-draft GitLab open delivery", () => {
    expect(
      normalizeGitLabEvents("Merge Request Hook", mrPayload("open"), {
        deliveryId: "gitlab-delivery-1",
      }).map((event) => event.triggerType),
    ).toEqual(["trigger_pr_ready", "trigger_pr_created"]);
  });

  it("does not drop bot-authored merge requests or pipelines globally", () => {
    const botMr = mrPayload("open");
    botMr.user.username = "blazebot";
    expect(
      normalizeGitLabEvent("Merge Request Hook", botMr, { botUsername: "blazebot" })
        ?.triggerType,
    ).toBe("trigger_pr_created");

    expect(
      normalizeGitLabEvent(
        "Pipeline Hook",
        {
          object_kind: "pipeline",
          user: { username: "blazebot" },
          project: { path_with_namespace: "group/demo" },
          object_attributes: { status: "failed", sha: "sha1" },
          merge_request: {
            iid: 42,
            source_branch: "blazebot/aiw-3",
            target_branch: "main",
          },
        },
        { botUsername: "blazebot" },
      )?.triggerType,
    ).toBe("trigger_pr_checks_failed");
  });

  it("never routes a merge request update", () => {
    expect(normalizeGitLabEvent("Merge Request Hook", mrPayload("update"))).toBeNull();
  });

  it("offers ready and updated when one GitLab event changes both draft state and head", () => {
    const payload = mrPayload("update");
    payload.oldrev = "old-head";
    payload.object_attributes.last_commit = { id: "new-head" };
    payload.object_attributes.draft = false;
    payload.changes = {
      last_commit: { previous: { id: "old-head" } },
      draft: { previous: true, current: false },
    };

    expect(
      normalizeGitLabEvents("Merge Request Hook", payload).map(
        (event) => event.triggerType,
      ),
    ).toEqual(["trigger_pr_ready", "trigger_pr_updated"]);
  });

  // The normalizer no longer takes the SHA a run published: which pushes are
  // ours is core's call, on the ownership record the integration cannot see.
  // The route makes it, and `integration-webhook.test.ts` holds that wiring;
  // the decision itself is held by `workflow-push-suppression.test.ts`.
  it("reports a GitLab update by a person, whatever head it carries", () => {
    const payload = mrPayload("update");
    payload.oldrev = "old-head";
    payload.object_attributes.last_commit = { id: "human-sha" };
    payload.user.username = "alice";
    expect(
      normalizeGitLabEvent("Merge Request Hook", payload, {
        botUsername: "blazebot",
      })?.triggerType,
    ).toBe("trigger_pr_updated");
  });

  it("maps a merged merge request to trigger_pr_merged", () => {
    const payload = mrPayload("merge");
    payload.object_attributes.merge_commit_sha = "merge-sha";
    payload.object_attributes.actioned_at = "2026-07-17T10:00:00Z";
    payload.object_attributes.updated_at = "2026-07-17T09:59:00Z";

    const evt = normalizeGitLabEvent("Merge Request Hook", payload, {
      deliveryId: "gitlab-merge-1",
    });

    expect(evt?.triggerType).toBe("trigger_pr_merged");
    expect(evt?.pr).toMatchObject({
      headSha: "sha1",
      mergeSha: "merge-sha",
      mergedAt: "2026-07-17T10:00:00Z",
    });
  });

  it("never infers requested changes from a GitLab merge-request note", () => {
    const evt = normalizeGitLabEvent("Note Hook", notePayload(), {
      deliveryId: "gitlab-review-1",
      reviewStates: ["changes_requested", "commented"],
    });

    expect(evt?.triggerType).toBe("trigger_pr_review");
    expect(evt?.pr).toMatchObject({
      prUrl: "https://gitlab.example.com/group/demo/-/merge_requests/42",
      author: "8",
    });
    expect(evt?.pr.review).toEqual({
      state: "commented",
      author: "alice",
      body: "Please add a test",
    });
  });

  it("does not map a GitLab note when only changes_requested is configured", () => {
    expect(
      normalizeGitLabEvent("Note Hook", notePayload(), {
        deliveryId: "gitlab-review-unsupported",
        reviewStates: ["changes_requested"],
      }),
    ).toBeNull();
  });

  it("maps an opted-in GitLab merge-request note to a commented review", () => {
    const evt = normalizeGitLabEvent(
      "Note Hook",
      notePayload(),
      { deliveryId: "gitlab-note-1", reviewStates: ["commented"] },
    );

    expect(evt?.triggerType).toBe("trigger_pr_review");
    expect(evt?.pr).toMatchObject({
      prUrl: "https://gitlab.example.com/group/demo/-/merge_requests/42",
      author: "8",
    });
    expect(evt?.pr.review).toEqual({
      state: "commented",
      author: "alice",
      body: "Please add a test",
    });
  });

  it("filters GitLab system notes, bot notes, and review states that were not configured", () => {
    const note = {
      ...notePayload(),
      user: { username: "blazebot" },
      object_attributes: { ...notePayload().object_attributes, note: "self" },
    };
    expect(
      normalizeGitLabEvent("Note Hook", note, {
        botUsername: "blazebot",
        reviewStates: ["commented"],
      }),
    ).toBeNull();
    expect(
      normalizeGitLabEvent(
        "Note Hook",
        {
          ...note,
          user: { username: "alice" },
          object_attributes: { ...note.object_attributes, system: true },
        },
        { reviewStates: ["commented"] },
      ),
    ).toBeNull();
    expect(
      normalizeGitLabEvent(
        "Note Hook",
        { ...note, user: { username: "alice" } },
        { reviewStates: ["changes_requested"] },
      ),
    ).toBeNull();
  });

  it("matches GitLab bot identities after trimming and case normalization", () => {
    const note = {
      ...notePayload(),
      user: { username: "gitlab-bot" },
      object_attributes: { ...notePayload().object_attributes, note: "self" },
    };
    expect(
      normalizeGitLabEvent("Note Hook", note, {
        botUsername: "  GitLab-Bot  ",
        reviewStates: ["commented"],
      }),
    ).toBeNull();
  });

  it("adds a semantic key derived from the GitLab note id", () => {
    const note = notePayload();
    note.object_attributes.id = 4321;
    const evt = normalizeGitLabEvent("Note Hook", note, {
      reviewStates: ["commented"],
    });
    expect(evt?.delivery.semanticKey).toBe("note:4321");
  });

  it("drops a GitLab note carrying the AI Workflow marker", () => {
    const note = notePayload();
    note.object_attributes.note = `looks good ${AI_WORKFLOW_COMMENT_MARKER}`;
    expect(
      normalizeGitLabEvent("Note Hook", note, { reviewStates: ["commented"] }),
    ).toBeNull();
  });

  it("drops a GitLab note that is the ledger settler's own thread reply", () => {
    const note = notePayload();
    note.object_attributes.note = settlerReply("d8f1a2b3");
    expect(
      normalizeGitLabEvent("Note Hook", note, { reviewStates: ["commented"] }),
    ).toBeNull();
  });

  it("fails closed on GitLab internal merge-request notes", () => {
    const note = notePayload();
    note.object_attributes.internal = true;

    expect(
      normalizeGitLabEvent("Note Hook", note, {
        reviewStates: ["commented"],
      }),
    ).toBeNull();
  });

  it("fails closed on GitLab confidential merge-request notes", () => {
    const note = notePayload();
    note.object_attributes.confidential = true;

    expect(
      normalizeGitLabEvent("Note Hook", note, {
        reviewStates: ["commented"],
      }),
    ).toBeNull();
  });

  it("maps a failed pipeline with a merge request to trigger_pr_checks_failed", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      user: { username: "alice" },
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: {
        id: 901,
        source: "merge_request_event",
        status: "failed",
        sha: "temporary-merged-results-sha",
      },
      merge_request: {
        iid: 42,
        source_branch: "blazebot/aiw-3",
        target_branch: "main",
        title: "AIW-3",
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
      },
      builds: [
        { name: "lint", status: "failed" },
        { name: "test", status: "success" },
      ],
    });
    expect(evt?.triggerType).toBe("trigger_pr_checks_failed");
    expect(evt?.delivery.producer).toBe("gitlab-ci");
    expect(evt?.pr.headRef).toBe("blazebot/aiw-3");
    expect(evt?.pr.headSha).toBe("temporary-merged-results-sha");
    expect(evt?.pr.failedChecks?.[0]?.handle).toEqual({
      kind: "job",
      container: 901,
      id: null,
    });
    expect(evt?.delivery.source).toBe("merge_request_event");
    expect(evt?.pr.failedChecks).toEqual([
      {
        handle: { kind: "job", container: 901, id: null },
        name: "lint",
        conclusion: "failed",
      },
    ]);
  });

  it.each([
    "AI Workflow / code-hygiene",
    "blazebot / code-hygiene",
  ])("ignores a GitLab pipeline containing only managed %s failures", (name) => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: {
        id: 902,
        source: "merge_request_event",
        status: "failed",
      },
      merge_request: {
        iid: 42,
        source_branch: "ai-workflow/aiw-3",
        target_branch: "main",
      },
      builds: [{ name, status: "failed" }],
    });

    expect(evt).toBeNull();
  });

  it("keeps external failures while suppressing managed GitLab checks", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: {
        id: 903,
        source: "merge_request_event",
        status: "failed",
      },
      merge_request: {
        iid: 42,
        source_branch: "ai-workflow/aiw-3",
        target_branch: "main",
      },
      builds: [
        { name: "AI Workflow / code-hygiene", status: "failed" },
        { name: "ci / build", status: "failed" },
      ],
    });

    expect(evt?.pr.failedChecks).toEqual([
      {
        handle: { kind: "job", container: 903, id: null },
        name: "ci / build",
        conclusion: "failed",
      },
    ]);
  });

  it("does not filter bot-created merge requests or external pipeline outcomes", () => {
    const created = normalizeGitLabEvent("Merge Request Hook", {
      ...mrPayload("open"),
      user: { username: "blazebot" },
    }, { botUsername: "blazebot" });
    expect(created?.triggerType).toBe("trigger_pr_created");

    const checks = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      user: { username: "blazebot" },
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: { status: "failed", sha: "sha1" },
      merge_request: {
        iid: 42,
        source_branch: "blazebot/aiw-3",
        target_branch: "main",
        title: "AIW-3",
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
      },
    }, { botUsername: "blazebot" });
    expect(checks?.triggerType).toBe("trigger_pr_checks_failed");
  });

  it("ignores a passing pipeline", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/demo" },
      object_attributes: { status: "success", sha: "sha1" },
      merge_request: { iid: 42, source_branch: "blazebot/aiw-3", target_branch: "main" },
    });
    expect(evt).toBeNull();
  });

  it("ignores a failed pipeline without a merge request", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/demo" },
      object_attributes: { status: "failed", sha: "sha1" },
    });
    expect(evt).toBeNull();
  });
});
