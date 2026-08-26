import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  writeDecisions: vi.fn(),
  assertGate: vi.fn(),
  findPr: vi.fn(),
  createPr: vi.fn(),
  recordIntent: vi.fn(),
  recordPr: vi.fn(),
  getBranchSha: vi.fn(),
  getPrHead: vi.fn(),
}));

// Keep the module's real exports: the finalized-branch verification depends on
// the read-after-write retry helper published from here, so stubbing the whole
// module would stub away the behaviour under test.
vi.mock("../sandbox/trusted-workspace-publisher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/trusted-workspace-publisher.js")>()),
  publishTrustedWorkspaceFromSandbox: mocks.publish,
}));
vi.mock("../sandbox/write-human-decisions-memory.js", () => ({
  writeHumanDecisionsMemory: mocks.writeDecisions,
}));
vi.mock("./workspace-gate.js", async (importOriginal) => ({
  // The real error class, because the boundary reads its `attribution` field to
  // decide what survives clamping. A stub class would answer instanceof and
  // silently drop the one fragment that names the culprit.
  ...(await importOriginal<typeof import("./workspace-gate.js")>()),
  assertCurrentWorkspaceGate: mocks.assertGate,
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
import { WorkspaceGateError } from "./workspace-gate.js";

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

/** A recovered scripts output, passed straight through to the gate. */
const SCRIPTS_FAILURE = {
  ok: false,
  outcome: "failed" as const,
  allPassed: false,
  anyFailed: true,
  groupStatuses: [],
  groupCoverage: [],
  uncoveredGroupCount: 0,
  results: [],
  failures: [
    { repo: "github:acme/api", command: "pnpm test", exitCode: 1, output: "", phase: null },
  ],
  dirtied: [],
  setupFailed: false,
  summary: "",
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
    mocks.assertGate.mockResolvedValue({
      required: false,
      reason: "missing_configuration",
      configurationVersion: null,
    });
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

    expect(mocks.assertGate).toHaveBeenCalledWith({
      sandboxId: "sandbox-1",
      workspaceManifest: manifest,
      gate: null,
    });
    expect(mocks.writeDecisions).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSandboxId: "sandbox-1", workspaceManifest: manifest }),
    );
    expect(result).toMatchObject({ status: "finalized", repositories: [finalized] });
    expect(result).not.toHaveProperty("attemptId");
  });

  it("opens one PR for each changed write repository", async () => {
    const second: FinalizedBranch = {
      ...finalized,
      provider: "gitlab",
      repoPath: "acme/web",
      branchName: "blazebot/AIW-100-web",
      pushedHead: "after-web",
    };
    mocks.createPr
      .mockResolvedValueOnce({
        provider: "github",
        repoPath: "acme/api",
        id: 12,
        url: "https://github.com/acme/api/pull/12",
        branch: finalized.branchName,
        isNew: true,
      })
      .mockResolvedValueOnce({
        provider: "gitlab",
        repoPath: "acme/web",
        id: 13,
        url: "https://gitlab.com/acme/web/-/merge_requests/13",
        branch: second.branchName,
        isNew: true,
      });
    mocks.getBranchSha
      .mockResolvedValueOnce(finalized.pushedHead)
      .mockResolvedValueOnce(second.pushedHead);
    mocks.getPrHead
      .mockResolvedValueOnce({
        headSha: finalized.pushedHead,
        baseRef: "main",
        state: "open",
      })
      .mockResolvedValueOnce({
        headSha: second.pushedHead,
        baseRef: "main",
        state: "open",
      });

    const result = await openPullRequestsForPublication({
      ...common,
      repositories: [finalized, second],
      title: "AIW-100",
      body: "Changes",
    });

    expect(result).toMatchObject({
      status: "published",
      repositories: [finalized, second],
      prs: [{ id: 12 }, { id: 13 }],
    });
    expect(mocks.createPr).toHaveBeenCalledTimes(2);
  });

  it("attempts every repository and aggregates failures instead of aborting on the first", async () => {
    const second: FinalizedBranch = {
      ...finalized,
      provider: "gitlab",
      repoPath: "acme/web",
      branchName: "blazebot/AIW-100-web",
      pushedHead: "after-web",
    };
    mocks.getBranchSha
      .mockResolvedValueOnce(finalized.pushedHead)
      .mockResolvedValueOnce(second.pushedHead);
    mocks.createPr
      .mockRejectedValueOnce(new Error("provider rejected acme/api"))
      .mockResolvedValueOnce({
        provider: "gitlab",
        repoPath: "acme/web",
        id: 13,
        url: "https://gitlab.com/acme/web/-/merge_requests/13",
        branch: second.branchName,
        isNew: true,
      });
    mocks.getPrHead.mockResolvedValueOnce({
      headSha: second.pushedHead,
      baseRef: "main",
      state: "open",
    });

    const result = await openPullRequestsForPublication({
      ...common,
      repositories: [finalized, second],
      title: "AIW-100",
      body: "Changes",
    });

    // The first repository's failure did not abort the loop: the second was still
    // attempted, its PR is kept, and the failure is aggregated into the result.
    expect(mocks.createPr).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "failed", prs: [{ id: 13 }] });
    if (result.status === "failed") {
      expect(result.reason).toContain("acme/api");
      expect(result.reason).toContain("provider rejected acme/api");
    }
  });

  it("succeeds without creating an empty PR when no write repository changed", async () => {
    const result = await openPullRequestsForPublication({
      ...common,
      repositories: [],
      title: "AIW-100",
      body: "No changes",
    });

    expect(result).toEqual({
      status: "published",
      repositories: [],
      prs: [],
    });
    expect(mocks.findPr).not.toHaveBeenCalled();
    expect(mocks.createPr).not.toHaveBeenCalled();
  });

  it("fails before every publication side effect when the workspace gate is stale", async () => {
    mocks.assertGate.mockRejectedValue(
      new Error("The Run Workspace changed after pre-publication checks passed."),
    );

    const result = await finalizeWorkspacePublication({
      ...common,
      sandboxId: "sandbox-1",
      workspaceManifest: manifest,
      prePrGate: {
        configurationVersion: 7,
        fingerprint: "stale-fingerprint",
      },
      clarifications: [{ questions: ["Which API?"], answer: "Public API" }],
    });

    expect(result).toEqual({
      status: "failed",
      failureKind: "pre_pr_gate",
      reason: "The Run Workspace changed after pre-publication checks passed.",
      repositories: [],
      prs: [],
    });
    expect(mocks.writeDecisions).not.toHaveBeenCalled();
    expect(mocks.getPrHead).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("carries the gate's attribution and the scripts verdict across the boundary", async () => {
    // Two separate things travel here, and both exist because a clamped
    // sentence loses them: who dirtied the tree, and whether the scripts
    // themselves failed.
    const attribution =
      "Repository scripts modified 1 tracked file in github:acme/api: src/generated.ts.";
    mocks.assertGate.mockRejectedValue(
      new WorkspaceGateError(
        "workspace_unverifiable",
        `Run Workspace is not clean for github:acme/api. ${attribution}`,
        attribution,
      ),
    );

    const result = await finalizeWorkspacePublication({
      ...common,
      sandboxId: "sandbox-1",
      workspaceManifest: manifest,
      prePrGate: null,
      scriptDrift: [
        { repo: "github:acme/api", files: ["src/generated.ts"], preExisting: [] },
      ],
      scriptsFailure: SCRIPTS_FAILURE,
    });

    expect(mocks.assertGate).toHaveBeenCalledWith(
      expect.objectContaining({
        dirtied: [
          { repo: "github:acme/api", files: ["src/generated.ts"], preExisting: [] },
        ],
        scriptsFailure: SCRIPTS_FAILURE,
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      failureKind: "pre_pr_gate",
      cause: attribution,
    });
  });

  it("reports no cause for a gate failure that named no culprit", async () => {
    mocks.assertGate.mockRejectedValue(
      new WorkspaceGateError(
        "workspace_changed",
        "The Run Workspace changed after pre-publication checks passed.",
      ),
    );

    const result = await finalizeWorkspacePublication({
      ...common,
      sandboxId: "sandbox-1",
      workspaceManifest: manifest,
      prePrGate: null,
    });

    expect(result).not.toHaveProperty("cause");
  });

  it("does not publish when the triggering PR was retargeted", async () => {
    mocks.getPrHead.mockResolvedValue({
      headSha: "trigger-head",
      baseRef: "develop",
      state: "open",
    });
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

  it("does not publish when the triggering PR is no longer open", async () => {
    mocks.getPrHead.mockResolvedValue({
      headSha: "trigger-head",
      baseRef: "main",
      state: "closed",
    });
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

  it("publishes when the triggering PR head is still the one that fired the trigger", async () => {
    mocks.getPrHead.mockResolvedValue({
      headSha: "trigger-head",
      baseRef: "main",
      state: "open",
    });
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

    expect(result).toMatchObject({ status: "finalized" });
    expect(mocks.publish).toHaveBeenCalled();
  });

  it("publishes when the fix agent already pushed its own work onto the triggering PR", async () => {
    // The agent commits and pushes from inside the sandbox, which is what makes
    // CI re-run, so the head at publication time is routinely ahead of the sha
    // the trigger recorded. Containment is proven inside publication, not here.
    mocks.getPrHead.mockResolvedValue({
      headSha: "pushed-by-this-run",
      baseRef: "main",
      state: "open",
    });
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

    expect(result).toMatchObject({ status: "finalized" });
    expect(mocks.publish).toHaveBeenCalled();
  });

  it("verifies the finalized branch before recording intent and ownership", async () => {
    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      body: "## What changed\nImplemented the ticket.",
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
      body: "## What changed\nImplemented the ticket.",
      repositories: [finalized],
    });

    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("branch moved") });
    expect(mocks.recordIntent).not.toHaveBeenCalled();
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.recordPr).not.toHaveBeenCalled();
  });

  it("rides out a 404 on the ref read that verifies the finalized branch", async () => {
    // Publication pushed this branch moments earlier, so the ref exists; a 404
    // here is the provider ref API lagging its own write.
    mocks.getBranchSha
      .mockReset()
      .mockRejectedValueOnce(Object.assign(new Error("ref read failed"), { status: 404 }))
      .mockResolvedValue("after");

    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      body: "## What changed\nImplemented the ticket.",
      repositories: [finalized],
    });

    expect(result.status).toBe("published");
    expect(mocks.getBranchSha).toHaveBeenCalledTimes(2);
  });

  it("fails the finalized branch verification on a non-404 ref read error", async () => {
    mocks.getBranchSha
      .mockReset()
      .mockRejectedValue(Object.assign(new Error("provider unavailable"), { status: 500 }));

    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      body: "## What changed\nImplemented the ticket.",
      repositories: [finalized],
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("provider unavailable"),
    });
    expect(mocks.getBranchSha).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale PR head before recording final ownership", async () => {
    mocks.getPrHead.mockResolvedValue({ headSha: "foreign-head", baseRef: "main", state: "open" });
    const result = await openPullRequestsForPublication({
      ...common,
      title: "Implement the ticket",
      body: "## What changed\nImplemented the ticket.",
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
      body: "## What changed\nAddressed the review.",
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
