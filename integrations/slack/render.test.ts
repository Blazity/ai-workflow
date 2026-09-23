/**
 * The lines a person reads in the channel after running a command.
 *
 * Core decides what happened and answers in values; every sentence here is
 * ours. These assertions came from `apps/worker/src/services/slack/format.ts`
 * with the rendering, plus the outcomes that had no words of their own before,
 * because the wrong sentence over a cancellation is the one somebody acts on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RunControlAnswer } from "@integrations/sdk";
import { renderOutcome } from "./render";

const TICKET_URL = "https://acme.atlassian.net/browse/AWT-42";

function rendered(answer: RunControlAnswer): string {
  return renderOutcome({ kind: "answered", answer });
}

test("an empty list says so rather than showing an empty bullet", () => {
  assert.equal(rendered({ kind: "runs", runs: [] }), "No active workflows.");
});

test("each run is one line, linked to its ticket and naming its run", () => {
  assert.equal(
    rendered({
      kind: "runs",
      runs: [
        { ticketKey: "AWT-42", runId: "run_a", ticketUrl: TICKET_URL },
        { ticketKey: "AWT-43", runId: "run_b", ticketUrl: "" },
      ],
    }),
    `• <${TICKET_URL}|AWT-42> - runId: \`run_a\`\n• AWT-43 - runId: \`run_b\``,
  );
});

test("a ticket with no run says not tracked, and one with a run says what it has", () => {
  assert.equal(
    rendered({
      kind: "run_status",
      ticketKey: "AWT-42",
      ticketUrl: TICKET_URL,
      runId: null,
      hasSandbox: false,
    }),
    `<${TICKET_URL}|AWT-42>: not tracked.`,
  );
  assert.equal(
    rendered({
      kind: "run_status",
      ticketKey: "AWT-42",
      ticketUrl: TICKET_URL,
      runId: "run_a",
      hasSandbox: true,
    }),
    `<${TICKET_URL}|AWT-42>: runId \`run_a\`, sandbox: yes`,
  );
});

test("every cancellation outcome reads as what a person should do next", () => {
  // The two that matter are the ones that did not finish: saying "cancelled"
  // over a run that is still going is how somebody walks away from a live run.
  const outcomes = {
    not_tracked: /No active run/,
    cancelled: /Cancelled/,
    cancelled_mid_dispatch: /mid-dispatch/,
    claim_not_cleared: /could not be cleared safely.*retry/s,
    unconfirmed: /could not confirm.*safe retry/s,
  } as const;
  for (const [outcome, expected] of Object.entries(outcomes)) {
    const text = rendered({
      kind: "cancelled",
      ticketKey: "AWT-42",
      ticketUrl: TICKET_URL,
      runId: outcome === "cancelled" ? "run_a" : null,
      outcome: outcome as never,
    });
    assert.match(text, expected, outcome);
    assert.ok(text.includes("AWT-42"), outcome);
  }
});

test("a reset says what it cleared, what it could not, and what it refused to touch", () => {
  const text = rendered({
    kind: "reset",
    ticketKey: "AWT-42",
    ticketUrl: TICKET_URL,
    outcome: {
      cleared: ["failure_mark"],
      failures: [{ target: "conversation", reason: "the database refused" }],
      blockedByActiveRun: true,
    },
  });
  assert.match(text, /failed mark/);
  assert.match(text, /thread anchor.*the database refused/);
  // The run is still going: a reset that looked complete would invite somebody
  // to start a second run on the same ticket.
  assert.match(text, /active run/i);
});

test("a command that failed says so instead of pretending it answered", () => {
  assert.equal(
    renderOutcome({ kind: "failed", reference: "AIW-DIAG-run-control-1" }),
    ":warning: That command could not be completed because of an error on the AI Workflow side. " +
      "Try it again in a minute; if it keeps failing, give an admin the reference `AIW-DIAG-run-control-1`, " +
      "which names the error in the worker's log.",
  );
});

test("a failure names the command that was asked, with no backtick left to break its span", () => {
  const text = renderOutcome(
    { kind: "failed", reference: "AIW-DIAG-run-control-2" },
    "/ai-workflow status `AWT-1`",
  );
  assert.match(text, /^:warning: `\/ai-workflow status 'AWT-1'` could not be completed/u);
});
