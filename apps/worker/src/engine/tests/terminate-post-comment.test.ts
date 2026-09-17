import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV2Node } from "@shared/contracts";
import type { BlockExecutionResult, V2BindingResolutionContext } from "@shared/workflow-graph";
import {
  resolveV2PromptConfiguration,
  v2TerminalBlockResult,
} from "../helpers/prompt-output.js";
import { triggerOutputWithTicketContext } from "../helpers/trigger-input.js";

// What a Terminate block's postComment says on the ticket. The executeV2Block
// closure in engine/agent-workflow.ts resolves the configuration with
// resolveV2PromptConfiguration, which also fails the block on a placeholder the
// author left, builds the result with v2TerminalBlockResult, and posts the
// resolved postComment verbatim for a "done" or "skipped" path on a ticket run.
// That function finds postComment only through VARIABLE_PARAM_KEYS.terminate
// (WORKFLOW_PROMPT_PARAM_KEYS in packages/contracts/workflow-graph.ts). When to
// post is decided inside the closure, which is not exported.

const bindingContext: V2BindingResolutionContext = {
  entryOutput: triggerOutputWithTicketContext(
    {
      kind: "ticket",
      subjectKey: "jira:AWT-42",
      ticketKey: "AWT-42",
      ownerToken: "owner-token",
    },
    {
      identifier: "AWT-42",
      title: "Add rate limiting",
      description: "Throttle the public API.",
      acceptanceCriteria: "",
      labels: [],
      comments: [],
    },
  ),
  getStepOutput: () => undefined,
};

type Termination =
  | { comment: string | undefined; result: BlockExecutionResult }
  | { failed: string };

function terminate(
  postComment: string,
  terminalStatus: "done" | "skipped",
  context: V2BindingResolutionContext = bindingContext,
): Termination {
  const node: WorkflowDefinitionV2Node = {
    id: "stop",
    type: "terminate",
    x: 0,
    y: 0,
    configuration: { terminalStatus, postComment },
    inputs: {},
    additionalInputs: [],
  };
  const resolution = resolveV2PromptConfiguration(node, context);
  if (!resolution.ok) return { failed: resolution.issue };
  const { configuration } = resolution;
  const resolved =
    typeof configuration.postComment === "string"
      ? configuration.postComment
      : undefined;
  return {
    comment: resolved,
    result: v2TerminalBlockResult({
      terminalStatus,
      ...(resolved === undefined ? {} : { postComment: resolved }),
    }),
  };
}

describe("terminate postComment: what the ticket comment says", () => {
  it("posts the comment with its data tokens resolved when the path ends skipped", () => {
    expect(
      terminate(
        "Skipped {{data:steps.entry.output.ticketKey}} ({{data:steps.entry.output.ticket.title}}): nothing to change.",
        "skipped",
      ),
    ).toEqual({
      comment: "Skipped AWT-42 (Add rate limiting): nothing to change.",
      result: { kind: "next", output: { status: "skipped" } },
    });
  });

  it("fails the block instead of commenting a legacy {{ticket_key}} as literal braces", () => {
    expect(terminate("Done with {{ticket_key}}.", "done")).toEqual({
      failed: "terminate postComment contains an unresolved placeholder.",
    });
  });

  it("posts a ticket title that itself contains braces, as people wrote it", () => {
    const context: V2BindingResolutionContext = {
      ...bindingContext,
      entryOutput: triggerOutputWithTicketContext(
        {
          kind: "ticket",
          subjectKey: "jira:AWT-42",
          ticketKey: "AWT-42",
          ownerToken: "owner-token",
        },
        {
          identifier: "AWT-42",
          title: "Pass ${{ secrets.NPM_TOKEN }} to the publish step",
          description: "",
          acceptanceCriteria: "",
          labels: [],
          comments: [],
        },
      ),
    };
    expect(
      terminate(
        "Done: {{data:steps.entry.output.ticket.title}}",
        "done",
        context,
      ),
    ).toEqual({
      comment: "Done: Pass ${{ secrets.NPM_TOKEN }} to the publish step",
      result: { kind: "next", output: { status: "done" } },
    });
  });
});
