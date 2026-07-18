import { describe, expect, it } from "vitest";
import { workflowOwnedBranches } from "../schema.js";
import { createTestDb } from "../test-db.js";
import {
  bindWorkflowOwnedPullRequestIntent,
  findWorkflowOwnedPullRequest,
  findWorkflowOwnedPullRequestIntent,
  listWorkflowOwnedBranchesForTicket,
  upsertWorkflowOwnedBranch,
} from "./workflow-owned-branches.js";

describe("workflow-owned branch records", () => {
  it("never lets a legacy null confirmed head authorize a later human push", async () => {
    const db = await createTestDb();
    await db.insert(workflowOwnedBranches).values({
      ticketKey: "AIW-legacy",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/legacy",
      publishedHeadSha: "workflow-head",
      prId: 41,
      prUrl: "https://github.com/acme/web/pull/41",
      prBranchName: "feature/legacy",
      // New confirmed-tuple columns are intentionally omitted to reproduce a
      // row created before the correlation migration.
    });

    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 41,
        branchName: "feature/legacy",
        publishedHeadSha: "human-head",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 41,
        branchName: "feature/legacy",
        publishedHeadSha: "workflow-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-legacy" });
  });

  it("does not wildcard a legacy confirmed target after a retarget intent", async () => {
    const db = await createTestDb();
    await db.insert(workflowOwnedBranches).values({
      ticketKey: "AIW-legacy",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/legacy",
      publishedHeadSha: "workflow-head",
      prId: 41,
      prUrl: "https://github.com/acme/web/pull/41",
      prBranchName: "feature/legacy",
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-legacy",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/legacy",
      publishedHeadSha: "workflow-head",
      targetBranch: "release",
      prCorrelationPending: true,
    });

    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 41,
        branchName: "feature/legacy",
        publishedHeadSha: "workflow-head",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequestIntent(db, {
        provider: "github",
        repoPath: "acme/web",
        branchName: "feature/legacy",
        publishedHeadSha: "workflow-head",
        baseBranch: "release",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-legacy" });
  });

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

  it("preserves confirmed correlation but hides its stale PR from a restarted ticket run", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      publishedHeadSha: "old-head",
      targetBranch: "main",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "blazebot/aiw-45",
      },
    });
    // Simulate cancellation after the intent write but before provider
    // reconciliation/correlation. The old confirmed PR must remain journaled,
    // but it must not become confirmed for the newly published head.
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      publishedHeadSha: "new-head",
      targetBranch: "main",
      prCorrelationPending: true,
    });

    await expect(listWorkflowOwnedBranchesForTicket(db, "AIW-45")).resolves.toEqual([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
      },
    ]);
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "old-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45", pr: { id: 42 } });
    await expect(
      findWorkflowOwnedPullRequestIntent(db, {
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });
  });

  it("atomically binds only an exact current branch/head/base PR-created event", async () => {
    const db = await createTestDb();
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      publishedHeadSha: "new-head",
      targetBranch: "main",
      prCorrelationPending: true,
    });

    await expect(
      bindWorkflowOwnedPullRequestIntent(db, {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
        baseBranch: "release",
        prNumber: 43,
        prUrl: "https://github.com/acme/web/pull/43",
      }),
    ).resolves.toBeNull();

    await expect(
      bindWorkflowOwnedPullRequestIntent(db, {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
        baseBranch: "main",
        prNumber: 43,
        prUrl: "https://github.com/acme/web/pull/43",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45", pr: { id: 43 } });
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 43,
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "new-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });
  });

  it("does not bind a stale PR-created event after a newer intent wins the CAS", async () => {
    const db = await createTestDb();
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      publishedHeadSha: "head-1",
      targetBranch: "main",
      prCorrelationPending: true,
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "blazebot/aiw-45",
      publishedHeadSha: "head-2",
      targetBranch: "main",
      prCorrelationPending: true,
    });

    await expect(
      bindWorkflowOwnedPullRequestIntent(db, {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "head-1",
        baseBranch: "main",
        prNumber: 43,
        prUrl: "https://github.com/acme/web/pull/43",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequestIntent(db, {
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "head-2",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });
  });

  it("binds a same-head replacement exactly once while preserving the old confirmed PR", async () => {
    const db = await createTestDb();
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/owned",
      publishedHeadSha: "same-head",
      targetBranch: "main",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "feature/owned",
      },
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/owned",
      publishedHeadSha: "same-head",
      targetBranch: "main",
      prCorrelationPending: true,
    });

    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45", pr: { id: 42 } });
    await expect(
      findWorkflowOwnedPullRequestIntent(db, {
        provider: "github",
        repoPath: "acme/web",
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });

    await expect(
      bindWorkflowOwnedPullRequestIntent(db, {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "main",
        prNumber: 43,
        prUrl: "https://github.com/acme/web/pull/43",
      }),
    ).resolves.toMatchObject({ pr: { id: 43 } });
    await expect(
      bindWorkflowOwnedPullRequestIntent(db, {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "main",
        prNumber: 44,
        prUrl: "https://github.com/acme/web/pull/44",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 43,
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45", pr: { id: 43 } });
  });

  it("keeps the confirmed target separate while a same-head retarget is pending", async () => {
    const db = await createTestDb();
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/owned",
      publishedHeadSha: "same-head",
      targetBranch: "main",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "feature/owned",
      },
    });
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      branchName: "feature/owned",
      publishedHeadSha: "same-head",
      targetBranch: "release",
      prCorrelationPending: true,
    });

    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45", pr: { id: 42 } });
    await expect(
      findWorkflowOwnedPullRequestIntent(db, {
        provider: "github",
        repoPath: "acme/web",
        branchName: "feature/owned",
        publishedHeadSha: "same-head",
        baseBranch: "release",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });
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
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-45" });
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 99,
        branchName: "feature/owned",
        publishedHeadSha: "published-sha",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "gitlab",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "published-sha",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "blazebot/aiw-45",
        publishedHeadSha: "published-sha",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
    await expect(
      findWorkflowOwnedPullRequest(db, {
        provider: "github",
        repoPath: "acme/web",
        prNumber: 42,
        branchName: "feature/owned",
        publishedHeadSha: "human-push",
        baseBranch: "main",
      }),
    ).resolves.toBeNull();
  });
});
