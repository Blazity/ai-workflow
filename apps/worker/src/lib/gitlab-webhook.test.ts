import { describe, expect, it } from "vitest";
import {
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
} from "./gitlab-webhook.js";

const basePayload = {
  object_kind: "merge_request",
  user: { username: "alice", name: "Alice Example" },
  project: {
    id: 123,
    path_with_namespace: "group/demo",
  },
  object_attributes: {
    iid: 42,
    action: "open",
    source_branch: "blazebot/AIW-32",
    target_branch: "main",
    title: "AIW-32 GitLab parity",
    description: "Body",
    url: "https://gitlab.com/group/demo/-/merge_requests/42",
    draft: false,
    work_in_progress: false,
    last_commit: { id: "sha1" },
  },
};

describe("verifyGitLabWebhookToken", () => {
  it("accepts a valid token", () => {
    expect(() => verifyGitLabWebhookToken("secret", "secret")).not.toThrow();
  });

  it("rejects a missing token", () => {
    expect(() => verifyGitLabWebhookToken(undefined, "secret")).toThrow(/Missing/);
  });

  it("rejects an invalid token", () => {
    expect(() => verifyGitLabWebhookToken("wrong", "secret")).toThrow(/Invalid/);
  });
});

describe("normalizeGitLabMergeRequestEvent", () => {
  it("normalizes a merge request payload", () => {
    expect(normalizeGitLabMergeRequestEvent(basePayload)).toEqual({
      action: "opened",
      workflowInput: {
        prNumber: 42,
        headSha: "sha1",
        headRef: "blazebot/AIW-32",
        baseRef: "main",
        title: "AIW-32 GitLab parity",
        body: "Body",
        author: "alice",
        isDraft: false,
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
        ownerRepo: "group/demo",
      },
    });
  });

  it("maps GitLab merge request actions to post-PR gate actions", () => {
    expect(normalizeGitLabMergeRequestEvent(basePayload).action).toBe("opened");
    expect(
      normalizeGitLabMergeRequestEvent({
        ...basePayload,
        object_attributes: { ...basePayload.object_attributes, action: "reopen" },
      }).action,
    ).toBe("reopened");
    expect(
      normalizeGitLabMergeRequestEvent({
        ...basePayload,
        object_attributes: { ...basePayload.object_attributes, action: "update" },
      }).action,
    ).toBe("update");
  });

  it("treats draft, WIP, and prefixed titles as draft", () => {
    const draft = normalizeGitLabMergeRequestEvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, draft: true },
    });
    const workInProgress = normalizeGitLabMergeRequestEvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, work_in_progress: true },
    });
    const draftTitle = normalizeGitLabMergeRequestEvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, title: "Draft: AIW-32" },
    });
    const wipTitle = normalizeGitLabMergeRequestEvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, title: "WIP: AIW-32" },
    });

    expect(draft.workflowInput.isDraft).toBe(true);
    expect(workInProgress.workflowInput.isDraft).toBe(true);
    expect(draftTitle.workflowInput.isDraft).toBe(true);
    expect(wipTitle.workflowInput.isDraft).toBe(true);
  });

  it("falls back from description and author fields", () => {
    const namedAuthor = normalizeGitLabMergeRequestEvent({
      ...basePayload,
      user: { name: "Alice Example" },
      object_attributes: { ...basePayload.object_attributes, description: null },
    });
    const unknownAuthor = normalizeGitLabMergeRequestEvent({
      ...basePayload,
      user: {},
    });

    expect(namedAuthor.workflowInput.body).toBe("");
    expect(namedAuthor.workflowInput.author).toBe("Alice Example");
    expect(unknownAuthor.workflowInput.author).toBe("unknown");
  });

  it("rejects non merge request payloads", () => {
    expect(() =>
      normalizeGitLabMergeRequestEvent({ ...basePayload, object_kind: "push" }),
    ).toThrow(/merge request/i);
  });

  it("rejects malformed payloads", () => {
    expect(() =>
      normalizeGitLabMergeRequestEvent({
        ...basePayload,
        object_attributes: {
          ...basePayload.object_attributes,
          last_commit: {},
        },
      }),
    ).toThrow(/Malformed/);
  });
});

describe("projectMatchesConfiguredId", () => {
  it("matches a numeric id or path_with_namespace", () => {
    expect(projectMatchesConfiguredId(basePayload.project, "123")).toBe(true);
    expect(projectMatchesConfiguredId(basePayload.project, "group/demo")).toBe(true);
    expect(projectMatchesConfiguredId(basePayload.project, "other/demo")).toBe(false);
  });
});
