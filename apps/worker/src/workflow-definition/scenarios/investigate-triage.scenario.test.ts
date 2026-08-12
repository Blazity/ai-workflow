import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  JsonValue,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import type { WorkflowBlockRegistryContext } from "../block-registry.js";
import { executionError } from "../interpreter.js";
import { validateWorkflowDefinitionIssuesForDeployment } from "../schema.js";
import { executorRunsOf, expectNeverInvoked, portsOf } from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * Investigate-led ticket triage as an executable specification (AIW-257).
 *
 * Every scenario runs the committed graph through the production v2 scheduler,
 * so the Branch that reads the investigation's classification is the real one and
 * so is the scheduler's own failure handling; only the action blocks are
 * scripted.
 * What the block does INSIDE itself (which provider it calls, how it scopes the
 * Jira query, how a provider failure degrades) is unit-tested in
 * `blocks/investigate.test.ts`; what these scenarios prove is that each of those
 * outcomes reaches the rest of the graph correctly:
 *
 *   trigger -> investigate -> route (Branch on classification)
 *     route --true--> ask (human question)
 *     route --false--> answer (comment carrying the theory) -> close
 *
 * A v2 graph has no failure edge to wire, so a failing investigation fails the
 * run at that node instead of taking an arm of its own.
 *
 * The graph is also the plan's terminating shape: every path ends in a ticket
 * mutation or a human question, so the ticket leaves the AI column and the
 * poller cannot re-run the investigation on the next tick. There is no Loop, so
 * every block runs at most once, on attempt 1, in the single "root" activation
 * scope.
 */

const SNAPSHOT = { path: "investigate-triage-v1.json" };

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AWT-1",
  ticketKey: "AWT-1",
  ownerToken: "owner-1",
};

const TICKET_CONTEXT = {
  identifier: "AWT-1",
  title: "Login button does nothing on Safari",
  description: "Reported by three customers this morning.",
  acceptanceCriteria: "",
  labels: ["support"],
  comments: [],
};

/** Every provider declared present, so these checks are about the definition's
 *  shape rather than about this machine's configuration. */
const REGISTRY_CONTEXT: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-scenario" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

/** The two evidence items, in the normalized shape the block emits whichever
 *  provider produced them. */
const JIRA_EVIDENCE = {
  ref: "jira:AWT-9",
  source: "jira",
  title: "AWT-9 Login button unresponsive",
  excerpt: "[In Progress] Safari 17 rejects the session cookie.",
  author: "Ada Lovelace",
  origin: "AWT",
  timestamp: "2026-08-10T09:15:00.000Z",
  link: "https://jira.example.com/browse/AWT-9",
};
const SLACK_EVIDENCE = {
  ref: "slack:C_SUPPORT/1754000000.000100",
  source: "slack",
  title: "login is broken again",
  excerpt: "login is broken again",
  author: "U42",
  origin: "C_SUPPORT",
  timestamp: "2025-07-31T22:13:20.000Z",
  link: "https://slack.example/p/1",
};

/** One investigation result, in the block's output shape. */
function investigateOutput(options: {
  classification: string;
  theory: string;
  evidence: JsonValue[];
  partial?: string[];
  partialReasons?: JsonValue[];
}): BlockOutput {
  return {
    status: "ok",
    classification: options.classification,
    theory: options.theory,
    evidence: options.evidence,
    partial: options.partial ?? [],
    partialReasons: options.partialReasons ?? [],
  };
}

function triageScenario(): Scenario {
  return createScenario({
    snapshot: SNAPSHOT,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
}

/** The two arms of the Branch, so a scenario can assert the other one stayed
 *  dark. */
const HUMAN_ARM = ["ask"];
const ANSWER_ARM = ["answer", "close"];

function scriptAnswerArm(scenario: Scenario): void {
  scenario.script({ nodeId: "answer" }, {
    kind: "next",
    output: { status: "ok", commentUrl: "https://jira.example.com/browse/AWT-1#c1" },
  });
  scenario.script({ nodeId: "close" }, {
    kind: "next",
    output: { status: "ok", target: "Backlog" },
  });
}

describe("investigate triage: the committed definition", () => {
  it("deploys with no validation issues", () => {
    const definition = JSON.parse(
      readFileSync(new URL(`./snapshots/${SNAPSHOT.path}`, import.meta.url), "utf8"),
    ) as WorkflowDefinitionV2;

    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, REGISTRY_CONTEXT, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual([]);
  });
});

describe("investigate triage: both providers found evidence", () => {
  it("routes a real bug to a human with the combined evidence available", async () => {
    const scenario = triageScenario();
    scenario.script({ nodeId: "investigate" }, {
      kind: "next",
      output: investigateOutput({
        classification: "real_bug",
        theory: "AWT-9 describes the same Safari cookie rejection.",
        evidence: [JIRA_EVIDENCE, SLACK_EVIDENCE],
      }),
    });
    scenario.script({ nodeId: "ask" }, {
      kind: "next",
      output: {
        status: "answered",
        questions: ["The investigation says this is a real bug. Open a PR?"],
        suggestedAnswers: [],
        answer: "Yes, open a PR.",
      },
    });

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    // The Branch reads steps.investigate.output.classification, so the
    // classification really crosses the edge into control flow.
    expect(portsOf(outcome, "route")).toEqual(["true"]);
    expect(executorRunsOf(outcome, "ask")).toHaveLength(1);
    expectNeverInvoked(outcome, ANSWER_ARM);
    // Both providers' evidence survives in one list, normalized identically.
    const [investigation] = executorRunsOf(outcome, "investigate");
    expect(investigation).toBeDefined();
    const evidence = outcome.result.steps?.investigate?.output?.evidence as
      | Record<string, unknown>[]
      | undefined;
    expect(evidence?.map((item) => item.source)).toEqual(["jira", "slack"]);
    expect(evidence?.map((item) => item.link)).toEqual([
      JIRA_EVIDENCE.link,
      SLACK_EVIDENCE.link,
    ]);
  });
});

describe("investigate triage: one provider only", () => {
  it("answers the ticket from Jira-only evidence and reports Slack as the gap", async () => {
    const scenario = triageScenario();
    scenario.script({ nodeId: "investigate" }, {
      kind: "next",
      output: investigateOutput({
        classification: "known_issue",
        theory: "AWT-9 already tracks this.\n\nNot searched: Slack (no access).",
        evidence: [JIRA_EVIDENCE],
        partial: ["slack"],
        partialReasons: [{ provider: "slack", reason: "permission", scope: "" }],
      }),
    });
    scriptAnswerArm(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(portsOf(outcome, "route")).toEqual(["false"]);
    // The theory crosses the edge whole into the comment the human reads,
    // including the sentence naming what could not be searched.
    const [answer] = executorRunsOf(outcome, "answer");
    expect(answer?.resolvedInputs).toEqual({
      body: "AWT-9 already tracks this.\n\nNot searched: Slack (no access).",
    });
    // The ticket still leaves the AI column, which is what stops the poller from
    // investigating it again on the next tick.
    expect(executorRunsOf(outcome, "close")).toHaveLength(1);
    expectNeverInvoked(outcome, HUMAN_ARM);
  });

  it("answers the ticket from Slack-only evidence and reports Jira as the gap", async () => {
    const scenario = triageScenario();
    scenario.script({ nodeId: "investigate" }, {
      kind: "next",
      output: investigateOutput({
        classification: "question",
        theory: "The thread explains the expected behaviour; no defect here.",
        evidence: [SLACK_EVIDENCE],
        partial: ["jira"],
        partialReasons: [{ provider: "jira", reason: "unavailable", scope: "" }],
      }),
    });
    scriptAnswerArm(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(portsOf(outcome, "route")).toEqual(["false"]);
    const evidence = outcome.result.steps?.investigate?.output?.evidence as
      | Record<string, unknown>[]
      | undefined;
    expect(evidence?.map((item) => item.source)).toEqual(["slack"]);
    expect(executorRunsOf(outcome, "close")).toHaveLength(1);
    expectNeverInvoked(outcome, HUMAN_ARM);
  });
});

describe("investigate triage: nothing found", () => {
  it("treats an empty search as a normal answer, not a failure", async () => {
    const scenario = triageScenario();
    scenario.script({ nodeId: "investigate" }, {
      kind: "next",
      output: investigateOutput({
        classification: "insufficient_data",
        theory: "Nothing similar exists in Jira or the support channel.",
        evidence: [],
      }),
    });
    scriptAnswerArm(scenario);

    const outcome = await scenario.execute();

    // Empty is a result, so the run completes and the ticket still gets an
    // answer: no evidence must never look like a broken investigation.
    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    expect(portsOf(outcome, "route")).toEqual(["false"]);
    expect(executorRunsOf(outcome, "answer")).toHaveLength(1);
    expectNeverInvoked(outcome, HUMAN_ARM);
  });
});

describe("investigate triage: the investigation itself fails", () => {
  it("fails the run and routes nothing when the block cannot produce a theory", async () => {
    const scenario = triageScenario();
    // Only an LLM failure fails the block. A provider failure does not: it
    // degrades into partial, which the scenarios above take through the graph.
    // A v2 graph has no failure edge to wire, so the scheduler owns this: the
    // run fails at the node and nothing downstream is invoked.
    scenario.script(
      { nodeId: "investigate" },
      executionError("llm unavailable", { category: "provider" }),
    );

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    // The run names the block that failed, so an operator is not left guessing
    // which half of the investigation broke.
    expect(outcome.result.executionError).toMatchObject({
      nodeId: "investigate",
      attempt: 1,
      category: "provider",
    });
    expect(String(outcome.result.executionError?.message)).toContain(
      "llm unavailable",
    );
    // The Branch and both arms stay dark: there is no classification to route on,
    // and no comment claims an answer the investigation never produced.
    expectNeverInvoked(outcome, ["route", ...HUMAN_ARM, ...ANSWER_ARM]);
  });
});
