import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_SCOPE_ORIGINS, workScopeOriginRank, type WorkScopeOrigin } from "@shared/contracts";
import type { Db } from "../client.js";
import { workScopeEntries, workScopes } from "../schema.js";
import { createTestDb } from "../test-db.js";
import { applyRunWorkScopePlan, readWorkScope } from "./work-scope.js";

/**
 * Lets one test write as an instance still running the previous deployment
 * does: same statement, the rank that deployment computes. Null everywhere
 * else, so every other write in this file ranks exactly as production code.
 */
const rollout = vi.hoisted(() => ({
  previousDeploymentRank: null as null | ((origin: string) => number),
}));
vi.mock("@shared/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/contracts")>();
  return {
    ...actual,
    workScopeOriginRank: (origin: WorkScopeOrigin) =>
      rollout.previousDeploymentRank?.(origin) ?? actual.workScopeOriginRank(origin),
  };
});

let db: Db;
const subjectKey = "ticket:jira:AWT-9";

beforeEach(async () => {
  rollout.previousDeploymentRank = null;
  db = await createTestDb();
});

/**
 * THE RANK EVERY STORED ROW ALREADY CARRIES, copied by hand from origin/main on
 * 2026-09-18 (`packages/contracts/work-scope.ts`, where the rank was still the
 * index in `WORK_SCOPE_ORIGINS`). Deliberately a literal and never computed from
 * the code under test: the database compares a freshly computed rank with the
 * one stamped when the row was written (`overwriteAllowed` in work-scope.ts), so
 * a number that moves inverts precedence for every record that already exists,
 * and for the minutes of a rollout it inverts it between two live deployments.
 */
const RANKS_ALREADY_STORED = {
  person: 0,
  workflow_owned_branch: 1,
  ticket_text: 2,
  trigger_policy: 3,
  inferred: 4,
} as const;

describe("origin ranks", () => {
  it("keeps every origin that existed before `delegated` at the rank its rows were stored with", () => {
    for (const [origin, rank] of Object.entries(RANKS_ALREADY_STORED)) {
      expect(
        workScopeOriginRank(origin as WorkScopeOrigin),
        `${origin} no longer ranks ${rank}. Rows already in work_scope_entries carry ${rank}, ` +
          "and the previous deployment keeps writing it during a rollout. A new origin gets a " +
          "rank of its own (a tie is fine); it never moves an existing one.",
      ).toBe(rank);
    }
  });

  it("ranks `delegated` beside a person's own word", () => {
    expect(workScopeOriginRank("delegated")).toBe(0);
  });
});

describe("migrations after 0068", () => {
  // The re-stamp is how a moved rank would reach stored rows, and the migration
  // runs in the build, minutes before the new code serves anything: for those
  // minutes the old code writes old numbers against re-stamped rows.
  it("never rewrite a stored origin_rank", () => {
    const drizzleDir = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
    const later = readdirSync(drizzleDir).filter((file) => {
      const number = /^(\d{4})_.*\.sql$/.exec(file)?.[1];
      return number !== undefined && Number(number) > 68;
    });
    expect(later, "no migration after 0068 was found; the scan reads the wrong directory").not.toEqual([]);

    const restamping = later.filter((file) =>
      readFileSync(`${drizzleDir}${file}`, "utf8")
        // Comments out, drizzle's `--> statement-breakpoint` marker included:
        // it sits right in front of the statement that follows it.
        .replace(/--[^\n]*/g, "")
        .split(";")
        .some(
          (statement) =>
            /^\s*UPDATE\s+("?public"?\.)?"?work_scope_entries"?\s/i.test(statement) &&
            /origin_rank/i.test(statement),
        ),
    );
    expect(restamping, "these migrations rewrite origin_rank on existing rows").toEqual([]);
  });
});

describe("a rollout, while the previous deployment still writes", () => {
  // The defect a re-stamp opens: the new code stamps a workflow-owned branch
  // with a moved number, the previous deployment's ticket text match arrives
  // with its own old number, the two compare equal, and the open pull
  // request's branch is dropped from the work.
  it("keeps a workflow_owned_branch row when a ticket_text write carries rank 2", async () => {
    const ownedBranch = {
      repositoryKey: "github:acme/api",
      state: "selected" as const,
      origin: "workflow_owned_branch" as const,
      rationale: "The run's open pull request lives on this branch.",
      decidedBy: { kind: "run" as const, runId: "run-new", definitionId: 4, definitionVersion: 7 },
      decidedAt: "2026-09-18T10:00:00.000Z",
    };
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-new",
      plan: { upserts: [{ entry: ownedBranch, replacesExpired: false }], deletes: [], trail: [] },
    });

    rollout.previousDeploymentRank = (origin) =>
      RANKS_ALREADY_STORED[origin as keyof typeof RANKS_ALREADY_STORED];
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-old",
      plan: {
        upserts: [
          {
            entry: {
              ...ownedBranch,
              state: "excluded",
              origin: "ticket_text",
              rationale: "The ticket rules it out.",
              decidedBy: { kind: "run", runId: "run-old", definitionId: 4, definitionVersion: 6 },
            },
            replacesExpired: false,
          },
        ],
        deletes: [],
        trail: [],
      },
    });

    await expect(readWorkScope(db, subjectKey)).resolves.toMatchObject({
      entries: [ownedBranch],
    });
  });
});

describe("work_scope_entries_origin_rank_check", () => {
  const ranks = WORK_SCOPE_ORIGINS.map((origin) => workScopeOriginRank(origin));

  it("spans exactly the ranks the origins declare", () => {
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
      "the origin_rank check's lower bound must stay 0, the highest precedence",
    ).toBe(Math.min(...ranks));
    expect(
      Number(upperText),
      "the origin_rank check's upper bound no longer equals the largest declared rank. " +
        "Giving an origin a rank past it without widening this constraint compiles cleanly and " +
        "passes every other test, then fails the FIRST production write of that origin at the " +
        "database with a check constraint violation.",
    ).toBe(Math.max(...ranks));
  });

  it("refuses an entry whose origin_rank falls outside the ladder, against the real database", async () => {
    await db.insert(workScopes).values({ subjectKey });

    await expect(
      db.insert(workScopeEntries).values({
        subjectKey,
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "ticket_text",
        // One past the largest declared rank. Still a well-typed number, which is
        // exactly the hazard the test above guards against: nothing here would
        // fail to compile if a rank grew and the migration's constraint did not.
        originRank: Math.max(...ranks) + 1,
        rationale: "Out of range on purpose, to prove the constraint is live.",
        decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
        decidedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
