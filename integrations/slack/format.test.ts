/**
 * What a person reads in the channel.
 *
 * These assertions moved here with the renderer. Core keeps the half it still
 * owns: `apps/worker/src/engine/execution-error-invariant.test.ts` holds that
 * the run header, the run list and the ticket comment carry one failure
 * sentence, and this file holds that the chat notification carries the same
 * one, whole, including a reason that still contains a credentialed URL.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MessagingTicket } from "@integrations/sdk";
import { formatTicketEvent, formatTicketStatus, neutralizeSlackBroadcasts } from "./format";

const TICKET: MessagingTicket = {
  key: "AWT-42",
  url: "https://acme.atlassian.net/browse/AWT-42",
};

const PRS = [
  {
    provider: "github" as const,
    repoPath: "acme/api",
    id: 128,
    url: "https://github.com/acme/api/pull/128",
  },
];

test("the pull request card links every pull request and carries the author's own text", () => {
  assert.equal(
    formatTicketEvent(
      {
        kind: "pr_ready",
        prs: PRS,
        usageReport: "",
        extraText: ":rocket: AWT-42 (Add rate limiting) is PR #128",
      },
      TICKET,
    ),
    ":white_check_mark: Task <https://acme.atlassian.net/browse/AWT-42|AWT-42> " +
      "PR ready for review: <https://github.com/acme/api/pull/128|#128>\n" +
      ":rocket: AWT-42 (Add rate limiting) is PR #128",
  );
  assert.equal(
    formatTicketEvent({ kind: "pr_ready", prs: PRS, usageReport: "" }, TICKET),
    ":white_check_mark: Task <https://acme.atlassian.net/browse/AWT-42|AWT-42> " +
      "PR ready for review: <https://github.com/acme/api/pull/128|#128>",
  );
});

test("a merge request links with the reference core stamped, not GitHub's form", () => {
  // On GitLab `#12` names issue 12. Core stamps `!12` from the provider's
  // manifest, and the line a GitLab team reads has to say what the run view says.
  const mergeRequest = {
    provider: "gitlab",
    repoPath: "acme/app",
    id: 12,
    url: "https://gitlab.example/acme/app/-/merge_requests/12",
    reference: "!12",
  };
  assert.equal(
    formatTicketStatus({ kind: "pr_ready", prs: [mergeRequest], usageReport: "" }, TICKET),
    ":white_check_mark: <https://acme.atlassian.net/browse/AWT-42|AWT-42> STATUS: PR ready " +
      "(<https://gitlab.example/acme/app/-/merge_requests/12|!12>)",
  );
});

test("a note is the person's own message and nothing else", () => {
  assert.equal(
    formatTicketEvent({ kind: "note", text: "AWT-42: Add rate limiting needs a look" }, TICKET),
    "AWT-42: Add rate limiting needs a look",
  );
});

test("a failure carries the whole reason, credentialed URL and all", () => {
  // Core redacts the credential before the reason ever leaves it; what this
  // holds is that the renderer does not shorten, wrap or escape what it was
  // given, so the four surfaces read the same sentence.
  const reason =
    "The CLI exited with code 1. push rejected for https://[redacted]@gitlab.com/acme/app.git " +
    "(AIW-DIAG-run-1-push-1)";
  const text = formatTicketEvent({ kind: "failed", phase: "push", reason }, TICKET);
  assert.ok(text.includes(reason), text);
  assert.equal(
    text,
    `:warning: Task <https://acme.atlassian.net/browse/AWT-42|AWT-42> failed: push, ${reason}`,
  );
});

test("a subject with no page on the tracker is named, not linked to a 404", () => {
  // A pull request run and a schedule occurrence have a synthesized key, and
  // core answers `url: null` for them rather than inventing /browse/<that>.
  assert.equal(
    formatTicketStatus({ kind: "started" }, { key: "pr:acme/api#128", url: null }),
    ":hourglass_flowing_sand: pr:acme/api#128 STATUS: in progress",
  );
});

test("a broadcast token somebody put in a ticket cannot ping the channel", () => {
  const text = formatTicketEvent({ kind: "note", text: "ship it <!channel>" }, TICKET);
  assert.equal(text, "ship it <​!channel>");
  // Our own links and mentions are untouched.
  assert.equal(
    neutralizeSlackBroadcasts("see <https://example.test|the run> and <@U1>"),
    "see <https://example.test|the run> and <@U1>",
  );
});
