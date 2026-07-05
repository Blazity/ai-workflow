import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db.js";
import {
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
});
