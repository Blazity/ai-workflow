import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { WORK_SCOPE_ORIGINS } from "@shared/contracts";
import type { Db } from "../client.js";
import { workScopeEntries, workScopes } from "../schema.js";
import { createTestDb } from "../test-db.js";

let db: Db;
const subjectKey = "ticket:jira:AWT-9";

beforeEach(async () => {
  db = await createTestDb();
});

describe("WORK_SCOPE_ORIGINS", () => {
  it("stays in its current order and length", () => {
    expect(
      WORK_SCOPE_ORIGINS,
      "WORK_SCOPE_ORIGINS changed. Every work_scope_entries row already carries the " +
        "origin_rank that workScopeOriginRank(...) computed under the OLD order, and the " +
        "database only ever compares that stored number to a freshly computed one " +
        "(overwriteAllowed in work-scope.ts). Reordering entries, or inserting one anywhere " +
        "but the end, silently inverts precedence for every subject that already has a " +
        "record: nothing here fails to compile, because the array stays well typed either " +
        "way. A change to this order needs a migration that rewrites the origin_rank " +
        "column for existing rows, not just an edit to this array.",
    ).toEqual(["person", "workflow_owned_branch", "ticket_text", "trigger_policy", "inferred"]);
  });
});

describe("work_scope_entries_origin_rank_check", () => {
  it("keeps its upper bound equal to WORK_SCOPE_ORIGINS.length - 1", () => {
    // Read the literal bound out of apps/worker/src/db/schema/work-scopes.ts rather
    // than the generated migration SQL under drizzle/: the schema file is the single
    // place that declares this constraint, so there is exactly one literal to find and
    // no need to guess which migration last touched this column. The check() call
    // writes its bound as plain text in the sql template (not an interpolated JS
    // value), so the same digits land unparameterized in the migration SQL, which the
    // test below exercises for real.
    const schemaSource = readFileSync(
      fileURLToPath(new URL("../schema/work-scopes.ts", import.meta.url)),
      "utf8",
    );
    const match = schemaSource.match(
      /work_scope_entries_origin_rank_check"[\s\S]{0,80}?between (\d+) and (\d+)/,
    );
    expect(
      match,
      "could not find work_scope_entries_origin_rank_check's literal bound in work-scopes.ts",
    ).not.toBeNull();
    const [, lowerText, upperText] = match as RegExpMatchArray;

    expect(
      Number(lowerText),
      "the origin_rank check's lower bound must stay 0, the ladder's first index",
    ).toBe(0);
    expect(
      Number(upperText),
      "the origin_rank check's upper bound no longer equals WORK_SCOPE_ORIGINS.length - 1. " +
        "Adding an origin without widening this constraint compiles cleanly and passes every " +
        "other test, then fails the FIRST production write of that origin at the database with " +
        "a check constraint violation.",
    ).toBe(WORK_SCOPE_ORIGINS.length - 1);
  });

  it("refuses an entry whose origin_rank falls outside the ladder, against the real database", async () => {
    await db.insert(workScopes).values({ subjectKey });

    await expect(
      db.insert(workScopeEntries).values({
        subjectKey,
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "ticket_text",
        // One past the ladder's last valid index. Still a well-typed number, which is
        // exactly the hazard the two tests above guard against: nothing here would
        // fail to compile if the array grew and the migration's constraint did not.
        originRank: WORK_SCOPE_ORIGINS.length,
        rationale: "Out of range on purpose, to prove the constraint is live.",
        decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
        decidedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
