import { describe, it, expect } from "vitest";
import type { WorkflowDefinitionV2Node } from "@shared/contracts";
import type { V2BindingResolutionContext } from "@shared/workflow-graph";
import {
  buildOpenPrSuccessOutput,
  resolveSlackMessageInput,
  resolveV2PromptConfiguration,
} from "../helpers/prompt-output.js";
import { triggerOutputWithTicketContext } from "../helpers/trigger-input.js";
import { formatTicketEvent } from "../../adapters/messaging/format.js";
import type { AgentWorkflowInput } from "../agent-input.js";
import type { WorkspacePublicationResult } from "../steps/workspace-publication.js";

// What a `send_slack_message` block posts into the ticket's Slack thread. A v2
// run handles the authored message in this order:
//   1. resolveV2PromptConfiguration (engine/helpers/prompt-output.ts), the one
//      call the executeV2Block closure in engine/agent-workflow.ts makes,
//      replaces each {{data:...}} token once with the value the run holds and
//      fails the block on a placeholder the author left, such as a legacy
//      {{ticket_key}}. A token naming a value the run does not have throws, and
//      the scheduler turns that throw into a failed block.
//   2. resolveSlackMessageInput (same file) picks a bound `message` input over
//      the configured text and trims it.
//   3. The messaging adapter formats the event with formatTicketEvent
//      (adapters/messaging/format.ts): a thread note for sendOn "always", or
//      the text under the PR-ready card for "pr_ready".
// Step 2 runs in executeBlock's "send_slack_message" case, which is not
// exported, so this file calls the helper that case calls.

const JIRA = "https://acme.atlassian.net";

const entry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "jira:AWT-42",
  ticketKey: "AWT-42",
  ownerToken: "owner-token",
};

// The run's real trigger output and Open PR output, built by the production
// builders, so a token authored against their field names resolves here only
// if it resolves in a run.
const bindingContext: V2BindingResolutionContext = {
  entryOutput: triggerOutputWithTicketContext(entry, {
    identifier: "AWT-42",
    title: "Add rate limiting",
    description: "Throttle the public API.",
    acceptanceCriteria: "429 after 100 req/min.",
    labels: ["backend", "api"],
    comments: [],
  }),
  getStepOutput: (nodeId) =>
    nodeId === "open_pr"
      ? buildOpenPrSuccessOutput([
          {
            provider: "github",
            repoPath: "acme/api",
            id: 128,
            url: "https://github.com/acme/api/pull/128",
            branch: "ai/awt-42",
            isNew: true,
          },
        ] as Extract<WorkspacePublicationResult, { status: "published" }>["prs"])
      : undefined,
};

type Resolution = { message: string } | { failed: string };

/** Steps 1 and 2 above: the text the block hands to Slack, or why it fails. */
function resolveMessage(
  message: string,
  context: V2BindingResolutionContext = bindingContext,
): Resolution {
  const node: WorkflowDefinitionV2Node = {
    id: "slack",
    type: "send_slack_message",
    x: 0,
    y: 0,
    configuration: { message, sendOn: "pr_ready" },
    inputs: {},
    additionalInputs: [],
  };
  let resolution: ReturnType<typeof resolveV2PromptConfiguration>;
  try {
    resolution = resolveV2PromptConfiguration(node, context);
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
  if (!resolution.ok) return { failed: resolution.issue };
  return { message: resolveSlackMessageInput(resolution.configuration, {}) };
}

function prReadyText(extraText: string): string {
  return formatTicketEvent(
    {
      kind: "pr_ready",
      prs: [
        {
          provider: "github",
          repoPath: "acme/api",
          id: 128,
          url: "https://github.com/acme/api/pull/128",
        },
      ],
      usageReport: "",
      ...(extraText ? { extraText } : {}),
    },
    "AWT-42",
    JIRA,
  );
}

describe("send_slack_message: what the Slack thread shows", () => {
  it("posts the message with its data tokens resolved under the PR-ready card", () => {
    const resolution = resolveMessage(
      "  :rocket: {{data:steps.entry.output.ticketKey}} ({{data:steps.entry.output.ticket.title}}) is PR #{{data:steps.open_pr.output.prNumber}} at {{data:steps.open_pr.output.prUrl}}  ",
    );
    expect(resolution).toEqual({
      message:
        ":rocket: AWT-42 (Add rate limiting) is PR #128 at https://github.com/acme/api/pull/128",
    });
    if (!("message" in resolution)) return;

    expect(prReadyText(resolution.message)).toBe(
      ":white_check_mark: Task <https://acme.atlassian.net/browse/AWT-42|AWT-42> PR ready for review: <https://github.com/acme/api/pull/128|#128>\n" +
        ":rocket: AWT-42 (Add rate limiting) is PR #128 at https://github.com/acme/api/pull/128",
    );
  });

  it("posts only the resolved message as a thread note when sendOn is always", () => {
    const resolution = resolveMessage(
      "{{data:steps.entry.output.ticketKey}}: {{data:steps.entry.output.ticket.title}} needs a look",
    );
    expect(resolution).toEqual({
      message: "AWT-42: Add rate limiting needs a look",
    });
    if (!("message" in resolution)) return;

    expect(
      formatTicketEvent({ kind: "note", text: resolution.message }, "AWT-42", JIRA),
    ).toBe("AWT-42: Add rate limiting needs a look");
  });

  it("fails the block instead of posting a legacy {{ticket_key}} as literal braces", () => {
    expect(resolveMessage("Heads up: {{ticket_key}} is ready")).toEqual({
      failed: "send_slack_message message contains an unresolved placeholder.",
    });
  });

  it("fails the block on braces the author typed, even when meant literally", () => {
    // At runtime an intended literal cannot be told apart from a mistyped
    // token, and a typo posted to a customer's channel is worse than a refusal
    // the author can fix.
    expect(resolveMessage("Helm: use {{ .Values.image }}")).toEqual({
      failed: "send_slack_message message contains an unresolved placeholder.",
    });
  });

  it("fails the block instead of posting when a data token names a value the run lacks", () => {
    expect(
      resolveMessage("Title: {{data:steps.open_pr.output.prTitle}}"),
    ).toEqual({
      failed: 'binding "steps.open_pr.output.prTitle" could not be resolved',
    });
  });

  it("adds nothing under the PR-ready card for a blank message", () => {
    const resolution = resolveMessage("   \n  ");
    expect(resolution).toEqual({ message: "" });
    if (!("message" in resolution)) return;

    expect(prReadyText(resolution.message)).toBe(
      ":white_check_mark: Task <https://acme.atlassian.net/browse/AWT-42|AWT-42> PR ready for review: <https://github.com/acme/api/pull/128|#128>",
    );
  });

  it("posts a ticket title that itself contains braces, as people wrote it", () => {
    // The authored message holds only a data token. The braces come from the
    // ticket, so they are content to show, not a placeholder the author left.
    const context: V2BindingResolutionContext = {
      ...bindingContext,
      entryOutput: triggerOutputWithTicketContext(entry, {
        identifier: "AWT-42",
        title: "Escape {{ name }} in the welcome email",
        description: "",
        acceptanceCriteria: "",
        labels: [],
        comments: [],
      }),
    };
    expect(
      resolveMessage("Shipped: {{data:steps.entry.output.ticket.title}}", context),
    ).toEqual({
      message: "Shipped: Escape {{ name }} in the welcome email",
    });
  });

  it("posts token-shaped ticket text literally, without resolving or failing on it", () => {
    // Data is inserted once and never read for tokens again, so a ticket cannot
    // pull other run data into the message or break it with a bad reference.
    const context: V2BindingResolutionContext = {
      ...bindingContext,
      entryOutput: triggerOutputWithTicketContext(entry, {
        identifier: "AWT-42",
        title: "Show {{data:steps.open_pr.output.prUrl}} and {{data:steps.nope.output.x}}",
        description: "",
        acceptanceCriteria: "",
        labels: [],
        comments: [],
      }),
    };
    expect(
      resolveMessage("Shipped: {{data:steps.entry.output.ticket.title}}", context),
    ).toEqual({
      message:
        "Shipped: Show {{data:steps.open_pr.output.prUrl}} and {{data:steps.nope.output.x}}",
    });
  });
});
