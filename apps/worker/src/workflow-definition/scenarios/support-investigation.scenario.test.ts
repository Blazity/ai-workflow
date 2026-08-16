import { describe, expect, it } from "vitest";
import type { BlockOutput, JsonValue } from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  portsOf,
} from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

const TEMPLATE = {
  id: "support-investigation",
  options: { includeReview: false, provider: "claude" as const },
};

const ZENDESK_PAYLOAD = {
  ticket: {
    id: 35436,
    subject: "The login button does nothing on Safari",
    description: "Three customers report the same failure after the release.",
    priority: "urgent",
    url: "https://support.example.test/agent/tickets/35436",
    requester: { email: "customer@example.test", name: "Ada" },
  },
};

const SENTRY_PAYLOAD = {
  action: "created",
  data: {
    issue: {
      id: "12345",
      title: "TypeError in session cookie handler",
      level: "error",
      permalink: "https://sentry.example.test/issues/12345",
      metadata: { value: "Cannot read properties of undefined (reading 'token')" },
    },
  },
  actor: { email: "sentry@example.test", name: "Sentry" },
};

function supportCase(input: {
  provider: "zendesk" | "sentry";
  endpoint: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  description: string;
  priority: string;
  customerContext: JsonValue;
  metadata: JsonValue;
}) {
  return {
    ...input,
    severity: input.priority,
    reporter:
      input.provider === "zendesk" ? "customer@example.test" : "sentry@example.test",
  };
}

const ZENDESK_CASE = supportCase({
  provider: "zendesk",
  endpoint: "wh_zendesk",
  sourceId: "35436",
  sourceUrl: "https://support.example.test/agent/tickets/35436",
  title: ZENDESK_PAYLOAD.ticket.subject,
  description: ZENDESK_PAYLOAD.ticket.description,
  priority: "urgent",
  customerContext: ZENDESK_PAYLOAD.ticket.requester,
  metadata: ZENDESK_PAYLOAD,
});

const SENTRY_CASE = supportCase({
  provider: "sentry",
  endpoint: "wh_sentry",
  sourceId: "12345",
  sourceUrl: SENTRY_PAYLOAD.data.issue.permalink,
  title: SENTRY_PAYLOAD.data.issue.title,
  description: SENTRY_PAYLOAD.data.issue.metadata.value,
  priority: "error",
  customerContext: SENTRY_PAYLOAD.actor,
  metadata: SENTRY_PAYLOAD,
});

function entry(
  provider: "zendesk" | "sentry",
  support: typeof ZENDESK_CASE,
): AgentWorkflowInput {
  return {
    kind: "webhook_trigger",
    endpointId: support.endpoint,
    definitionId: 42,
    definitionVersion: 7,
    nodeId: provider,
    deliveryId: `${provider}-delivery-1`,
    subjectKey: `webhook:${support.endpoint}:${support.sourceId}`,
    ownerToken: "owner-1",
    entry: {
      subject: support.title,
      description: support.description,
      requester: support.reporter,
      priority: support.priority,
      payload: provider === "zendesk" ? ZENDESK_PAYLOAD : SENTRY_PAYLOAD,
      supportCase: support,
    },
  };
}

function investigationOutput(
  classification: string,
  theory: string,
  options: { evidence?: JsonValue[]; partial?: string[]; partialReasons?: JsonValue[] } = {},
): BlockOutput {
  return {
    status: "ok",
    classification,
    theory,
    evidence: options.evidence ?? [],
    partial: options.partial ?? [],
    partialReasons: options.partialReasons ?? [],
  };
}

function classifierOutput(classification: string, rationale: string): BlockOutput {
  return { status: "completed", classification, rationale, data: { classification, rationale } };
}

function baseScenario(
  provider: "zendesk" | "sentry",
  support: typeof ZENDESK_CASE,
): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: entry(provider, support),
    entryTriggerId: provider,
  });
}

function scriptInvestigation(
  scenario: Scenario,
  classification: string,
  theory: string,
  options: { evidence?: JsonValue[]; partial?: string[]; partialReasons?: JsonValue[] } = {},
): void {
  scenario.script({ nodeId: "investigate" }, {
    kind: "next",
    output: investigationOutput(classification, theory, options),
  });
}

describe("support investigation workflow", () => {
  it("answers a Zendesk question with a bounded response and never prepares a workspace", async () => {
    const scenario = baseScenario("zendesk", ZENDESK_CASE);
    scriptInvestigation(scenario, "question", "The evidence explains the expected Safari behaviour.", {
      evidence: [{ ref: "slack:C_SUPPORT:1", source: "slack", title: "Raw support thread", excerpt: "Internal customer details", author: "U123", origin: "C_SUPPORT", timestamp: "2026-08-12T09:00:00Z", link: "https://slack.example.test/archives/C_SUPPORT/p1" }],
    });
    scenario.script({ nodeId: "classify" }, {
      kind: "next",
      output: classifierOutput("question", "The requester asks for an explanation, not a code change."),
    });
    scenario.script({ nodeId: "notify-non-code" }, { kind: "next", output: { status: "ok" } });

    const outcome = await scenario.execute();
    expect(outcome.result.outcome).toBe("completed");
    expect(portsOf(outcome, "code-route")).toEqual(["false"]);
    expect(executorRunsOf(outcome, "notify-non-code")[0]?.resolvedInputs?.message).toBe(
      "Support investigation summary\n\nCase: zendesk #35436 — The login button does nothing on Safari\nClassification: question\nRationale / evidence summary: The requester asks for an explanation, not a code change.\n\nResponse draft / investigation theory:\nThe evidence explains the expected Safari behaviour.",
    );
    expectNeverInvoked(outcome, ["prepare", "implementation", "checks", "finalize", "open-pr"]);
  });

  it("routes a known false positive from Sentry to the non-code summary", async () => {
    const scenario = baseScenario("sentry", SENTRY_CASE);
    scriptInvestigation(scenario, "false_positive", "The alert was emitted by a resolved test event.");
    scenario.script({ nodeId: "classify" }, {
      kind: "next",
      output: classifierOutput("false_positive", "The issue is noise and does not require a product change."),
    });
    scenario.script({ nodeId: "notify-non-code" }, { kind: "next", output: { status: "ok" } });

    const outcome = await scenario.execute();
    expect(outcome.result.outcome).toBe("completed");
    expectNeverInvoked(outcome, ["prepare", "implementation", "open-pr"]);
  });

  it("keeps missing context and provider gaps in the internal summary", async () => {
    const scenario = baseScenario("zendesk", {
      ...ZENDESK_CASE,
      title: "",
      description: "",
    });
    scriptInvestigation(scenario, "insufficient_data", "No usable context was available.", {
      partial: ["jira", "slack"],
      partialReasons: [
        { provider: "jira", reason: "unavailable", scope: "" },
        { provider: "slack", reason: "permission", scope: "" },
      ],
    });
    scenario.script({ nodeId: "classify" }, {
      kind: "next",
      output: classifierOutput("question", "Missing context requires a human response."),
    });
    scenario.script({ nodeId: "notify-non-code" }, { kind: "next", output: { status: "ok" } });

    const outcome = await scenario.execute();
    expect(outcome.result.outcome).toBe("completed");
    expectNeverInvoked(outcome, ["prepare", "implementation", "open-pr"]);
  });

  it("requires approval before a Zendesk code issue reaches implementation", async () => {
    const scenario = baseScenario("zendesk", ZENDESK_CASE);
    scriptInvestigation(scenario, "real_bug", "The same regression is present in Jira and Slack.", {
      evidence: [{ ref: "jira:AIW-9", source: "jira", title: "Safari regression", excerpt: "Same failure", author: "Ada", origin: "AIW", timestamp: "2026-08-12T09:00:00Z", link: "https://jira.example.test/browse/AIW-9" }],
    });
    scenario.script({ nodeId: "classify" }, {
      kind: "next",
      output: classifierOutput("code_issue", "The evidence supports a repository fix."),
    });
    scenario.script({ nodeId: "approval" }, {
      kind: "next",
      output: { status: "answered", questions: ["Approve"], answer: "approve" },
    });
    scenario.script({ nodeId: "prepare" }, { kind: "next", output: { status: "ok", sandboxId: "sbx", repositories: [], workspace: { id: "sbx", repositories: [] } } });
    scenario.script({ nodeId: "implementation" }, { kind: "next", output: { status: "implemented", workspaceId: "sbx", branches: [], commits: [], summary: "Fixed cookie handling." } });
    scenario.script({ nodeId: "checks" }, { kind: "next", output: { status: "ok", ok: true, outcome: "passed", fixCycles: 0, summary: "All focused checks passed." } });
    scenario.script({ nodeId: "finalize" }, { kind: "next", output: { status: "finalized", repositories: [] } });
    scenario.script({ nodeId: "open-pr" }, { kind: "next", output: { status: "ok", prs: [], prUrl: "", prNumber: 0 } });
    scenario.script({ nodeId: "notify-code" }, { kind: "next", output: { status: "ok" } });

    const outcome = await scenario.execute();
    expect(outcome.result.outcome).toBe("completed");
    expect(portsOf(outcome, "approval-route")).toEqual(["true"]);
    expect(executorRunsOf(outcome, "prepare")).toHaveLength(1);
  });

  it("rejects a Sentry code issue without workspace, implementation, or PR", async () => {
    const scenario = baseScenario("sentry", SENTRY_CASE);
    scriptInvestigation(scenario, "real_bug", "The stack trace points to a product defect.");
    scenario.script({ nodeId: "classify" }, {
      kind: "next",
      output: classifierOutput("code_issue", "A code change is proposed but needs approval."),
    });
    scenario.script({ nodeId: "approval" }, {
      kind: "next",
      output: { status: "answered", questions: ["Approve"], answer: "reject" },
    });

    const outcome = await scenario.execute();
    expect(outcome.result.outcome).toBe("completed");
    expect(portsOf(outcome, "approval-route")).toEqual(["false"]);
    expectNeverInvoked(outcome, ["prepare", "implementation", "checks", "finalize", "open-pr"]);
  });
});
