/**
 * Two save outcomes the QA matrix found nothing asserting (rows P07 and P10).
 *
 * `authoring.test.ts` next door is a unit test with the database stubbed out,
 * because the outcome it pins is a refusal that must never read a row. These
 * two are the opposite: they are about what actually lands, so they run against
 * pglite and go through `saveRepositoryProfile` exactly as the route does.
 *
 * Both pin a contract that is easy to read the wrong way round, which is why
 * they are worth a test each:
 *   P07 `changedFields: []` does NOT mean "nothing happened".
 *   P10 a save with no concurrency token overwrites, silently and by design.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
// The auth barrel drags in the runtime environment, and a save takes exactly
// one thing from it: the label the version row records.
vi.mock("../auth/index.js", () => ({
  getConnectedDashboardUserLabel: async (userId: string) =>
    userId === "user_second" ? "Bob" : "Ada",
}));

const { saveRepositoryProfile } = await import("./authoring.js");
const { getCurrentRepositoryProfile, listRepositoryProfileVersions } = await import(
  "./versions.js"
);
const { loadRepositoryCatalogEntries } = await import("./store.js");

const FIRST = { role: "admin" as const, id: "user_first" };
const SECOND = { role: "admin" as const, id: "user_second" };

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
});

describe("saveRepositoryProfile, a create that sets no tracked field", () => {
  it("P07: answers changedFields [] with unchanged false, so the array never means 'nothing happened'", async () => {
    const saved = await saveRepositoryProfile({
      actor: FIRST,
      // Provider and path and nothing else: the whole body. Identity is not a
      // profile field, so there is no field for `changedFields` to name.
      request: { provider: "github", path: "acme/api", reason: "" },
      expectedId: 0,
    });

    expect(saved.changedFields).toEqual([]);
    // The pair is the contract. `unchanged` is the field that answers "did
    // anything happen"; `changedFields` answers "which fields moved", and on a
    // create the answer to the second can be "none" while the answer to the
    // first is "a repository now exists".
    expect(saved.unchanged).toBe(false);
    expect(saved.version).toBe(1);
    expect(saved.repository).toMatchObject({
      path: "acme/api",
      profileVersion: 1,
      // A profile save configures a repository; it never grants one.
      enabled: false,
      source: "manual",
    });
    expect(await listRepositoryProfileVersions(saved.repository.id)).toHaveLength(1);

    // And the contrast that makes the row worth pinning: the SAME empty array
    // on a second identical save, this time with unchanged true and no version
    // minted.
    const again = await saveRepositoryProfile({
      actor: FIRST,
      request: { provider: "github", path: "acme/api", reason: "" },
      expectedId: saved.repository.id,
    });
    expect(again.changedFields).toEqual([]);
    expect(again.unchanged).toBe(true);
    expect(again.version).toBe(1);
    expect(await listRepositoryProfileVersions(saved.repository.id)).toHaveLength(1);
  });
});

describe("saveRepositoryProfile, no expectedProfileVersion", () => {
  it("P10: a save carrying no token overwrites an edit made under it, and reports success", async () => {
    const created = await saveRepositoryProfile({
      actor: FIRST,
      request: {
        provider: "github",
        path: "acme/api",
        rules: "never force push",
        reason: "first",
      },
      expectedId: 0,
    });
    expect(created.version).toBe(1);

    // Somebody else saves while the first screen sits on v1.
    const theirs = await saveRepositoryProfile({
      actor: SECOND,
      request: {
        provider: "github",
        path: "acme/api",
        rules: "never force push, and rebase",
        reason: "theirs",
      },
      expectedId: created.repository.id,
    });
    expect(theirs.version).toBe(2);

    // The first screen saves what it loaded. It sends no
    // `expectedProfileVersion`, which is what a client written before the field
    // existed does, so `saveRepositoryProfile` takes the unconditional overload
    // of the statement and there is no predicate to refuse it.
    const mine = await saveRepositoryProfile({
      actor: FIRST,
      request: {
        provider: "github",
        path: "acme/api",
        rules: "never force push, and squash",
        reason: "built on v1",
      },
      expectedId: created.repository.id,
    });

    // Not a 409, not a warning, not a merge: a plain success on top of an edit
    // it never saw. The other edit survives only in the history.
    expect(mine.version).toBe(3);
    expect(mine.unchanged).toBe(false);
    expect(mine.changedFields).toEqual(["rules"]);
    const current = await getCurrentRepositoryProfile("github:acme/api");
    expect(current?.rules).toBe("never force push, and squash");
    expect(
      (await listRepositoryProfileVersions(created.repository.id)).map(
        (version) => version.version,
      ),
    ).toEqual([3, 2, 1]);

    // The same request WITH the stale token is the refusal, so the difference
    // is the token and nothing else.
    const refused = await saveRepositoryProfile({
      actor: FIRST,
      request: {
        provider: "github",
        path: "acme/api",
        rules: "still built on v1",
        expectedProfileVersion: 1,
        reason: "built on v1",
      },
      expectedId: created.repository.id,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as Error).message).toBe("repository_profile_conflict");
    const { entries } = await loadRepositoryCatalogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.profileVersion).toBe(3);
  });
});
