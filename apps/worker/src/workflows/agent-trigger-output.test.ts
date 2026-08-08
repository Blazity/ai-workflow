import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionNode, WorkflowParamValue } from "@shared/contracts";
import {
  resolveWorkflowBlockContract,
  validateBlockOutputAgainstContract,
  type WorkflowBlockRegistryContext,
} from "../workflow-definition/block-registry.js";
import type { AgentWorkflowInput, PrTriggerPayload } from "./agent-input.js";
import {
  assertScheduledRunMayNotPark,
  SCHEDULED_RUN_CANNOT_PARK_REASON,
  selectEntryTriggerNode,
  triggerOutputFor,
  triggerOutputWithTicketContext,
  triggerTypeFor,
} from "./agent.js";

const context: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github"],
  vcsBotIdentities: ["github"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

const basePr: PrTriggerPayload = {
  provider: "github",
  repoPath: "acme/app",
  prNumber: 42,
  prUrl: "https://github.test/acme/app/pull/42",
  headRef: "external/change",
  headSha: "abc123",
  baseRef: "main",
  title: "External change",
  author: "contributor",
  isDraft: false,
};

type PrTriggerEntry = Extract<AgentWorkflowInput, { kind: "pr_trigger" }>;
type PrTriggerType = PrTriggerEntry["triggerType"];

function entryFor(type: PrTriggerType): PrTriggerEntry {
  const pr: PrTriggerPayload = {
    ...basePr,
    ...(type === "trigger_pr_checks_failed"
      ? { failedChecks: [{ name: "test", conclusion: "failure" }] }
      : {}),
    ...(type === "trigger_pr_review"
      ? { review: { state: "changes_requested" as const, author: "reviewer", body: "Fix this" } }
      : {}),
    ...(type === "trigger_pr_merged"
      ? { mergeSha: "merge123", mergedAt: "2026-07-18T00:00:00.000Z" }
      : {}),
  };
  return {
    kind: "pr_trigger",
    triggerType: type,
    subjectKey: "pr:github:acme/app#42",
    // A stale or hand-built envelope must not make scope:any publish a field
    // that its binding contract deliberately omits.
    ticketKey: "AIW-ignored",
    ownerToken: "owner-1",
    definitionId: 1,
    definitionVersion: 1,
    scope: "any",
    pr,
  };
}

describe("scope:any PR trigger output", () => {
  it.each([
    "trigger_pr_created",
    "trigger_pr_checks_failed",
    "trigger_pr_review",
    "trigger_pr_merged",
  ] as const)("omits ticketKey and satisfies the %s runtime contract", (type) => {
    const output = triggerOutputFor(entryFor(type));
    const params: Record<string, WorkflowParamValue> = {
      providers: ["github"],
      scope: "any",
      ...(type === "trigger_pr_review" ? { on: ["changes_requested"] } : {}),
    };
    const contract = resolveWorkflowBlockContract(type, params, context);

    expect(output).not.toHaveProperty("ticketKey");
    expect(validateBlockOutputAgainstContract(contract, output)).toEqual([]);
  });

  it("does not expose ambient ticket context to scope:any PR workflows", () => {
    const output = triggerOutputWithTicketContext(entryFor("trigger_pr_created"), {
      identifier: "AIW-1",
      title: "Secret ticket",
      description: "Private context",
      acceptanceCriteria: "None",
      labels: [],
      comments: [],
    });

    expect(output).not.toHaveProperty("ticket");
    expect(output).not.toHaveProperty("comments");
    expect(output).not.toHaveProperty("priorAnswers");
  });
});

const webhookEntry: AgentWorkflowInput = {
  kind: "webhook_trigger",
  endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
  definitionId: 9,
  definitionVersion: 3,
  nodeId: "webhook-support",
  deliveryId: "delivery-1",
  subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
  ownerToken: "owner-1",
  entry: {
    subject: "Printer is on fire",
    description: "It started smoking after the firmware update.",
    requester: "customer@acme.test",
    priority: "urgent",
    payload: { ticket: { id: 77 } },
  },
};

const webhookParams: Record<string, WorkflowParamValue> = {
  authScheme: "hmac_sha256",
  subjectPath: "ticket.id",
  mapSubject: "subject",
  mapDescription: "description",
  mapRequester: "requester",
  mapPriority: "priority",
};

function webhookNode(id: string): WorkflowDefinitionNode {
  // trigger_webhook is v2-only, and definition-step casts v2 nodes into this
  // same legacy runtime shape before the workflow ever sees them.
  return { id, type: "trigger_webhook", x: 0, y: 0, params: {}, inputs: {} } as unknown as WorkflowDefinitionNode;
}

describe("webhook trigger input", () => {
  it("enters through the trigger_webhook block", () => {
    expect(triggerTypeFor(webhookEntry)).toBe("trigger_webhook");
  });

  it("publishes the mapped delivery fields and satisfies the runtime contract", () => {
    const output = triggerOutputFor(webhookEntry);

    expect(output).toEqual({
      status: "fired",
      subject: "Printer is on fire",
      description: "It started smoking after the firmware update.",
      requester: "customer@acme.test",
      priority: "urgent",
      payload: { ticket: { id: 77 } },
    });
    expect(
      validateBlockOutputAgainstContract(
        resolveWorkflowBlockContract("trigger_webhook", webhookParams, context),
        output,
      ),
    ).toEqual([]);
  });

  it("never leaks a ticketKey or ambient ticket context into a webhook run", () => {
    const output = triggerOutputWithTicketContext(webhookEntry, {
      identifier: "AIW-1",
      title: "Secret ticket",
      description: "Private context",
      acceptanceCriteria: "None",
      labels: [],
      comments: [],
    });

    expect(output).not.toHaveProperty("ticketKey");
    expect(output).not.toHaveProperty("ticket");
    expect(output).not.toHaveProperty("comments");
    expect(output).not.toHaveProperty("priorAnswers");
  });
});

describe("entry trigger node selection", () => {
  it("selects the delivering endpoint's node, not the first webhook of that type", () => {
    const nodes = [webhookNode("webhook-billing"), webhookNode("webhook-support")];

    expect(
      selectEntryTriggerNode(nodes, "trigger_webhook", webhookEntry)?.id,
    ).toBe("webhook-support");
  });

  it("finds nothing when the delivery's node id is absent from the definition", () => {
    const nodes = [webhookNode("webhook-billing")];

    expect(selectEntryTriggerNode(nodes, "trigger_webhook", webhookEntry)).toBeUndefined();
  });

  it("finds nothing when the delivery's node id no longer carries a webhook trigger", () => {
    const nodes: WorkflowDefinitionNode[] = [
      { ...webhookNode("webhook-support"), type: "trigger_ticket_ai" },
    ];

    expect(selectEntryTriggerNode(nodes, "trigger_webhook", webhookEntry)).toBeUndefined();
  });

  it("still selects non-webhook triggers by type", () => {
    const nodes: WorkflowDefinitionNode[] = [
      webhookNode("webhook-support"),
      { ...webhookNode("entry"), type: "trigger_pr_created" },
    ];

    expect(
      selectEntryTriggerNode(nodes, "trigger_pr_created", entryFor("trigger_pr_created"))?.id,
    ).toBe("entry");
  });
});

describe("ticket-backed trigger inputs", () => {
  it("publishes typed ticket, comment, and prior-answer binding values", () => {
    const entry: AgentWorkflowInput = {
      kind: "ticket",
      subjectKey: "AIW-1",
      ticketKey: "AIW-1",
      ownerToken: "owner-1",
    };
    const output = triggerOutputWithTicketContext(entry, {
      identifier: "AIW-1",
      title: "Typed bindings",
      description: "Expose the ticket explicitly",
      acceptanceCriteria: "Agents consume resolved values",
      labels: ["ai"],
      comments: [
        {
          author: "Karol",
          body: "Please keep compatibility",
          createdAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      clarifications: [
        {
          questions: ["Which plan?"],
          answer: "The explicit one",
          answeredBy: "Karol",
        },
      ],
    });

    expect(output).toMatchObject({
      ticket: {
        identifier: "AIW-1",
        comments: [{ body: "Please keep compatibility" }],
        priorAnswers: [{ answer: "The explicit one" }],
      },
      comments: [{ author: "Karol" }],
      priorAnswers: [{ questions: ["Which plan?"] }],
    });
    expect(
      validateBlockOutputAgainstContract(
        resolveWorkflowBlockContract("trigger_ticket_ai", {}, context),
        output,
      ),
    ).toEqual([]);
  });
});

describe("a scheduled run may not park", () => {
  const scheduleEntry: AgentWorkflowInput = {
    kind: "schedule",
    scheduleId: "sch_1",
    definitionId: 9,
    definitionVersion: 3,
    nodeId: "schedule",
    subjectKey: "schedule:sch_1",
    ownerToken: "owner:test",
    scheduledFor: "2026-08-05T14:00:00.000Z",
    taskTitle: "Sweep the backlog",
    taskDescription: "Look for stale tickets.",
  };

  // The deployment gate refuses the two blocks whose purpose is waiting for a
  // person, but parking is a runtime outcome of ordinary blocks too: any agent can
  // decide it needs input. A parked scheduled run notifies nobody (every park
  // notification is gated on a ticket key it does not have), holds its subject for
  // the clarification hook's whole lifetime, which freezes the schedule under skip
  // and queue, and keeps one of three concurrency slots for that period.
  it("fails a scheduled run that reaches a clarification instead of parking it", () => {
    expect(() => assertScheduledRunMayNotPark(scheduleEntry)).toThrow(
      SCHEDULED_RUN_CANNOT_PARK_REASON,
    );
  });

  it("says what to do about it, because a failed run is all the operator sees", () => {
    expect(SCHEDULED_RUN_CANNOT_PARK_REASON).toContain("runs unattended");
    expect(SCHEDULED_RUN_CANNOT_PARK_REASON).toContain("move this work to a ticket trigger");
  });

  it.each(["ticket", "pr_trigger", "webhook_trigger", "plan_approved"] as const)(
    "lets a %s run park as it always has",
    (kind) => {
      expect(() =>
        assertScheduledRunMayNotPark({ kind } as unknown as AgentWorkflowInput),
      ).not.toThrow();
    },
  );
});
