import { beforeEach, describe, expect, it } from "vitest";
import { REPOSITORY_SUGGESTION_OUTCOMES } from "@shared/contracts";
import type { Db } from "../client.js";
import { createTestDb } from "../test-db.js";
import { upsertRepositoryProfile } from "./repository-catalog.js";
import {
  countRepositorySuggestionsSince,
  insertRepositorySuggestion,
  listRepositorySuggestions,
} from "./repository-suggestions.js";

let db: Db;
let repositoryId: number;

beforeEach(async () => {
  db = await createTestDb();
  const saved = await upsertRepositoryProfile(db, {
    provider: "github",
    path: "acme/api",
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    actorId: "user_admin",
    actorLabel: "Admin",
    reason: "",
  });
  repositoryId = saved.id;
});

describe("repository suggestions", () => {
  it("records a proposal with the tokens the provider reported and no price", async () => {
    const row = await insertRepositorySuggestion(db, {
      repositoryId,
      actorId: "user_admin",
      actorLabel: "Admin",
      model: "claude-haiku-4-5",
      outcome: "proposed",
      usage: { inputTokens: 1_200, cachedTokens: 300, outputTokens: 90 },
    });

    expect(row).toMatchObject({
      repositoryId,
      model: "claude-haiku-4-5",
      outcome: "proposed",
      tokensInput: 1_200,
      tokensCached: 300,
      tokensOutput: 90,
      costUsd: null,
      error: "",
    });
  });

  it("records a call that produced no usage at all, which is what a timeout looks like", async () => {
    const row = await insertRepositorySuggestion(db, {
      repositoryId,
      actorId: "user_admin",
      actorLabel: "Admin",
      model: "claude-haiku-4-5",
      outcome: "timeout",
      usage: null,
      error: "The operation was aborted due to timeout",
    });

    expect(row).toMatchObject({
      outcome: "timeout",
      tokensInput: null,
      tokensCached: null,
      tokensOutput: null,
      error: "The operation was aborted due to timeout",
    });
  });

  it("accepts every outcome the contract names, against the real constraint", async () => {
    // This is what keeps the check constraint and REPOSITORY_SUGGESTION_OUTCOMES
    // in step. The constraint is spelled out as literals in the schema (a
    // parameterized `sql` fragment reaches the migration as `$1`), so only a
    // test that inserts each value against the migration as it actually ran can
    // say the two still agree.
    for (const outcome of REPOSITORY_SUGGESTION_OUTCOMES) {
      const row = await insertRepositorySuggestion(db, {
        repositoryId,
        actorId: "user_admin",
        actorLabel: "Admin",
        model: "claude-haiku-4-5",
        outcome,
        usage: null,
      });
      expect(row.outcome).toBe(outcome);
    }
  });

  it("refuses an outcome the contract does not name", async () => {
    await expect(
      insertRepositorySuggestion(db, {
        repositoryId,
        actorId: "user_admin",
        actorLabel: "Admin",
        model: "claude-haiku-4-5",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outcome: "nearly" as any,
        usage: null,
      }),
    ).rejects.toThrow();
  });

  it("lists a repository's calls newest first, and only that repository's", async () => {
    const other = await upsertRepositoryProfile(db, {
      provider: "github",
      path: "acme/web",
      description: "",
      rules: "",
      relationships: [],
      scriptGroups: null,
      gateGroups: null,
      actorId: "user_admin",
      actorLabel: "Admin",
      reason: "",
    });
    for (const outcome of ["failed", "malformed", "proposed"] as const) {
      await insertRepositorySuggestion(db, {
        repositoryId,
        actorId: "user_admin",
        actorLabel: "Admin",
        model: "claude-haiku-4-5",
        outcome,
        usage: null,
      });
    }
    await insertRepositorySuggestion(db, {
      repositoryId: other.id,
      actorId: "user_admin",
      actorLabel: "Admin",
      model: "claude-haiku-4-5",
      outcome: "proposed",
      usage: null,
    });

    const rows = await listRepositorySuggestions(db, repositoryId);
    expect(rows.map((row) => row.outcome)).toEqual(["proposed", "malformed", "failed"]);
  });

  it("counts a recent window for one repository and reports its oldest row", async () => {
    const other = await upsertRepositoryProfile(db, {
      provider: "github",
      path: "acme/ops",
      description: "",
      rules: "",
      relationships: [],
      scriptGroups: null,
      gateGroups: null,
      actorId: "user_admin",
      actorLabel: "Admin",
      reason: "",
    });
    for (let index = 0; index < 3; index += 1) {
      await insertRepositorySuggestion(db, {
        repositoryId,
        actorId: "user_admin",
        actorLabel: "Admin",
        model: "claude-haiku-4-5",
        outcome: "proposed",
        usage: null,
      });
    }
    await insertRepositorySuggestion(db, {
      repositoryId: other.id,
      actorId: "user_admin",
      actorLabel: "Admin",
      model: "claude-haiku-4-5",
      outcome: "proposed",
      usage: null,
    });

    const recent = await countRepositorySuggestionsSince(
      db,
      repositoryId,
      new Date(Date.now() - 60 * 60 * 1_000),
    );
    expect(recent.count).toBe(3);
    expect(recent.oldestAt).toBeInstanceOf(Date);

    // A window that starts after every row counts nothing, which is how the cap
    // lifts on its own rather than on somebody clearing the table.
    const future = await countRepositorySuggestionsSince(
      db,
      repositoryId,
      new Date(Date.now() + 60 * 1_000),
    );
    expect(future).toEqual({ count: 0, oldestAt: null });
  });
});
