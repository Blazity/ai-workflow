import { beforeEach, describe, expect, it } from "vitest";

import type { WorkScopeEditRequest } from "@shared/contracts";
import type { Db } from "../../db/types.js";
import { createTestDb } from "../../db/test-db.js";
import { repositories, repositoryCatalogState, user } from "../../db/schema.js";
import {
  applyWorkScopeEdit,
  readWorkScopeRecord,
  type WorkScopeRecordView,
} from "./index.js";

const SUBJECT = "ticket:jira:AIW-401";
const API = "github:acme/api";
const WEB = "github:acme/web";
const OFFERED = "github:acme/offered";
const EDITOR = { id: "user_member" };
const NOW = new Date("2026-09-16T10:00:00.000Z");

let db: Db;

async function catalogRow(path: string, enabled: boolean): Promise<void> {
  await db
    .insert(repositories)
    .values({ provider: "github", path, source: "manual", enabled });
}

/** The catalog decides access: the bridge is over. */
async function activateCatalog(): Promise<void> {
  await db.insert(repositoryCatalogState).values({ id: 1, activated: true });
}

function edit(
  changes: WorkScopeEditRequest["changes"],
  expectedVersion = 0,
  subjectKey = SUBJECT,
): WorkScopeEditRequest {
  return { subjectKey, expectedVersion, changes };
}

function readRecord(input: {
  subjectKey: string;
  trail?: { limit?: number; beforeId?: number };
}): Promise<WorkScopeRecordView> {
  return readWorkScopeRecord(db, input);
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(user).values({
    id: "user_member",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  });
  await catalogRow("acme/api", true);
  await catalogRow("acme/web", true);
  await catalogRow("acme/offered", false);
});

describe("applyWorkScopeEdit", () => {
  it("selects a repository as the person's own decision", async () => {
    await activateCatalog();

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select", rationale: "it holds the fix" }]),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toEqual({
      kind: "applied",
      scope: {
        subjectKey: SUBJECT,
        version: 1,
        entries: [
          {
            repositoryKey: API,
            state: "selected",
            origin: "person",
            rationale: "it holds the fix",
            decidedBy: { kind: "person", actorId: "user_member", actorLabel: "Ada Lovelace" },
            decidedAt: NOW.toISOString(),
          },
        ],
      },
    });
  });

  // Nothing beside the record. Every selection this path records is recorded
  // without a usability check, so a field repeating that on every reply is a
  // constant wearing the clothes of news; the sentence lives in the route and
  // tool documentation instead.
  it("answers with the record and nothing else", async () => {
    await activateCatalog();

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select" }]),
      editor: EDITOR,
      now: NOW,
    });

    expect(Object.keys(outcome).sort()).toEqual(["kind", "scope"]);
  });

  it("excludes a repository, and the exclusion is the sticky one", async () => {
    await activateCatalog();

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: WEB, action: "exclude", rationale: "not this ticket" }]),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toMatchObject({
      kind: "applied",
      scope: { entries: [{ repositoryKey: WEB, state: "excluded", origin: "person" }] },
    });
  });

  it("removes an entry so the next run may decide again", async () => {
    await activateCatalog();
    const excluded = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: WEB, action: "exclude" }]),
      editor: EDITOR,
      now: NOW,
    });
    expect(excluded.kind).toBe("applied");

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: WEB, action: "remove" }], 1),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toEqual({
      kind: "applied",
      scope: { subjectKey: SUBJECT, version: 2, entries: [] },
    });
  });

  it("takes back an exclusion by selecting the repository again", async () => {
    await activateCatalog();
    await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "exclude" }]),
      editor: EDITOR,
      now: NOW,
    });

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select", rationale: "wrong call" }], 1),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toMatchObject({
      kind: "applied",
      scope: { entries: [{ repositoryKey: API, state: "selected", rationale: "wrong call" }] },
    });
  });

  it("rejects the whole edit when a select names a repository the catalog does not enable", async () => {
    await activateCatalog();

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([
        { repositoryKey: API, action: "select" },
        { repositoryKey: OFFERED, action: "select" },
      ]),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "not_enabled", repositoryKeys: [OFFERED] });
    // Nothing was written: the rejected change did not take the other one with
    // it into the record either.
    const record = await readRecord({ subjectKey: SUBJECT });
    expect(record).toMatchObject({ version: 0, entries: [], trail: [] });
  });

  it("selects any repository while the catalog is the bridge", async () => {
    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: OFFERED, action: "select" }]),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toMatchObject({
      kind: "applied",
      scope: { entries: [{ repositoryKey: OFFERED, state: "selected" }] },
    });
  });

  it("refuses a stale expected version with the version to read again", async () => {
    await activateCatalog();
    await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select" }]),
      editor: EDITOR,
      now: NOW,
    });

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: WEB, action: "select" }], 0),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "conflict", latestVersion: 1 });
    const record = await readRecord({ subjectKey: SUBJECT });
    expect(record.entries.map((entry) => entry.repositoryKey)).toEqual([API]);
  });

  it("refuses a subject that carries no record", async () => {
    await activateCatalog();

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select" }], 0, "schedule:sch_1:1757980800000"),
      editor: EDITOR,
      now: NOW,
    });

    expect(outcome).toEqual({
      kind: "subject_carries_no_record",
      subjectKey: "schedule:sch_1:1757980800000",
    });
  });

  it("records the label the caller states instead of the dashboard name", async () => {
    await activateCatalog();

    const outcome = await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select" }]),
      editor: { id: "user_member", label: "MCP client_7" },
      now: NOW,
    });

    expect(outcome).toMatchObject({
      kind: "applied",
      scope: {
        entries: [
          {
            decidedBy: { kind: "person", actorId: "user_member", actorLabel: "MCP client_7" },
          },
        ],
      },
    });
  });
});

describe("readWorkScopeRecord", () => {
  it("answers a subject kind that keeps no record, saying it keeps none", async () => {
    const record = await readRecord({ subjectKey: "schedule:sch_1:1757980800000" });

    expect(record).toEqual({
      subjectKey: "schedule:sch_1:1757980800000",
      carriesRecord: false,
      version: 0,
      entries: [],
      trail: [],
      nextTrailBeforeId: null,
    });
  });

  it("answers a subject with no record with the version an edit of it must expect", async () => {
    const record = await readRecord({ subjectKey: SUBJECT });

    expect(record).toEqual({
      subjectKey: SUBJECT,
      carriesRecord: true,
      version: 0,
      entries: [],
      trail: [],
      nextTrailBeforeId: null,
    });
  });

  it("returns the entries and the trail behind them together", async () => {
    await activateCatalog();
    await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select", rationale: "the fix lives here" }]),
      editor: EDITOR,
      now: NOW,
    });
    await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: WEB, action: "exclude", rationale: "not this ticket" }], 1),
      editor: EDITOR,
      now: NOW,
    });

    const record = await readRecord({ subjectKey: SUBJECT });

    expect(record.version).toBe(2);
    expect(record.entries.map((entry) => [entry.repositoryKey, entry.state])).toEqual([
      [API, "selected"],
      [WEB, "excluded"],
    ]);
    // Newest first, so the change a person is about to undo is the first line
    // they read.
    expect(record.trail.map((row) => row.event.kind)).toEqual(["entry_written", "entry_written"]);
    expect(record.trail[0]?.event).toMatchObject({
      kind: "entry_written",
      entry: { repositoryKey: WEB, state: "excluded" },
      previousState: null,
    });
    expect(record.trail[1]?.event).toMatchObject({
      kind: "entry_written",
      entry: { repositoryKey: API, state: "selected" },
    });
    expect(record.nextTrailBeforeId).toBeNull();
  });

  it("pages the trail newest first", async () => {
    await activateCatalog();
    await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: API, action: "select" }]),
      editor: EDITOR,
      now: NOW,
    });
    await applyWorkScopeEdit(db, {
      request: edit([{ repositoryKey: WEB, action: "select" }], 1),
      editor: EDITOR,
      now: NOW,
    });

    const first = await readRecord({
      subjectKey: SUBJECT,
      trail: { limit: 1 },
    });
    expect(first.trail).toHaveLength(1);
    expect(first.trail[0]?.event).toMatchObject({ entry: { repositoryKey: WEB } });
    expect(first.nextTrailBeforeId).not.toBeNull();

    const second = await readRecord({
      subjectKey: SUBJECT,
      trail: { limit: 1, beforeId: first.nextTrailBeforeId ?? undefined },
    });
    expect(second.trail[0]?.event).toMatchObject({ entry: { repositoryKey: API } });
    expect(second.nextTrailBeforeId).toBeNull();
  });

  it("serves a whole page at the trail page ceiling", async () => {
    const record = await readRecord({
      subjectKey: SUBJECT,
      trail: { limit: 200 },
    });

    expect(record.trail).toEqual([]);
  });
});
