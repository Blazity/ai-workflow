import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  writeDecisions: vi.fn(),
  findPr: vi.fn(),
  createPr: vi.fn(),
  recordIntent: vi.fn(),
  recordPr: vi.fn(),
  getBranchSha: vi.fn(),
  getPrHead: vi.fn(),
}));

vi.mock("../sandbox/trusted-workspace-publisher.js", () => ({
  publishTrustedWorkspaceFromSandbox: mocks.publish,
}));
vi.mock("../sandbox/write-human-decisions-memory.js", () => ({
  writeHumanDecisionsMemory: mocks.writeDecisions,
}));
vi.mock("./repository-prs.js", () => ({
  findWorkflowOwnedPullRequestForBranch: mocks.findPr,
  createOrFindWorkflowOwnedPullRequest: mocks.createPr,
  recordWorkflowOwnedPullRequestIntent: mocks.recordIntent,
  recordWorkflowOwnedPullRequest: mocks.recordPr,
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVcsRuntime: () => ({
    vcs: { getBranchSha: mocks.getBranchSha, getPRHead: mocks.getPrHead },
  }),
}));

import {
  finalizeWorkspacePublication,
  openPullRequestsForPublication,
  type FinalizedBranch,
} from "./workspace-publication.js";

const manifest: WorkspaceManifest = {
  version: 1,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/api",
      slug: "acme__api",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "blazebot/AIW-100",
      selectedRationale: "ticket repository",
      expectedRemoteSha: "before",
      preAgentSha: "before",
    },
  ],
};

const finalized: FinalizedBranch = {
  provider: "github",
  repoPath: "acme/api",
  branchName: "blazebot/AIW-100",
  defaultBranch: "main",
  expectedHead: "before",
  pushedHead: "after",
};

const common = {
  runId: "run-1",
  subjectKey: "ticket:jira:AIW-100",
  ownerToken: "owner-1",
  ticketKey: "AIW-100",
};

describe("workspace publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publish.mockResolvedValue({
      pushed: true,
      repositories: [
        {
          ...finalized,
          changed: true,
          pushed: true,
          targetHead: "after",
        },
      ],
    });
    mocks.writeDecisions.mockResolvedValue(undefined);
    mocks.findPr.mockResolvedValue(null);
    mocks.createPr.mockResolvedValue({
      provider: "github",
      repoPath: "acme/api",
      id: 12,
      url: "https://github.com/acme/api/pull/12",
      branch: "blazebot/AIW-100",
      isNew: true,
    });
    mocks.recordIntent.mockResolvedValue(undefined);
    mocks.recordPr.mockResolvedValue(undefined);
    mocks.getBranchSha.mockResolvedValue("after");
    mocks.getPrHead.mockResolvedValue({ headSha: "after", baseRef: "main", state: "open" });
  });

  it("returns exact finalized branch metadata without a publication id", async () => {
    const result = await finalizeWorkspacePublication({
      ...common,
      sandboxId: "sandbox-1",
      workspaceManifest: manifest,
      clarifications: [{ questions: ["Which API?"], answer: "Public API" }],
    });

    expect(mocks.writeDecisions).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSandboxId: "sandbox-1", workspaceManifest: manifest }),
    );
    expect(result).toMatchObject({ status: "finalized", repositories: [finalized] });
    expect(result).not.toHaveProperty("attemptId");
  });

  it("does not publish when the triggering PR identity is stale", async () => {
    mocks.getPrHead.mockResolvedValue({ headSha: "someone-else", baseRef: "main", state: "open" });
    const result = await finalizeWorkspacePublication({
      ...common,
      sandboxId: "sandbox-1",
      workspaceManifest: manifest,
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/api",
        prId: 7,
        headSha: "trigger-head",
        baseRef: "main",
      },
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("verifies the finalized branch before recording intent and ownership", async () => {
    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      repositories: [finalized],
    });

    expect(result.status).toBe("published");
    expect(mocks.getBranchSha.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordIntent.mock.invocationCallOrder[0],
    );
    expect(mocks.recordIntent).toHaveBeenCalledWith(
      expect.objectContaining({ publishedHeadSha: "after", targetBranch: "main" }),
    );
    expect(mocks.getPrHead.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordPr.mock.invocationCallOrder[0],
    );
  });

  it("does not claim or open a PR when the finalized branch moved", async () => {
    mocks.getBranchSha.mockResolvedValue("foreign-head");
    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      repositories: [finalized],
    });

    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("branch moved") });
    expect(mocks.recordIntent).not.toHaveBeenCalled();
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.recordPr).not.toHaveBeenCalled();
  });

  it("rejects a stale PR head before recording final ownership", async () => {
    mocks.getPrHead.mockResolvedValue({ headSha: "foreign-head", baseRef: "main", state: "open" });
    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      repositories: [finalized],
    });

    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("stale PR/MR head") });
    expect(mocks.recordPr).not.toHaveBeenCalled();
  });

  it("requires an exact existing source PR for review remediation", async () => {
    mocks.findPr.mockResolvedValue({
      provider: "github",
      repoPath: "acme/api",
      id: 9,
      url: "https://github.com/acme/api/pull/9",
      branch: "blazebot/AIW-100",
      isNew: false,
    });
    const result = await openPullRequestsForPublication({
      ...common,
      title: "Fix review",
      repositories: [finalized],
      sourcePullRequest: {
        provider: "github",
        repoPath: "acme/api",
        prId: 7,
        headSha: "before",
        baseRef: "main",
      },
    });

    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("exact source PR/MR #7") });
    expect(mocks.recordPr).not.toHaveBeenCalled();
  });
});
