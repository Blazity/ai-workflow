import { describe, expect, it } from "vitest";
import type { BlockOutput, JsonValue, WorkflowDefinitionV2 } from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import type { WorkflowBlockRegistryContext } from "../block-registry.js";
import { validateWorkflowDefinitionIssuesForDeployment } from "../schema.js";
import { workflowDefinitionTemplate } from "../templates.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  expectStartsAfterFinishOf,
  portsOf,
} from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The shipped webhook ticket triage template as an executable specification.
 *
 * Every scenario runs the `webhook-ticket-triage` template through the
 * production v2 scheduler, so the Branch that decides "code issue?" and the two
 * arms downstream of it are the real ones. Only the action blocks (the three
 * generic agents, the workspace blocks, the PR block and the Slack notices) are
 * scripted; the trigger and the Branch are resolved by the scheduler itself.
 *
 * The graph, with column/row omitted:
 *   trigger -> triage -> assess -> code-issue (Branch)
 *     code-issue --true--> prepare -> implement -> finalize -> open-pr -> notify
 *     code-issue --false--> notify-no-code
 * There is no Loop, so every block runs at most once, on attempt 1, in the
 * single "root" activation scope.
 */

const TEMPLATE = {
  id: "webhook-ticket-triage",
  options: { includeReview: true, provider: "claude" as const },
};

/** Everything downstream of a "code issue" verdict. */
const CODE_ARM = ["prepare", "implement", "finalize", "open-pr", "notify"];

/** What the installation offers, stated the way the snapshot loader states it in
 * `harness.ts`: every provider declared present so these checks are about the
 * definition's shape rather than about this machine's configuration. */
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

const WEBHOOK_ENTRY: AgentWorkflowInput = {
  kind: "webhook_trigger",
  endpointId: `wh_${"0".repeat(24)}`,
  definitionId: 1,
  definitionVersion: 1,
  nodeId: "trigger",
  deliveryId: "d-1",
  subjectKey: "webhook:wh_000000000000000000000000:T-1",
  ownerToken: "owner-1",
  entry: {
    subject: "Printer is on fire",
    description: "Smoke everywhere in the office",
    requester: "ops@acme.test",
    priority: "urgent",
    payload: { ticket: { id: "T-1" } },
  },
};

function triageScenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: WEBHOOK_ENTRY,
    entryTriggerId: "trigger",
  });
}

/** The runtime shape a generic_agent with a declared object output schema emits:
 * the structured fields at the top level, the reserved runtime status, and the
 * compatibility `data` alias (see `blocks/generic-agent.ts`). */
function genericAgentOutput(data: Record<string, JsonValue>): BlockOutput {
  return { status: "completed", ...data, data };
}

/** Triage and assessment, with the assessment's code-issue verdict left to the
 * caller so a scenario picks which Branch arm the run takes. */
function scriptTriageAndAssess(scenario: Scenario, codeIssue: boolean): void {
  scenario.script({ nodeId: "triage" }, {
    kind: "next",
    output: genericAgentOutput({
      category: "incident",
      summary: "A printer is on fire in the office.",
    }),
  });
  scenario.script({ nodeId: "assess" }, {
    kind: "next",
    output: genericAgentOutput({
      severity: "high",
      codeIssue,
      rationale: codeIssue
        ? "The firmware handler ignores a thermal cutoff."
        : "This is a facilities incident, not a software defect.",
    }),
  });
}

/** Everything the code arm needs after an approving Branch. */
function scriptCodeArm(scenario: Scenario): void {
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: {
      status: "ok",
      sandboxId: "sbx-scenario",
      repositories: ["github:acme/app"],
      workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
    },
  });
  scenario.script({ nodeId: "implement" }, {
    kind: "next",
    output: genericAgentOutput({ summary: "Added the missing thermal guard." }),
  });
  scenario.script({ nodeId: "finalize" }, {
    kind: "next",
    output: {
      status: "finalized",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: "ai-workflow/webhook-triage",
          defaultBranch: "main",
          expectedHead: "before",
          pushedHead: "after",
        },
      ],
    },
  });
  scenario.script({ nodeId: "open-pr" }, {
    kind: "next",
    output: {
      status: "ok",
      prs: [
        {
          provider: "github",
          repoPath: "acme/app",
          id: 1,
          url: "https://github.test/acme/app/pull/1",
          branch: "ai-workflow/webhook-triage",
          isNew: true,
        },
      ],
      prUrl: "https://github.test/acme/app/pull/1",
      prNumber: 1,
    },
  });
  scenario.script({ nodeId: "notify" }, { kind: "next", output: { status: "ok" } });
}

describe("webhook ticket triage: the shipped definition", () => {
  it("deploys with no validation issues", () => {
    const template = workflowDefinitionTemplate(TEMPLATE.id, TEMPLATE.options);
    const definition = template?.definition as WorkflowDefinitionV2;
    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, REGISTRY_CONTEXT, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual([]);
  });
});

describe("webhook ticket triage: a code issue", () => {
  it("opens a fix PR and notifies the team when the assessment finds code", async () => {
    const scenario = triageScenario();
    scriptTriageAndAssess(scenario, true);
    scriptCodeArm(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    // The Branch reads steps.assess.output.codeIssue; a code issue leaves it
    // through the "true" port and into the workspace arm.
    expect(portsOf(outcome, "code-issue")).toEqual(["true"]);
    for (const nodeId of ["triage", "assess", ...CODE_ARM]) {
      expect(executorRunsOf(outcome, nodeId)).toHaveLength(1);
    }
    // The two agents are sequential, and every code-arm block waits for the one
    // before it, so the delivered ticket really flows all the way to the PR.
    const [triage] = executorRunsOf(outcome, "triage");
    const [assess] = executorRunsOf(outcome, "assess");
    expectStartsAfterFinishOf(assess, triage);
    const [prepare] = executorRunsOf(outcome, "prepare");
    const [implement] = executorRunsOf(outcome, "implement");
    const [finalize] = executorRunsOf(outcome, "finalize");
    const [openPr] = executorRunsOf(outcome, "open-pr");
    const [notify] = executorRunsOf(outcome, "notify");
    expectStartsAfterFinishOf(implement, prepare);
    expectStartsAfterFinishOf(finalize, implement);
    expectStartsAfterFinishOf(openPr, finalize);
    expectStartsAfterFinishOf(notify, openPr);
    // open_pr binds steps.finalize.output.repositories: the finalized branch
    // crosses the edge whole, so the PR block receives exactly it.
    expect(openPr.resolvedInputs).toEqual({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: "ai-workflow/webhook-triage",
          defaultBranch: "main",
          expectedHead: "before",
          pushedHead: "after",
        },
      ],
    });
    expectNeverInvoked(outcome, ["notify-no-code"]);
  });
});

describe("webhook ticket triage: no code change", () => {
  it("notifies a human and opens no PR when the issue is not in code", async () => {
    const scenario = triageScenario();
    scriptTriageAndAssess(scenario, false);
    scenario.script({ nodeId: "notify-no-code" }, {
      kind: "next",
      output: { status: "ok" },
    });

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    expect(portsOf(outcome, "code-issue")).toEqual(["false"]);
    expect(executorRunsOf(outcome, "notify-no-code")).toHaveLength(1);
    // The whole workspace arm stays dark: no sandbox is prepared and no PR is
    // opened for a ticket that needs no code change.
    expectNeverInvoked(outcome, CODE_ARM);
  });
});
