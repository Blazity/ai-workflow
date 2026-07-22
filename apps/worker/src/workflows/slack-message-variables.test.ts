import { describe, it, expect } from "vitest";
import { buildPromptVariables, substituteNodePromptParams } from "./prompt-vars.js";
import { resolveSlackMessageInput } from "./agent.js";
import { formatTicketEvent } from "../adapters/messaging/format.js";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { AgentWorkflowInput } from "./agent-input.js";
import type { WorkspacePublicationResult } from "./workspace-publication.js";

// End-to-end proof of what a `send_slack_message` block actually sends once its
// {{variables}} are substituted. It stitches the real runtime steps in order:
//   1. buildPromptVariables(ctx)           -> the {{name}} -> value map
//   2. substituteNodePromptParams(node)    -> node.params.message with vars resolved
//                                             (this is what executeBlock does at agent.ts:1864)
//   3. resolveSlackMessageInput(params)    -> the string the handler passes as extraText
//   4. formatTicketEvent(pr_ready)         -> the final Slack-mrkdwn text posted in-thread
//
// Note: send_slack_message piggybacks on the "PR ready" notification and only
// fires when a PR has been published; the message is appended after that card.

type Source = Parameters<typeof buildPromptVariables>[0];

const ticket = {
  id: "10042",
  identifier: "AWT-42",
  title: "Add rate limiting",
  description: "Throttle the public API.",
  acceptanceCriteria: "429 after 100 req/min.",
  comments: [],
  labels: ["backend", "api"],
  trackerStatus: "AI",
  attachments: [],
};

const ticketEntry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "jira:AWT-42",
  ticketKey: "AWT-42",
  ownerToken: "owner-token",
};

const publishedPr = {
  status: "published",
  prs: [
    {
      provider: "github",
      repoPath: "acme/api",
      id: 128,
      url: "https://github.com/acme/api/pull/128",
      branch: "ai/awt-42",
      isNew: true,
    },
  ],
} as unknown as WorkspacePublicationResult;

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    runId: "run_awt42",
    ticket,
    branchName: "ai/awt-42",
    entry: ticketEntry,
    researchPlanMarkdown: "",
    publication: publishedPr,
    selectedRepositories: [],
    repositoryContexts: [],
    ...overrides,
  };
}

const slackNode = (message: string): WorkflowDefinitionNode => ({
  id: "slack1",
  type: "send_slack_message",
  x: 0,
  y: 0,
  params: { message },
  inputs: {},
});

/** Run steps 1-3: what the substituted `message` param becomes at send time. */
function resolveSentMessage(rawMessage: string, source: Source = makeSource()): string {
  const substituted = substituteNodePromptParams(slackNode(rawMessage), buildPromptVariables(source));
  return resolveSlackMessageInput(substituted.params, {});
}

describe("send_slack_message: what actually goes to Slack", () => {
  it("substitutes every {{variable}} in the message the user typed", () => {
    const sent = resolveSentMessage(
      ":rocket: {{ticket_key}}: {{ticket_title}} shipped to {{pr_url}} on branch {{branch_name}}",
    );
    expect(sent).toBe(
      ":rocket: AWT-42: Add rate limiting shipped to https://github.com/acme/api/pull/128 on branch ai/awt-42",
    );
  });

  it("appends the resolved message under the system 'PR ready' line in the final Slack text", () => {
    const sent = resolveSentMessage("Heads up team: {{ticket_key}} ({{ticket_title}}) is ready");
    const slackText = formatTicketEvent(
      {
        kind: "pr_ready",
        pr: { url: "https://github.com/acme/api/pull/128", number: 128 },
        usageReport: "",
        extraText: sent,
      },
      "AWT-42",
      "https://acme.atlassian.net",
    );
    // The user's substituted line is present verbatim...
    expect(slackText).toContain("Heads up team: AWT-42 (Add rate limiting) is ready");
    // ...appended after our own system-built PR-ready copy + link.
    expect(slackText).toContain("PR ready for review");
    expect(slackText).toContain("<https://github.com/acme/api/pull/128|#128>");
    expect(slackText.indexOf("PR ready for review")).toBeLessThan(
      slackText.indexOf("Heads up team"),
    );
  });

  it("resolves a variable with no value to empty string, never the text 'undefined'", () => {
    // pr_title has no source on a ticket-triggered run (only the opened PR backs
    // pr_number/pr_url), so it collapses to "" rather than leaking "undefined".
    const sent = resolveSentMessage("Title: [{{pr_title}}] done", makeSource({ entry: ticketEntry }));
    expect(sent).toBe("Title: [] done");
    expect(sent).not.toContain("undefined");
  });

  it("leaves an unknown/misspelled token verbatim so the typo stays visible", () => {
    const sent = resolveSentMessage("Ping {{ticket_ky}} now");
    expect(sent).toBe("Ping {{ticket_ky}} now");
  });
});

describe('send_slack_message "always" mode: standalone note', () => {
  const slackNodeWithMode = (
    message: string,
    sendOn: string,
  ): WorkflowDefinitionNode => ({
    id: "slack1",
    type: "send_slack_message",
    x: 0,
    y: 0,
    params: { message, sendOn },
    inputs: {},
  });

  it("substitutes the message and leaves the sendOn config param untouched", () => {
    const node = slackNodeWithMode("{{ticket_key}}: {{ticket_title}}", "always");
    const substituted = substituteNodePromptParams(node, buildPromptVariables(makeSource()));
    // sendOn is config, not a {{variable}} param — it must round-trip unchanged.
    expect(substituted.params.sendOn).toBe("always");
    expect(resolveSlackMessageInput(substituted.params, {})).toBe("AWT-42: Add rate limiting");
  });

  it("formats the substituted message as a bare note (no PR-ready card, no head)", () => {
    const sent = resolveSentMessage("Team: {{ticket_key}} ({{ticket_title}}) is ready");
    const slackText = formatTicketEvent({ kind: "note", text: sent }, "AWT-42", "https://acme.atlassian.net");
    // A note is exactly the user's substituted message — nothing prepended.
    expect(slackText).toBe("Team: AWT-42 (Add rate limiting) is ready");
    expect(slackText).not.toContain("PR ready for review");
  });
});
