import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db.js";
import {
  findWorkflowOwnedPullRequest,
  listWorkflowOwnedBranchesForTicket,
  upsertWorkflowOwnedBranch,
} from "./workflow-owned-branches.js";

describe("workflow-owned branch records", () => {
  it("lists only branches AI Workflow recorded for the ticket", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-46",
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-46",
      pr: {
        id: 43,
        url: "https://github.com/acme/api/pull/43",
        branch: "blazebot/aiw-46",
      },
    });

    await expect(listWorkflowOwnedBranchesForTicket(db, "AIW-45")).resolves.toEqual([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
      },
    ]);
  });

  it("upserts branch ownership and later PR metadata by ticket and repository", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "blazebot/aiw-45",
      },
    });

    await expect(listWorkflowOwnedBranchesForTicket(db, "AIW-45")).resolves.toEqual([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        pr: {
          id: 42,
          url: "https://github.com/acme/web/pull/42",
          branch: "blazebot/aiw-45",
        },
      },
    ]);
  });

  it("preserves existing PR metadata when branch ownership is upserted without PR data", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "blazebot/aiw-45",
      },
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
    });

    await expect(listWorkflowOwnedBranchesForTicket(db, "AIW-45")).resolves.toEqual([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        pr: {
          id: 42,
          url: "https://github.com/acme/web/pull/42",
          branch: "blazebot/aiw-45",
        },
      },
    ]);
  });

  it("explicitly replaces stale PR metadata when recording a new publication intent", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      publishedHeadSha: "old-head",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "blazebot/aiw-45",
      },
    });
    await upsertWorkflowOwnedBranch(
      db,
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
      },
      { replacePullRequest: true },
    );

    await expect(listWorkflowOwnedBranchesForTicket(db, "AIW-45")).resolves.toEqual([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
      },
    ]);
  });

  it("proves ownership only from an exact provider/repository/PR/branch correlation", async () => {
    const db = await createTestDb();
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/owned",
      publishedHeadSha: "published-sha",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "feature/owned",
      },
    });

    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "published-sha",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 99,
        branchName: "feature/owned",
        publishedHeadSha: "published-sha",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "gitlab",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "published-sha",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "published-sha",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "human-push",
      }),
    ).resolves.toBeNull();
  });
});
