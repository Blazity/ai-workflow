import assert from "node:assert/strict";
import test from "node:test";

import type { Run, RunsResponse } from "@shared/contracts";
import {
  olderOpenRunsSentence,
  parseRunStatusFilter,
  runIdentity,
  runStatusHref,
  tallyListedRuns,
} from "./runs-display";

test("run status filters parse strictly and remain shareable in the URL", () => {
  assert.equal(parseRunStatusFilter("failed"), "failed");
  assert.equal(parseRunStatusFilter("FAILED"), "all");
  assert.equal(parseRunStatusFilter(undefined), "all");
  assert.equal(
    runStatusHref({ status: "failed", window: "24h", q: "broken build" }),
    "/runs?q=broken+build&status=failed",
  );
  assert.equal(
    runStatusHref({ status: "failed", window: "24h", q: "" }),
    "/runs?status=failed",
  );
  assert.equal(
    runStatusHref({ status: "all", window: "7d", q: "" }),
    "/runs?window=7d",
  );
  assert.equal(runStatusHref({ status: "all", window: "24h", q: "" }), "/runs");
});

test("run identity never repeats a fallback ticket and uses the run id without a ticket", () => {
  assert.deepEqual(
    runIdentity({ id: "run_1", ticket: "AIW-7", ticketTitle: "AIW-7" }),
    { primary: "AIW-7", showTicketLink: false, showRunIdMeta: true },
  );
  assert.deepEqual(
    runIdentity({ id: "run_2", ticket: "", ticketTitle: "" }),
    { primary: "run_2", showTicketLink: false, showRunIdMeta: false },
  );
});

function listedRun(id: string, status: Run["status"], startedAtMin: number): Run {
  return {
    id,
    status,
    startedAtMin,
    workflow: "wf_agent",
    workflowName: "Agent",
    ticket: "AWP-1",
    actor: "ai-bot",
    model: null,
    duration: null,
    tokens: null,
    cost: null,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: "Ticket",
    prNumber: null,
    ticketUrl: "",
    prUrl: null,
    prs: null,
  };
}

/** What the Runs page receives: the store's rows for the window, plus the open
 *  runs the live board adds, counted over everything listed. */
function listed(rows: Run[]): Pick<RunsResponse, "rows" | "total" | "counts"> {
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { rows, total: rows.length, counts };
}

// QA at one moment: the Overview tile said 27 runs in the last 24h and the Runs
// page said 30, because three runs parked four and five days ago were listed
// (they still wait for an answer) and counted as if they had started today.
const inWindow = Array.from({ length: 27 }, (_, index) =>
  listedRun(`run_${index}`, index % 3 === 0 ? "failed" : "success", 10 + index * 40),
);
const parkedDaysAgo = [
  listedRun("awp_240", "awaiting", 6998),
  listedRun("awp_241", "awaiting", 7040),
  listedRun("awp_242", "awaiting", 5800),
];

test("runs listed only because they are still open are not counted as runs of the window", () => {
  const tally = tallyListedRuns(listed([...parkedDaysAgo, ...inWindow]), "all", "24h");
  assert.deepEqual(tally, { inWindow: 27, olderAwaiting: 3, olderRunning: 0 });
  assert.equal(olderOpenRunsSentence(tally), "Also listed: 3 older runs still waiting for input.");
});

test("the awaiting filter separates an answer due today from the ones parked for days", () => {
  const today = listedRun("run_today", "awaiting", 30);
  const tally = tallyListedRuns(listed([today, ...parkedDaysAgo, ...inWindow]), "awaiting", "24h");
  assert.deepEqual(tally, { inWindow: 1, olderAwaiting: 3, olderRunning: 0 });
});

test("a window that reaches back far enough holds the parked runs as its own", () => {
  assert.deepEqual(
    tallyListedRuns(listed([...parkedDaysAgo, ...inWindow]), "all", "7d"),
    { inWindow: 30, olderAwaiting: 0, olderRunning: 0 },
  );
  assert.deepEqual(
    tallyListedRuns(listed([...parkedDaysAgo, ...inWindow]), "all", "all"),
    { inWindow: 30, olderAwaiting: 0, olderRunning: 0 },
  );
  assert.equal(olderOpenRunsSentence({ inWindow: 30, olderAwaiting: 0, olderRunning: 0 }), null);
});

test("the sentence names each kind of older open run once, in the singular where it is one", () => {
  assert.equal(
    olderOpenRunsSentence({ inWindow: 0, olderAwaiting: 1, olderRunning: 1 }),
    "Also listed: 1 older run still waiting for input and 1 still running.",
  );
  assert.equal(
    olderOpenRunsSentence({ inWindow: 0, olderAwaiting: 0, olderRunning: 2 }),
    "Also listed: 2 older runs still running.",
  );
});
