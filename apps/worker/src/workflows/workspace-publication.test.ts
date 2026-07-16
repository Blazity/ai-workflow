import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

const mocks = vi.hoisted(() => ({
  pushWorkspaceFromSandbox: vi.fn(),
  fixAndRetryWorkspacePush: vi.fn(),
  createOrUseWorkflowOwnedPullRequestsForRepos: vi.fn(),
  writeHumanDecisionsMemory: vi.fn(),
}));

vi.mock("../sandbox/poll-agent.js", () => ({
  pushWorkspaceFromSandbox: mocks.pushWorkspaceFromSandbox,
  fixAndRetryWorkspacePush: mocks.fixAndRetryWorkspacePush,
}));

vi.mock("../sandbox/write-human-decisions-memory.js", () => ({
  writeHumanDecisionsMemory: mocks.writeHumanDecisionsMemory,
}));

vi.mock("./repository-prs.js", () => ({
  createOrUseWorkflowOwnedPullRequestsForRepos: mocks.createOrUseWorkflowOwnedPullRequestsForRepos,
}));

import { publishWorkspaceChanges } from "./workspace-publication.js";

const selectedRepositories: SelectedRepository[] = [
  {
    provider: "github",
    repoPath: "acme/web",
    defaultBranch: "main",
    selectedRationale: "ticket mentions web",
  },
  {
    provider: "gitlab",
    repoPath: "acme/api",
    defaultBranch: "main",
    selectedRationale: "ticket mentions api",
  },
];

describe("publishWorkspaceChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the workspace push repair path before creating PRs", async () => {
    mocks.pushWorkspaceFromSandbox.mockResolvedValueOnce({
      pushed: false,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-45",
          changed: true,
          pushed: false,
          error: "pre-push hook declined",
        },
      ],
      error: "pre-push hook declined",
    });
    mocks.fixAndRetryWorkspacePush.mockResolvedValueOnce({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-45",
          changed: true,
          pushed: true,
        },
      ],
    });
    mocks.createOrUseWorkflowOwnedPullRequestsForRepos.mockResolvedValueOnce([
      {
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "blazebot/aiw-45",
        isNew: true,
      },
    ]);

    const result = await publishWorkspaceChanges({
      sandboxId: "sbx-1",
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      repositories: selectedRepositories,
      title: "Mixed provider task",
      agentKind: "codex",
      model: "gpt-5",
    });

    expect(mocks.fixAndRetryWorkspacePush).toHaveBeenCalledWith(
      "sbx-1",
      expect.objectContaining({ error: "pre-push hook declined" }),
      "codex",
      "gpt-5",
    );
    expect(mocks.createOrUseWorkflowOwnedPullRequestsForRepos).toHaveBeenCalledWith({
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      repositories: [selectedRepositories[0]],
      title: "Mixed provider task",
    });
    expect(result).toEqual({
      status: "published",
      pushResult: expect.objectContaining({ pushed: true }),
      prs: [
        expect.objectContaining({
          provider: "github",
          repoPath: "acme/web",
          id: 12,
        }),
      ],
    });
  });

  it("creates PRs for repositories pushed before a final partial failure", async () => {
    const failedPushResult = {
      pushed: false,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-45",
          changed: true,
          pushed: true,
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          branchName: "blazebot/aiw-45",
          changed: true,
          pushed: false,
          error: "protected branch",
        },
      ],
      error: "protected branch",
    };
    mocks.pushWorkspaceFromSandbox.mockResolvedValueOnce(failedPushResult);
    mocks.fixAndRetryWorkspacePush.mockResolvedValueOnce(failedPushResult);
    mocks.createOrUseWorkflowOwnedPullRequestsForRepos.mockResolvedValueOnce([
      {
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "blazebot/aiw-45",
        isNew: true,
      },
    ]);

    const result = await publishWorkspaceChanges({
      sandboxId: "sbx-1",
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      repositories: selectedRepositories,
      title: "Mixed provider task",
      agentKind: "claude",
      model: "claude-sonnet-4-20250514",
    });

    expect(mocks.createOrUseWorkflowOwnedPullRequestsForRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [selectedRepositories[0]],
      }),
    );
    expect(result).toEqual({
      status: "failed",
      reason: "protected branch",
      pushResult: failedPushResult,
      prs: [
        expect.objectContaining({
          provider: "github",
          repoPath: "acme/web",
          id: 12,
        }),
      ],
    });
  });

  it("writes the human decisions memory before pushing when clarifications exist", async () => {
    mocks.pushWorkspaceFromSandbox.mockResolvedValueOnce({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-45",
          changed: true,
          pushed: true,
        },
      ],
    });
    mocks.createOrUseWorkflowOwnedPullRequestsForRepos.mockResolvedValueOnce([
      {
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "blazebot/aiw-45",
        isNew: true,
      },
    ]);

    const clarifications = [
      { questions: ["Which flavor?"], answer: "vanilla", answeredBy: "Jane Doe" },
    ];

    await publishWorkspaceChanges({
      sandboxId: "sbx-1",
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      repositories: selectedRepositories,
      title: "Mixed provider task",
      agentKind: "claude",
      model: "claude-sonnet-4-20250514",
      clarifications,
    });

    expect(mocks.writeHumanDecisionsMemory).toHaveBeenCalledWith("sbx-1", "AIW-45", clarifications);
    expect(mocks.writeHumanDecisionsMemory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pushWorkspaceFromSandbox.mock.invocationCallOrder[0],
    );
  });

  it("skips the human decisions memory step when there are no clarifications", async () => {
    mocks.pushWorkspaceFromSandbox.mockResolvedValueOnce({
      pushed: true,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-45",
          changed: true,
          pushed: true,
        },
      ],
    });
    mocks.createOrUseWorkflowOwnedPullRequestsForRepos.mockResolvedValueOnce([
      {
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "blazebot/aiw-45",
        isNew: true,
      },
    ]);

    await publishWorkspaceChanges({
      sandboxId: "sbx-1",
      ticketKey: "AIW-45",
      branchName: "blazebot/aiw-45",
      repositories: selectedRepositories,
      title: "Mixed provider task",
      agentKind: "claude",
      model: "claude-sonnet-4-20250514",
    });

    expect(mocks.writeHumanDecisionsMemory).not.toHaveBeenCalled();
  });
});
