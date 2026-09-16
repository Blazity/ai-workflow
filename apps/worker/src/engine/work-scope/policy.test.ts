import { describe, expect, it } from "vitest";
import type {
  TriggerRepositoryPolicy,
  WorkflowBlockType,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { resolveRunTriggerRepositoryPolicy, runWorkScopeSubjectKey } from "./policy.js";

/**
 * Which rung of A35's ladder a run stands on, and the policy that rung gives.
 *
 * The expected policies are written as literals rather than composed from the
 * contract, because the point of each test is what the RUN ends up bounded by,
 * not that this file and the contract agree on a helper call.
 */
function triggerNode(
  id: string,
  type: WorkflowBlockType,
  repositoryPolicy?: TriggerRepositoryPolicy,
): WorkflowDefinitionNode {
  return {
    id,
    type,
    x: 0,
    y: 0,
    params: repositoryPolicy === undefined ? {} : { repositoryPolicy },
    inputs: {},
  } as unknown as WorkflowDefinitionNode;
}

const listedApi: TriggerRepositoryPolicy = {
  candidates: { kind: "listed", repositoryKeys: ["github:acme/api"] },
  expansion: "ask_once",
};
const listedWeb: TriggerRepositoryPolicy = {
  candidates: { kind: "listed", repositoryKeys: ["github:acme/web"] },
  expansion: "never",
};

describe("resolveRunTriggerRepositoryPolicy", () => {
  it("takes the node the delivery entered through when the graph holds it", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "webhook_trigger",
        triggerType: "trigger_webhook",
        nodeId: "hook-b",
        plan: {
          nodes: [
            triggerNode("hook-a", "trigger_webhook", listedWeb),
            triggerNode("hook-b", "trigger_webhook", listedApi),
          ],
        },
        webhookHasSubjectPath: true,
      }),
    ).toEqual({
      policy: {
        candidates: { kind: "listed", repositoryKeys: ["github:acme/api"] },
        expansion: "ask_once",
      },
      source: "node",
    });
  });

  it("falls to the next rung when the node id names a node the graph no longer holds", () => {
    // A delivery can sit in the pending queue across a publish that removed its
    // node. The graph can still answer, so the ladder continues rather than
    // dropping straight to the kind default.
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "webhook_trigger",
        triggerType: "trigger_webhook",
        nodeId: "hook-gone",
        plan: { nodes: [triggerNode("hook-a", "trigger_webhook", listedWeb)] },
        webhookHasSubjectPath: true,
      }),
    ).toEqual({
      policy: {
        candidates: { kind: "listed", repositoryKeys: ["github:acme/web"] },
        expansion: "never",
      },
      source: "only_node_of_kind",
    });
  });

  it("takes the only trigger node of the run's type, which a ticket run never names", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: {
          nodes: [
            triggerNode("ticket-1", "trigger_ticket_ai", listedApi),
            triggerNode("hook-1", "trigger_webhook", listedWeb),
          ],
        },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: {
        candidates: { kind: "listed", repositoryKeys: ["github:acme/api"] },
        expansion: "ask_once",
      },
      source: "only_node_of_kind",
    });
  });

  it("takes the shared policy when every trigger of the kind carries the same one", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: {
          nodes: [
            triggerNode("ticket-1", "trigger_ticket_ai", listedApi),
            triggerNode("ticket-2", "trigger_ticket_ai", listedApi),
          ],
        },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: {
        candidates: { kind: "listed", repositoryKeys: ["github:acme/api"] },
        expansion: "ask_once",
      },
      source: "shared_by_kind",
    });
  });

  it("falls to the kind default when two triggers of the kind disagree", () => {
    // A35: this is today's behaviour rather than a new narrowing. Stage 6
    // records the matched node on dispatch and closes the gap.
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: {
          nodes: [
            triggerNode("ticket-1", "trigger_ticket_ai", listedApi),
            triggerNode("ticket-2", "trigger_ticket_ai", listedWeb),
          ],
        },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
      source: "kind_default",
    });
  });

  it("falls to the kind default when no trigger of the kind configures a policy", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: {
          nodes: [
            triggerNode("ticket-1", "trigger_ticket_ai"),
            triggerNode("ticket-2", "trigger_ticket_ai"),
          ],
        },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
      source: "kind_default",
    });
  });

  it("starts at the kind default where there is no graph to read", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: null,
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
      source: "kind_default",
    });
  });

  it("gives a pull request run the repositories of its event", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "pr_trigger",
        triggerType: "trigger_pr_review",
        plan: { nodes: [triggerNode("pr-1", "trigger_pr_review")] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: {
        candidates: { kind: "event_repository_and_related" },
        expansion: "attach",
      },
      source: "only_node_of_kind",
    });
  });

  it("never asks a schedule, and never asks a delivery that resolved no subject", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "schedule",
        triggerType: "trigger_schedule",
        nodeId: "cron-1",
        plan: { nodes: [triggerNode("cron-1", "trigger_schedule")] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "never" },
      source: "node",
    });

    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "webhook_trigger",
        triggerType: "trigger_webhook",
        nodeId: "hook-1",
        plan: { nodes: [triggerNode("hook-1", "trigger_webhook")] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "never" },
      source: "node",
    });
  });

  it("turns a definition pin with no configured policy into the listed candidate set", () => {
    // The run depends on this, so it is asserted here as well as in the
    // contract: a pin naming repositories IS the candidate set, and the kind
    // default decides only the expansion.
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: { nodes: [triggerNode("ticket-1", "trigger_ticket_ai")] },
        definitionPin: {
          repositories: [
            { provider: "github", repoPath: "Acme/Api" },
            { provider: "gitlab", repoPath: "group/tool" },
          ],
        },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: {
        candidates: {
          kind: "listed",
          repositoryKeys: ["github:acme/api", "gitlab:group/tool"],
        },
        expansion: "attach",
      },
      source: "only_node_of_kind",
    });
  });

  it("lets a configured policy outrank the definition pin", () => {
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: { nodes: [triggerNode("ticket-1", "trigger_ticket_ai", listedWeb)] },
        definitionPin: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: {
        candidates: { kind: "listed", repositoryKeys: ["github:acme/web"] },
        expansion: "never",
      },
      source: "only_node_of_kind",
    });
  });

  it("gives an approved plan no policy at all", () => {
    // An approved plan works from the repository snapshot a person approved and
    // writes nothing back, so no trigger policy reaches it.
    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "plan_approved",
        triggerType: "trigger_plan_approved",
        plan: { nodes: [triggerNode("approved-1", "trigger_plan_approved")] },
        definitionPin: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ policy: null, source: "none" });
  });

  it("ignores a stored policy the contract would not accept", () => {
    // The deployment validation already refused it, so reaching this means the
    // row was written by something else. Reading it as absent puts the run on
    // the kind default, never on half a policy.
    const node = triggerNode("ticket-1", "trigger_ticket_ai");
    (node.params as Record<string, unknown>).repositoryPolicy = { expansion: "sometimes" };

    expect(
      resolveRunTriggerRepositoryPolicy({
        entryKind: "ticket",
        triggerType: "trigger_ticket_ai",
        plan: { nodes: [node] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
      source: "only_node_of_kind",
    });
  });
});

/**
 * Which subject a run freezes a record for. The entries are written as literals
 * because the rule is about what a real entry carries: a webhook delivery is
 * told apart from a recurring channel by its own key, nothing else.
 */
describe("runWorkScopeSubjectKey", () => {
  it("gives a ticket run its subject key", () => {
    expect(
      runWorkScopeSubjectKey({
        kind: "ticket",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
      }),
    ).toBe("ticket:jira:AWT-1");
  });

  it("gives a pull request run its subject key", () => {
    expect(
      runWorkScopeSubjectKey({
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "pr:github:acme/api#12",
        ownerToken: "owner:test",
        definitionId: 4,
        definitionVersion: 7,
        scope: "workflow_owned",
        pr: { number: 12 } as never,
      }),
    ).toBe("pr:github:acme/api#12");
  });

  it("gives a schedule occurrence none", () => {
    expect(
      runWorkScopeSubjectKey({
        kind: "schedule",
        scheduleId: "schedule-1",
        definitionId: 4,
        definitionVersion: 7,
        nodeId: "cron-1",
        subjectKey: "schedule:schedule-1:1757923200000",
        ownerToken: "owner:test",
        scheduledFor: "2026-09-15T08:00:00.000Z",
        taskTitle: "Nightly sweep",
        taskDescription: "Sweep.",
      }),
    ).toBeNull();
  });

  it("gives a delivery whose subject key IS the delivery-id fallback none", () => {
    // No subject path on the endpoint, so every delivery is its own subject and
    // an answer would be written once and never read again.
    expect(
      runWorkScopeSubjectKey({
        kind: "webhook_trigger",
        endpointId: "endpoint-1",
        definitionId: 4,
        definitionVersion: 7,
        nodeId: "hook-1",
        deliveryId: "delivery-9",
        subjectKey: "webhook:endpoint-1:delivery-9",
        ownerToken: "owner:test",
        entry: {} as never,
      }),
    ).toBeNull();
  });

  it("gives a delivery that resolved a subject of its own its key", () => {
    expect(
      runWorkScopeSubjectKey({
        kind: "webhook_trigger",
        endpointId: "endpoint-1",
        definitionId: 4,
        definitionVersion: 7,
        nodeId: "hook-1",
        deliveryId: "delivery-9",
        subjectKey: "webhook:endpoint-1:ZD-4417",
        ownerToken: "owner:test",
        entry: {} as never,
      }),
    ).toBe("webhook:endpoint-1:ZD-4417");
  });

  it("gives an approved plan none, whatever its subject key says", () => {
    // An approved plan reads the repository snapshot a person approved and
    // writes nothing back, or a later scope change would reach work nobody
    // approved.
    expect(
      runWorkScopeSubjectKey({
        kind: "plan_approved",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 4,
        approvedPlan: { markdown: "The plan." },
        approval: {
          approvalRequestId: "approval-1",
          approver: "Ada",
          approvedAt: "2026-09-15T10:00:00.000Z",
        },
      }),
    ).toBeNull();
  });
});
