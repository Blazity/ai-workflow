// apps/dashboard/lib/agent-visibility/contract.test.ts
//
// The worker and the dashboard deploy separately, so what these guard is the
// day they disagree: one record written by a newer worker, or one broken row,
// must cost that record and never the screen around it.
import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_VISIBILITY_SCHEMA_VERSION } from "@shared/agent-visibility";

import {
  readAttemptBriefingsPage,
  readNodeLastBriefing,
  readSectionPage,
  readWorkScopeWithRounds,
} from "./contract";
import {
  EXPIRED_RUN,
  FIXTURE_DEFINITION,
  FIXTURE_SUBJECT,
  PLANNING_RUN,
  STATES_RUN,
  buildFixtureStore,
  serveFixture,
  type FixtureStore,
} from "./test-support/fixtures";

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

function get(path: string): unknown {
  const served = serveFixture(store, "GET", new URL(path, "http://worker.test"));
  assert.ok(served, `the fixtures do not serve ${path}`);
  assert.equal(served.status, 200, `${path} answered ${served.status}`);
  return served.body;
}

function attempt(runId: string, nodeId: string) {
  const page = readAttemptBriefingsPage(
    get(`/api/v1/runs/${runId}/briefings?nodeId=${nodeId}&attempt=1&activationScopeId=root`),
  );
  assert.ok(page.ok, page.ok ? "" : page.message);
  const found = page.value.items.find((item) => item.nodeId === nodeId);
  assert.ok(found, `no attempt ${nodeId}`);
  return found;
}

test("a send written by a newer worker names its version and leaves its siblings readable", () => {
  // `research` holds two sends: one rewritten to schema version 2, one ours.
  const found = attempt(STATES_RUN, "research");
  assert.equal(found.briefings.length, 2);
  const [newer, ours] = found.briefings;
  assert.equal(newer!.overview.ok, false);
  assert.equal(newer!.overview.ok === false ? newer!.overview.reason : null, "newer_version");
  assert.match(
    newer!.overview.ok === false ? newer!.overview.message : "",
    new RegExp(`schema version ${AGENT_VISIBILITY_SCHEMA_VERSION + 1}`),
  );
  assert.equal(ours!.overview.ok, true);
});

test("one broken item costs that item, by position, and not the page", () => {
  const body = get(`/api/v1/runs/${PLANNING_RUN}/briefings`) as { items: unknown[] };
  const broken = { ...body, items: [body.items[0], { nodeId: "planning" }, body.items[2]] };
  const page = readAttemptBriefingsPage(broken);
  assert.ok(page.ok, page.ok ? "" : page.message);
  assert.equal(page.value.items.length, 2);
  assert.deepEqual(
    page.value.unreadable.map((entry) => entry.position),
    [1],
  );
});

test("a newer envelope is refused as a whole, with the version in the message", () => {
  const body = get(`/api/v1/runs/${PLANNING_RUN}/briefings`) as object;
  const page = readAttemptBriefingsPage({ ...body, schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION + 3 });
  assert.equal(page.ok, false);
  assert.equal(page.ok === false ? page.reason : null, "newer_version");
  assert.match(page.ok === false ? page.message : "", /schema version 4/);
});

test("an attempt carries its own missing reason even when it has a send", () => {
  // Discovery went out, then the run stopped for a clarification: the pass
  // never went out, and that is a fact about the attempt, not about the send.
  const found = attempt(STATES_RUN, "planning");
  assert.equal(found.briefings.length, 1);
  assert.ok(found.missing?.ok);
  assert.equal(found.missing.ok ? found.missing.value.kind : null, "not_sent_yet");
});

test("a block that sends no prompt says so instead of carrying a reason", () => {
  const found = attempt(PLANNING_RUN, "trigger");
  assert.equal(found.sendsPrompts, false);
  assert.equal(found.missing, null);
  assert.deepEqual(found.briefings, []);
});

test("a section page reads as the bytes the worker stored", () => {
  const page = readSectionPage(get(`/api/v1/runs/${PLANNING_RUN}/briefings/brf_plan_2/sections/4?offset=0`));
  assert.ok(page.ok, page.ok ? "" : page.message);
  assert.equal(page.value.offset, 0);
  assert.ok(page.value.text.length > 0);
  // The section is longer than one page, so this page ends where the next
  // starts and the whole section is bigger than it.
  assert.equal(page.value.nextOffset, new TextEncoder().encode(page.value.text).length);
  assert.ok(page.value.totalBytes > page.value.nextOffset!);
});

test("a worker that does not serve rounds yet leaves the record readable", () => {
  const body = get(
    `/api/v1/work-scope?subjectKey=${encodeURIComponent(FIXTURE_SUBJECT)}&rounds=true`,
  ) as Record<string, unknown>;
  const { rounds: _rounds, ...withoutRounds } = body;
  const read = readWorkScopeWithRounds(withoutRounds);
  assert.ok(read.ok, read.ok ? "" : read.message);
  assert.equal(read.value.entries.length, 5);
  assert.equal(read.value.rounds.ok, false);
  assert.equal(read.value.rounds.ok === false ? read.value.rounds.reason : null, "absent");
});

test("an entry the dashboard cannot read is counted, not dropped silently", () => {
  const body = get(`/api/v1/work-scope?subjectKey=${encodeURIComponent(FIXTURE_SUBJECT)}&rounds=true`) as {
    entries: unknown[];
  };
  const read = readWorkScopeWithRounds({ ...body, entries: [...body.entries, { repositoryKey: 7 }] });
  assert.ok(read.ok, read.ok ? "" : read.message);
  assert.equal(read.value.entries.length, 5);
  assert.equal(read.value.unreadableEntries, 1);
  assert.ok(read.value.rounds.ok);
  assert.equal(read.value.rounds.ok ? read.value.rounds.value.items.length : 0, 4);
});

test("a record asked for without rounds reads as a record with no rounds served", () => {
  // Rounds are opt-in on the worker. A caller that does not ask gets the
  // record it always got, and this reader must not call that a failure.
  const body = get(`/api/v1/work-scope?subjectKey=${encodeURIComponent(FIXTURE_SUBJECT)}`);
  assert.equal(Object.hasOwn(body as object, "rounds"), false, "the fixture served rounds nobody asked for");
  const read = readWorkScopeWithRounds(body);
  assert.ok(read.ok, read.ok ? "" : read.message);
  assert.equal(read.value.entries.length, 5);
  assert.equal(read.value.rounds.ok, false);
});

test("a run says what state it is in, beside its attempts", () => {
  const live = readAttemptBriefingsPage(get(`/api/v1/runs/${PLANNING_RUN}/briefings`));
  assert.ok(live.ok, live.ok ? "" : live.message);
  assert.equal(live.value.runState, "available");

  // After retention a run has no attempts at all: the state is the only thing
  // left that can tell "we kept it and removed it" from "we lost it".
  const gone = readAttemptBriefingsPage(get(`/api/v1/runs/${EXPIRED_RUN}/briefings`));
  assert.ok(gone.ok, gone.ok ? "" : gone.message);
  assert.deepEqual(gone.value.items, []);
  assert.equal(gone.value.runState, "expired");
});

test("a state this build does not know is carried as itself, and silence is not a state", () => {
  const body = get(`/api/v1/runs/${PLANNING_RUN}/briefings`) as object;
  const invented = readAttemptBriefingsPage({ ...body, state: "quarantined" });
  assert.ok(invented.ok, invented.ok ? "" : invented.message);
  assert.equal(invented.value.runState, "quarantined");

  const { state: _state, ...silent } = body as Record<string, unknown>;
  const older = readAttemptBriefingsPage(silent);
  assert.ok(older.ok, older.ok ? "" : older.message);
  assert.equal(older.value.runState, null);
});

test("an attempt carries when it started, its loop turn, and an honest unknown", () => {
  const fix = attempt(STATES_RUN, "fix");
  assert.equal(fix.startedAt, "2026-09-19T08:33:00.000Z");
  // The worker reads the turn off the activation scope and serves the two
  // values it found, never a label: `{ loopNodeId, index }`.
  assert.deepEqual(fix.iteration, { loopNodeId: "fix-loop", index: 3 });
  assert.equal(fix.sendsPrompts, true);

  // Past the replay's life the definition snapshot is gone, so the worker
  // says it cannot tell rather than guessing from today's definition.
  const investigate = attempt(STATES_RUN, "investigate");
  assert.equal(investigate.sendsPrompts, null);
  assert.equal(investigate.iteration, null);
});

test("a turn of a loop with an id this build cannot read says nothing rather than half of it", () => {
  const body = get(`/api/v1/runs/${STATES_RUN}/briefings`) as { items: Record<string, unknown>[] };
  const items: Record<string, unknown>[] = [];
  for (const item of body.items) items.push(Object.assign({}, item, { iteration: { loopNodeId: "fix-loop" } }));
  const half = readAttemptBriefingsPage({ ...body, items });
  assert.ok(half.ok, half.ok ? "" : half.message);
  assert.ok(half.value.items.every((item) => item.iteration === null));
});

test("rows the worker could not read are counted on the page, not dropped in silence", () => {
  const page = readWorkScopeWithRounds(get(`/api/v1/work-scope?subjectKey=${encodeURIComponent(FIXTURE_SUBJECT)}&rounds=true`));
  assert.ok(page.ok, page.ok ? "" : page.message);
  assert.ok(page.value.rounds.ok);
  const rounds = page.value.rounds.ok ? page.value.rounds.value : null;
  assert.deepEqual(rounds?.unreadable, [
    {
      rows: "clarifications",
      position: 2,
      id: "clr_unreadable",
      problem: "question.askedAt: must be an ISO 8601 time",
    },
  ]);
  // The worker leaves them out of `total` too, so a count of questions never
  // includes one nobody can open.
  assert.equal(rounds?.total, rounds?.items.length);
});

test("an item this build cannot read joins the worker's own refusals on the page", () => {
  const body = get(`/api/v1/runs/${PLANNING_RUN}/briefings`) as { items: unknown[] };
  const read = readAttemptBriefingsPage({ ...body, items: [...body.items, { nodeId: 42 }] });
  assert.ok(read.ok, read.ok ? "" : read.message);
  const mine = read.value.unreadable.filter((entry) => entry.rows === null);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.problem, /expected the attempt's node/);
});

/* ── What one block last sent ──────────────────────────────────────────── */

function lastBriefing(nodeId: string) {
  const read = readNodeLastBriefing(
    get(`/api/v1/workflow-definitions/${FIXTURE_DEFINITION}/nodes/${nodeId}/last-briefing`),
  );
  assert.ok(read.ok, read.ok ? "" : read.message);
  return read.value;
}

test("a briefing id the worker serves as a row number is read, not refused", () => {
  // The worker types `briefingId` as the briefing row's number
  // (`briefings.push({ briefingId: row.id })`,
  // apps/worker/src/services/agent-visibility/briefing-read.ts). A reader that
  // insisted on a string would lose the whole attempt, and with it every send
  // of the run, on the day the real route replaces these fixtures.
  const page = readAttemptBriefingsPage({
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    cursor: null,
    nextCursor: null,
    total: 1,
    shortened: [],
    unreadable: [],
    state: "available",
    items: [
      {
        nodeId: "planning",
        attempt: 1,
        activationScopeId: "root",
        startedAt: "2026-09-19T08:29:00.000Z",
        iteration: null,
        sendsPrompts: true,
        briefings: [{ briefingId: 4210, overview: null }],
        missing: null,
      },
    ],
  });
  assert.ok(page.ok, page.ok ? "" : page.message);
  assert.equal(page.value.unreadable.length, 0);
  assert.equal(page.value.items[0]!.briefings[0]!.briefingId, "4210");
});

test("the last briefing of a block names the run and the version that ran it", () => {
  const read = lastBriefing("research");
  assert.equal(read.absent, null);
  assert.equal(read.ranIn?.runId, STATES_RUN);
  // Not the version on the canvas: the newest run of a block wins whatever
  // version it ran, which is the whole reason the number is served.
  assert.equal(read.ranIn?.definitionVersion, 9);
  assert.equal(read.ranIn?.state, "available");
  assert.ok(read.attempt?.ok);
  assert.equal(read.attempt.ok ? read.attempt.value.briefings.length : 0, 2);
});

test("a block nobody has run and a block that sends nothing are two different answers", () => {
  const never = lastBriefing("cleanup");
  assert.equal(never.ranIn, null);
  assert.equal(never.attempt, null);
  assert.equal(never.absent, "never_ran");
  assert.equal(never.sendsPrompts, true);

  const silent = lastBriefing("trigger");
  assert.equal(silent.sendsPrompts, false);
  assert.equal(silent.attempt?.ok, true);
});

test("an answer about another block, or about none, is refused rather than shown", () => {
  const noNode = readNodeLastBriefing({ definitionId: 7, ranIn: null });
  assert.equal(noNode.ok, false);
  const noDefinition = readNodeLastBriefing({ nodeId: "planning", ranIn: null });
  assert.equal(noDefinition.ok, false);
});

test("a run that says nothing about its state or its version claims neither", () => {
  const read = readNodeLastBriefing({
    definitionId: 7,
    nodeId: "planning",
    ranIn: { runId: "wrun_1" },
    attempt: null,
    absent: null,
  });
  assert.ok(read.ok, read.ok ? "" : read.message);
  assert.equal(read.value.ranIn?.definitionVersion, null);
  assert.equal(read.value.ranIn?.state, null);
  assert.equal(read.value.ranIn?.at, null);
  assert.equal(read.value.sendsPrompts, null);
});

test("a capture record missing one counter is not shown as a whole one", () => {
  // The counter that did not arrive is exactly the one a person came to see.
  // Five out of six would read as "eleven sends, all recorded" and be a lie.
  const page = readAttemptBriefingsPage({
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    cursor: null,
    nextCursor: null,
    total: 0,
    shortened: [],
    unreadable: [],
    items: [],
    state: "available",
    capture: { captured: 9, disabled: 0, failed: 0, conflict: 0, sends: 11 },
  });
  assert.ok(page.ok, page.ok ? "" : page.message);
  assert.equal(page.value.capture, null);
});

test("the run's capture counters arrive on both reads of the same run", () => {
  const page = readAttemptBriefingsPage(
    get(`/api/v1/runs/${STATES_RUN}/briefings?nodeId=research&attempt=1&activationScopeId=root`),
  );
  assert.ok(page.ok, page.ok ? "" : page.message);
  assert.deepEqual(page.value.capture, {
    captured: 3,
    disabled: 1,
    skipped: 2,
    failed: 1,
    conflict: 0,
    sends: 7,
  });
  // The flow editor reads the same run through the block, and must be told the
  // same thing: one fact, not two screens with two ideas of it.
  assert.deepEqual(lastBriefing("research").ranIn?.capture, page.value.capture);
});
