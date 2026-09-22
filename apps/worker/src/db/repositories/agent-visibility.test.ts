import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { buildAgentBriefing, type AgentBriefingBuildInput } from "@shared/agent-visibility";
import { beforeEach, describe, expect, it } from "vitest";
import { createVisibilityDetector } from "../../run-observability/visibility-detector.js";
import type { Db } from "../client.js";
import { agentBriefingTexts, clarificationRequests, workflowRuns } from "../schema.js";
import { createTestDb } from "../test-db.js";
import {
  appendClarificationAnswerDelivery,
  deleteExpiredAgentBriefings,
  listAgentBriefingRowsOfRun,
  listClarificationAnswerDeliveryRows,
  readAgentBriefingRecord,
  readAgentBriefingRunSummary,
  recordAgentBriefingRow,
  recordAgentBriefingRunFact,
  type RecordAgentBriefingRowInput,
} from "./agent-visibility.js";

const RUN = "wrun_storage";
const CAPTURED_AT = new Date("2026-09-19T10:15:00.000Z");
const detect = createVisibilityDetector({ secrets: [] });
const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
/** What the writer hashes: the index without the moment of the send, so the
 *  same send re-executed is not a different briefing. */
const contentSha = (index: { identity: Record<string, unknown> }) => {
  const { capturedAt: _stamped, ...identity } = index.identity;
  return sha(JSON.stringify({ ...index, identity }));
};

let db: Db;

function passInput(pass: number, runId = RUN): AgentBriefingBuildInput {
  return {
    identity: {
      runId,
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: pass,
      kind: "agent",
      blockType: "planning_agent",
      passLabel: `pass ${pass}`,
      capturedAt: CAPTURED_AT.toISOString(),
    },
    harness: { provider: "claude", model: "claude-sonnet-4-5-20250929" },
    sections: [
      // The ticket and the map repeat pass after pass; only the notes differ.
      { kind: "runtime", title: "Runtime data", text: "AWP-235: the checkout button does nothing." },
      { kind: "block", title: "Block role", text: `Plan the change, pass ${pass}.` },
    ],
    repositoryContext: null,
  };
}

async function recordPass(pass: number, runId = RUN) {
  const { index, texts } = await buildAgentBriefing(passInput(pass, runId), { sanitize: detect });
  const input: RecordAgentBriefingRowInput = {
    runId,
    nodeId: index.identity.nodeId,
    attempt: index.identity.attempt,
    activationScopeId: index.identity.activationScopeId,
    sequence: index.identity.sequence,
    kind: "agent",
    capture: "captured",
    index,
    contentSha256: contentSha(index),
    texts: texts.map((entry) => ({ sha256: entry.sha256, text: entry.text, bytes: Buffer.byteLength(entry.text) })),
    bytes: Buffer.byteLength(JSON.stringify(index)) + texts.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
    detail: null,
    capturedAt: CAPTURED_AT,
  };
  return { input, index, texts, result: await recordAgentBriefingRow(db, input) };
}

async function seedRun(runId: string, replayExpiresAt: Date | null) {
  await db.insert(workflowRuns).values({ runId, status: "running", ...(replayExpiresAt ? { replayExpiresAt } : {}) });
}

async function storedTextCount(): Promise<number> {
  return (await db.select().from(agentBriefingTexts)).length;
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("recordAgentBriefingRow", () => {
  // Red when: a briefing comes back as something other than what the package
  // built, so the dashboard and MCP would serve a record nobody can parse.
  it("returns a full briefing built by the package, texts and all", async () => {
    await seedRun(RUN, new Date("2026-10-19T10:15:00.000Z"));
    const { input, index, texts, result } = await recordPass(1);

    expect(result).toEqual({ outcome: "recorded", briefingId: expect.any(Number) });
    const record = await readAgentBriefingRecord(db, input);
    expect(record?.briefing.index).toEqual(JSON.parse(JSON.stringify(index)));
    expect(record?.texts).toEqual(
      texts.map((entry) => ({ sha256: entry.sha256, text: entry.text, bytes: Buffer.byteLength(entry.text) })),
    );
    expect(record?.missingTexts).toEqual([]);
    // The run's replay expiry, so a briefing never outlives the replay.
    expect(record?.briefing.expiresAt.toISOString()).toBe("2026-10-19T10:15:00.000Z");
  });

  // Red when: a replayed step writes the same briefing a second time, or a
  // second write is reported as a fresh one.
  it("stores one row for the same send written twice", async () => {
    const first = await recordPass(1);
    const second = await recordPass(1);

    expect(second.result).toEqual({ outcome: "already_recorded", briefingId: (first.result as { briefingId: number }).briefingId });
    expect(await listAgentBriefingRowsOfRun(db, RUN)).toHaveLength(1);
  });

  // Red when: a different send written under the same identity and sequence
  // overwrites the stored one, or is reported as stored.
  it("keeps the stored briefing when a different one arrives under its identity", async () => {
    const first = await recordPass(1);
    const other = await buildAgentBriefing(
      { ...passInput(1), sections: [{ kind: "runtime", title: "Runtime data", text: "something else entirely" }] },
      { sanitize: detect },
    );
    const conflicting: RecordAgentBriefingRowInput = {
      ...first.input,
      index: other.index,
      contentSha256: contentSha(other.index),
      texts: other.texts.map((entry) => ({ sha256: entry.sha256, text: entry.text, bytes: Buffer.byteLength(entry.text) })),
    };
    const result = await recordAgentBriefingRow(db, conflicting);

    expect(result).toEqual({
      outcome: "conflict",
      briefingId: (first.result as { briefingId: number }).briefingId,
      stored: { kind: "agent", capture: "captured", contentSha256: first.input.contentSha256 },
    });
    const record = await readAgentBriefingRecord(db, first.input);
    expect(record?.briefing.contentSha256).toBe(first.input.contentSha256);
    // The refused briefing left no text behind that nothing points at.
    expect(await storedTextCount()).toBe(first.input.texts.length);
  });

  // Red when: the capture time is part of what decides a conflict, so a step
  // that runs again stamps a new time, reads as a different briefing under the
  // same identity and logs a conflict nobody caused.
  it("calls the same send written again with a new capture time the same briefing", async () => {
    const first = await recordPass(1);
    const later = new Date("2026-09-19T11:45:00.000Z");
    const { index } = await buildAgentBriefing(
      { ...passInput(1), identity: { ...passInput(1).identity, capturedAt: later.toISOString() } },
      { sanitize: detect },
    );
    expect(JSON.stringify(index)).not.toBe(JSON.stringify(first.index));

    const again = await recordAgentBriefingRow(db, {
      ...first.input,
      index,
      contentSha256: contentSha(index),
      capturedAt: later,
    });

    expect(again).toEqual({ outcome: "already_recorded", briefingId: (first.result as { briefingId: number }).briefingId });
    expect(await listAgentBriefingRowsOfRun(db, RUN)).toHaveLength(1);
  });

  // Red when: every pass stores its own copy of the ticket and the map, which
  // is what makes a planning attempt cost megabytes.
  it("stores a text once however many passes send it", async () => {
    const first = await recordPass(1);
    const second = await recordPass(2);

    const shared = first.texts.filter((entry) => second.texts.some((other) => other.sha256 === entry.sha256));
    expect(shared).toHaveLength(1);
    expect(await storedTextCount()).toBe(3);
    const record = await readAgentBriefingRecord(db, second.input);
    expect(record?.texts.map((entry) => entry.sha256)).toEqual(second.texts.map((entry) => entry.sha256));
  });

  // Red when: a briefing becomes visible before the texts it points at, so a
  // reader opens a send and finds an empty prompt.
  it("writes no briefing when its texts cannot be written", async () => {
    const { input } = await recordPass(1);
    const broken: RecordAgentBriefingRowInput = {
      ...input,
      sequence: 2,
      texts: [...input.texts, { sha256: "not-a-sha256", text: "x", bytes: 1 }],
    };

    await expect(recordAgentBriefingRow(db, broken)).rejects.toThrow();
    expect(await readAgentBriefingRecord(db, { ...input, sequence: 2 })).toBeNull();
  });

  // Red when: a send made while capture was off leaves nothing behind, so a
  // reader is told "predates capture" about code that could capture.
  it("records a send made with capture off as a marker with no texts", async () => {
    const result = await recordAgentBriefingRow(db, {
      runId: RUN,
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
      kind: "agent",
      capture: "capture_disabled",
      index: null,
      contentSha256: null,
      texts: [],
      bytes: 0,
      detail: null,
      capturedAt: CAPTURED_AT,
    });

    expect(result.outcome).toBe("recorded");
    const [row] = await listAgentBriefingRowsOfRun(db, RUN);
    expect(row).toMatchObject({ capture: "capture_disabled", index: null, textSha256s: [] });
    // The marker is the briefings table's fact; the run's own facts are the
    // writer's second statement (`recordAgentBriefing`), not this one's.
  });

  // Red when: a run with no replay observation keeps its briefings for good.
  it("gives a run with no replay expiry the same thirty days", async () => {
    const { input } = await recordPass(1);
    const record = await readAgentBriefingRecord(db, input);
    expect(record?.briefing.expiresAt.toISOString()).toBe("2026-10-19T10:15:00.000Z");
  });

  // Red when: a send made by a run whose replay has already gone is born
  // expired and swept an hour later, so a person watching a parked run answer
  // its question opens the send and finds nothing.
  it("never writes a briefing that is already expired", async () => {
    await seedRun(RUN, new Date("2026-08-01T00:00:00.000Z"));
    const { input } = await recordPass(1);

    const record = await readAgentBriefingRecord(db, input);
    expect(record?.briefing.expiresAt.toISOString()).toBe("2026-10-19T10:15:00.000Z");
    expect(await deleteExpiredAgentBriefings({ db, now: new Date("2026-09-20T00:00:00.000Z") })).toEqual({
      briefings: 0,
      texts: 0,
    });
  });
});

describe("recordAgentBriefingRunFact", () => {
  // Red when: the row is written only where a briefing was, so a run whose
  // writes all failed has no row and reads back as a run from before capture.
  it("writes the row for a run that only ever failed, and counts each fact", async () => {
    expect(await readAgentBriefingRunSummary(db, RUN)).toBeNull();

    await recordAgentBriefingRunFact(db, RUN, "failed");
    await recordAgentBriefingRunFact(db, RUN, "failed");
    await recordAgentBriefingRunFact(db, RUN, "skipped");
    await recordAgentBriefingRunFact(db, RUN, "disabled");
    await recordAgentBriefingRunFact(db, RUN, "conflict");
    await recordAgentBriefingRunFact(db, RUN, "captured");

    expect(await readAgentBriefingRunSummary(db, RUN)).toMatchObject({
      runId: RUN,
      capturedCount: 1,
      disabledCount: 1,
      skippedCount: 1,
      failedCount: 2,
      conflictCount: 1,
    });
  });
});

describe("deleteExpiredAgentBriefings", () => {
  const HOURS = 60 * 60 * 1000;

  // Red when: an expired run's briefings stay, a text another run still sends
  // is swept with them, or the durable facts go with the replay.
  it("removes an expired run's briefings and leaves another run's shared text", async () => {
    await seedRun(RUN, new Date("2026-09-20T00:00:00.000Z"));
    await seedRun("wrun_other", new Date("2026-12-01T00:00:00.000Z"));
    // Swept a day past the floor every briefing carries (thirty days from the
    // send), with this run's replay long gone and the other run's still live.
    await db.insert(clarificationRequests).values({
      id: "clarification-kept",
      runId: RUN,
      questions: ["Which repositories?"],
      status: "answered",
    });
    await appendClarificationAnswerDelivery(db, {
      clarificationId: "clarification-kept",
      words: "github:acme/api",
      authorKind: "person",
      authorDisplay: "Filip",
      surface: "dashboard",
      reading: null,
      note: null,
      at: new Date("2026-09-19T10:00:00.000Z"),
    });
    const expiring = await recordPass(1);
    await recordAgentBriefingRunFact(db, RUN, "captured");
    // A different pass, so the two runs share the ticket text and each has one
    // of its own.
    const living = await recordPass(2, "wrun_other");
    const shared = expiring.texts.find((entry) => living.texts.some((other) => other.sha256 === entry.sha256))!;
    expect(shared).toBeDefined();

    const swept = await deleteExpiredAgentBriefings({
      db,
      now: new Date("2026-10-20T00:00:00.000Z"),
    });

    expect(swept).toEqual({ briefings: 1, texts: 1 });
    expect(await listAgentBriefingRowsOfRun(db, RUN)).toEqual([]);
    expect(await readAgentBriefingRecord(db, living.input)).not.toBeNull();
    const kept = await db.select().from(agentBriefingTexts);
    expect(kept.map((entry) => entry.sha256)).toContain(shared.sha256);
    // What the read model needs after the briefings are gone: the row itself
    // is the fact that this run's code could capture.
    expect(await readAgentBriefingRunSummary(db, RUN)).toMatchObject({ capturedCount: 1 });
    // And the answers a person gave, which are the history of their decision
    // rather than of a run's execution, outlive the replay.
    expect(await listClarificationAnswerDeliveryRows(db, ["clarification-kept"])).toHaveLength(1);
  });

  // Red when: a sweep deletes a briefing a capture has only just written, so
  // the text it points at could be released while another capture is pointing
  // at it with no transaction to stop either of them.
  it("leaves a briefing written inside the sweep grace for the next pass", async () => {
    // A run parked past its replay retention, and a briefing that has since
    // reached its own expiry: what holds it now is only the grace.
    await seedRun(RUN, new Date(Date.now() - 24 * HOURS));
    const { input } = await recordPass(1);
    await db.execute(sql`UPDATE agent_briefings SET expires_at = now() - interval '1 day'`);

    const swept = await deleteExpiredAgentBriefings({ db });

    expect(swept).toEqual({ briefings: 0, texts: 0 });
    expect(await readAgentBriefingRecord(db, input)).not.toBeNull();

    // And it is taken on a later pass, once nothing can still be pointing at
    // its texts from a statement this one cannot see.
    await db.execute(sql`UPDATE agent_briefings SET created_at = now() - interval '2 days'`);
    await db.execute(sql`UPDATE agent_briefing_texts SET last_referenced_at = now() - interval '2 days'`);
    expect(await deleteExpiredAgentBriefings({ db })).toEqual({ briefings: 1, texts: 2 });
  });

  // Red when: the sweep reads only the stored expiry, so a run whose replay
  // was extended after the send loses the briefings that replay still shows.
  it("keeps a briefing whose run can still be replayed", async () => {
    await seedRun(RUN, new Date(Date.now() + 30 * 24 * HOURS));
    const { input } = await recordPass(1);
    await db.execute(
      sql`UPDATE agent_briefings SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'`,
    );

    expect(await deleteExpiredAgentBriefings({ db })).toEqual({ briefings: 0, texts: 0 });
    expect(await readAgentBriefingRecord(db, input)).not.toBeNull();
  });

  // Red when: the sweep deletes a text whose row a capture has just bumped.
  // That capture's briefing is not in the sweep's snapshot yet, so nothing
  // else says the text is still needed, and there is no transaction to hold
  // the two apart.
  it("leaves a text a capture has just pointed at, and takes it once that briefing expires too", async () => {
    await seedRun(RUN, new Date("2026-08-20T00:00:00.000Z"));
    const first = await recordPass(1);
    const shared = first.texts[0]!.sha256;
    await db.execute(
      sql`UPDATE agent_briefings SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'`,
    );
    await db.execute(sql`UPDATE agent_briefing_texts SET last_referenced_at = now() - interval '2 days'`);
    // A capture running right now, whose own briefing this statement cannot
    // see yet, points at the shared text.
    await db.execute(sql`UPDATE agent_briefing_texts SET last_referenced_at = now() WHERE sha256 = ${shared}`);

    const swept = await deleteExpiredAgentBriefings({ db });

    expect(swept).toEqual({ briefings: 1, texts: 1 });
    expect(await readAgentBriefingRecord(db, first.input)).toBeNull();
    expect((await db.select().from(agentBriefingTexts)).map((entry) => entry.sha256)).toEqual([shared]);

    // That capture's briefing arrives, and goes the same way when its own
    // retention passes: the text it kept alive is released with it.
    const second = await recordPass(2);
    expect(second.texts.map((entry) => entry.sha256)).toContain(shared);
    await db.execute(
      sql`UPDATE agent_briefings SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'`,
    );
    await db.execute(sql`UPDATE agent_briefing_texts SET last_referenced_at = now() - interval '2 days'`);

    expect(await deleteExpiredAgentBriefings({ db })).toEqual({ briefings: 1, texts: 2 });
    expect(await storedTextCount()).toBe(0);
  });
});

describe("appendClarificationAnswerDelivery", () => {
  const CLARIFICATION = "clarification-1";
  const reading = (kind: string, readBy: "model" | "deterministic" = "model") => ({
    version: 1,
    outcome: { kind },
    readBy,
    readAt: "2026-09-19T10:00:00.000Z",
  });

  async function seedClarification() {
    await db.insert(clarificationRequests).values({
      id: CLARIFICATION,
      runId: RUN,
      questions: ["Which repositories?"],
      status: "pending",
    });
  }

  async function deliver(
    words: string,
    at: Date,
    extra: Partial<Parameters<typeof appendClarificationAnswerDelivery>[1]> = {},
  ) {
    return appendClarificationAnswerDelivery(db, {
      clarificationId: CLARIFICATION,
      words,
      authorKind: "person",
      authorDisplay: "Filip",
      surface: "jira",
      reading: reading("unclear"),
      note: null,
      at,
      ...extra,
    });
  }

  beforeEach(seedClarification);

  // Red when: a Jira weekend of poll ticks re-reading the same unchanged
  // answer buries the round under a row per tick.
  it("keeps two hundred identical arrivals as one delivery with its first and last time", async () => {
    const first = new Date("2026-09-19T10:00:00.000Z");
    for (let tick = 0; tick < 200; tick += 1) {
      await deliver("Filip: maybe the api one", new Date(first.getTime() + tick * 60_000));
    }

    const rows = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 200, words: "Filip: maybe the api one" });
    expect(rows[0]!.firstAt.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    expect(rows[0]!.lastAt.toISOString()).toBe("2026-09-19T13:19:00.000Z");
  });

  // Red when: the merge folds words a person said, came back from, and said
  // again into one delivery, losing the order they said them in.
  it("keeps A, B, A as three deliveries in order", async () => {
    await deliver("A", new Date("2026-09-19T10:00:00.000Z"));
    await deliver("B", new Date("2026-09-19T10:05:00.000Z"));
    await deliver("A", new Date("2026-09-19T10:10:00.000Z"));

    const rows = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(rows.map((row) => [row.words, row.count])).toEqual([
      ["A", 1],
      ["B", 1],
      ["A", 1],
    ]);
  });

  // Red when: the same words read two different ways are merged, so the
  // reading a person's answer really got is lost.
  it("keeps the same words read unclear and then accepted as two deliveries in order", async () => {
    await deliver("use the api one", new Date("2026-09-19T10:00:00.000Z"), {
      reading: reading("unclear", "deterministic"),
    });
    await deliver("use the api one", new Date("2026-09-19T10:02:00.000Z"), {
      reading: reading("repositories"),
      note: "Recorded github:acme/api.",
    });

    const rows = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(
      rows.map((row) => [
        (row.reading as { outcome: { kind: string } }).outcome.kind,
        (row.reading as { readBy: string }).readBy,
        row.note,
      ]),
    ).toEqual([
      ["unclear", "deterministic", null],
      ["repositories", "model", "Recorded github:acme/api."],
    ]);
  });

  // Red when: a later tick that posted nothing wipes the note the first
  // telling carried, or a first tell that posted nothing claims one.
  it("keeps the note of the telling that posted and never replaces it with nothing", async () => {
    await deliver("A", new Date("2026-09-19T10:00:00.000Z"), { note: null });
    await deliver("A", new Date("2026-09-19T10:01:00.000Z"), { note: "I could not read this." });
    await deliver("A", new Date("2026-09-19T10:02:00.000Z"), { note: null });

    const rows = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 3, note: "I could not read this." });
  });

  // Red when: a webhook and a poll tick composing the same new words at the
  // same moment each append a row, and the round shows one arrival twice.
  // (One process here, so this proves the merge rather than the chain that
  // decides the race between two of them.)
  it("keeps one delivery when the same words arrive twice at once", async () => {
    await Promise.all([
      deliver("Filip: use the api one", new Date("2026-09-19T10:00:00.000Z")),
      deliver("Filip: use the api one", new Date("2026-09-19T10:00:00.500Z")),
    ]);

    const rows = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2 });
  });

  // Red when: the same answer arriving through two surfaces reads as one
  // delivery, so nobody can tell where a person answered.
  it("keeps the same words from two surfaces apart", async () => {
    await deliver("A", new Date("2026-09-19T10:00:00.000Z"));
    await deliver("A", new Date("2026-09-19T10:01:00.000Z"), { surface: "dashboard" });

    const rows = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(rows.map((row) => row.surface)).toEqual(["jira", "dashboard"]);
  });
});
