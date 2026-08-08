import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import type { WorkflowBlockRegistryContext } from "../block-registry.js";
import {
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionSchema,
} from "../schema.js";
import { executorRunsOf, expectStartsAfterFinishOf } from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The committed `schedule-open-pr-v1` snapshot as an executable specification.
 *
 * Every scenario drives that snapshot through the production v2 scheduler, so
 * the trigger_schedule node and the bindings out of it are the real ones. Only
 * the action blocks (prepare, agent, finalize, open-pr) are scripted.
 *
 * The graph:
 *   trigger (trigger_schedule) -> prepare (prepare_workspace) -> agent (generic_agent)
 *     -> finalize (finalize_workspace) -> open-pr (open_pr) -> terminate
 *
 * `prepare` and `finalize` are not agents, they are the workspace plumbing any
 * graph that opens a PR must have: the deployment validator refuses an
 * `open_pr.repositories` binding that is not an exact reference to a
 * `finalize_workspace` node's own output (see `available-values.ts`'s
 * "binding.open_pr_finalize" check), so a PR-opening schedule graph can never
 * skip straight from the one agent to publication.
 *
 * A run started by the schedule dispatcher carries no ticket: it claims its
 * subject with `ticketKey: null` (schedule-trigger/dispatch-schedule-trigger.ts)
 * and `AgentWorkflowInput`'s "schedule" variant has no ticket field at all. So
 * this suite never passes a `ticket` context to the harness, and every
 * assertion below is about values that reached their block from the trigger's
 * own output (`scheduledFor`, `taskTitle`, `taskDescription`), never from a
 * ticket that a scheduled run simply does not have.
 */

const SNAPSHOT = { path: "schedule-open-pr-v1.json" };

/** What the installation offers, stated the way `harness.ts`'s own snapshot
 * loader states it: every provider declared present so the deployment check
 * below is about the definition's shape rather than about this machine's
 * configuration. */
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

const TASK_TITLE = "Weekly dependency audit";
const TASK_DESCRIPTION =
  "Open a PR summarizing dependency updates due for review.";

/** Narrowed to the "schedule" branch of `AgentWorkflowInput` so callers can
 * read `scheduledFor` back off the entry they built without a type guard. */
type ScheduleEntry = Extract<AgentWorkflowInput, { kind: "schedule" }>;

function scheduleEntry(options: {
  scheduledFor: string;
  previousScheduledFor?: string;
}): ScheduleEntry {
  return {
    kind: "schedule",
    scheduleId: "sched-1",
    definitionId: 1,
    definitionVersion: 1,
    nodeId: "trigger",
    subjectKey: "schedule:sched-1",
    ownerToken: "owner-1",
    scheduledFor: options.scheduledFor,
    ...(options.previousScheduledFor === undefined
      ? {}
      : { previousScheduledFor: options.previousScheduledFor }),
    taskTitle: TASK_TITLE,
    taskDescription: TASK_DESCRIPTION,
  };
}

function scheduleScenario(entry: AgentWorkflowInput): Scenario {
  return createScenario({
    snapshot: SNAPSHOT,
    entry,
    entryTriggerId: "trigger",
  });
}

/** Branch name synthesized from the occurrence instant, so a scenario can
 * prove the identifier reaching publication is a function of this run's
 * schedule occurrence rather than a fixed string. `finalize_workspace` has no
 * bound inputs of its own (see `block-registry.ts`'s empty `inputs: {}`): in
 * production it names the branch from the run's own identity, so the script
 * below reproduces that by reading the occurrence straight off the entry it
 * was given, exactly as the real block would read it off the run. */
function branchNameFor(scheduledFor: string): string {
  return `ai-workflow/schedule-${scheduledFor.replace(/[^0-9A-Za-z]+/g, "-")}`;
}

/** Workspace setup. Not an agent and not scriptable behaviour worth varying:
 * every scenario needs the same sandbox to exist before the agent can write
 * to it. */
function scriptPrepare(scenario: Scenario): void {
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: {
      status: "ok",
      sandboxId: "sbx-schedule",
      repositories: ["github:acme/app"],
      workspace: { id: "sbx-schedule", repositories: ["github:acme/app"] },
    },
  });
}

/** The one agent block. Its only bound input is the trigger's `scheduledFor`
 * (via `steps.entry.output.scheduledFor`), proving the occurrence instant
 * reaches it and not any ticket field, since a scheduled run has none. */
function scriptAgent(scenario: Scenario): void {
  scenario.script({ nodeId: "agent" }, (_node, resolvedInputs) => ({
    kind: "next",
    output: { status: "completed", body: `Handled occurrence ${resolvedInputs.prompt as string}.` },
  }));
}

/** Publishes the finalized branch. `finalize_workspace` takes no formal input
 * (it operates on the shared sandbox, not on bound JSON values), so the
 * occurrence it names the branch after comes from the entry the scenario
 * itself was built with, exactly like a real finalize step would read the
 * run's own identity rather than a graph binding. */
function scriptFinalize(scenario: Scenario, scheduledFor: string): void {
  scenario.script({ nodeId: "finalize" }, {
    kind: "next",
    output: {
      status: "finalized",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: branchNameFor(scheduledFor),
          defaultBranch: "main",
          expectedHead: "before",
          pushedHead: "after",
        },
      ],
    },
  });
}

/** The publication block. */
function scriptOpenPr(scenario: Scenario): void {
  scenario.script({ nodeId: "open-pr" }, (_node, resolvedInputs) => {
    const repositories = resolvedInputs.repositories as Array<{
      branchName: string;
    }>;
    const branch = repositories[0]!.branchName;
    return {
      kind: "next",
      output: {
        status: "ok",
        prs: [
          {
            provider: "github",
            repoPath: "acme/app",
            id: 7,
            url: "https://github.test/acme/app/pull/7",
            branch,
            isNew: true,
          },
        ],
        prUrl: "https://github.test/acme/app/pull/7",
        prNumber: 7,
      },
    };
  });
}

describe("schedule trigger: the shipped snapshot", () => {
  it("deploys with no validation issues", () => {
    const raw = JSON.parse(
      readFileSync(new URL(`./snapshots/${SNAPSHOT.path}`, import.meta.url), "utf8"),
    );
    const definition = workflowDefinitionSchema.parse(raw) as WorkflowDefinitionV2;
    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, REGISTRY_CONTEXT, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual([]);
  });
});

describe("schedule trigger: open PR snapshot", () => {
  it("threads the trigger's task title, description and occurrence into the PR, for a later occurrence", async () => {
    const entry = scheduleEntry({
      scheduledFor: "2026-08-08T06:00:00.000Z",
      previousScheduledFor: "2026-08-08T05:30:00.000Z",
    });
    const scenario = scheduleScenario(entry);
    scriptPrepare(scenario);
    scriptAgent(scenario);
    scriptFinalize(scenario, entry.scheduledFor);
    scriptOpenPr(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    for (const nodeId of ["prepare", "agent", "finalize", "open-pr"]) {
      expect(executorRunsOf(outcome, nodeId)).toHaveLength(1);
    }
    const [agent] = executorRunsOf(outcome, "agent");
    const [finalize] = executorRunsOf(outcome, "finalize");
    const [openPr] = executorRunsOf(outcome, "open-pr");
    expectStartsAfterFinishOf(finalize, agent);
    expectStartsAfterFinishOf(openPr, finalize);

    // The agent's only bound input is the trigger's occurrence instant: no
    // ticket field is anywhere near it, because a scheduled run has none.
    expect(agent.resolvedInputs).toEqual({ prompt: entry.scheduledFor });

    // The PR block receives the task's title and description straight from
    // the trigger, not from a ticket, plus the branch finalize published for
    // this occurrence.
    const expectedBranch = branchNameFor(entry.scheduledFor);
    expect(openPr.resolvedInputs).toEqual({
      title: TASK_TITLE,
      body: TASK_DESCRIPTION,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: expectedBranch,
          defaultBranch: "main",
          expectedHead: "before",
          pushedHead: "after",
        },
      ],
    });
    // The identifier reaching publication is synthesized per occurrence:
    // never empty, and never shaped like a Jira ticket key (e.g. "AIW-198").
    expect(expectedBranch.length).toBeGreaterThan(0);
    expect(expectedBranch).not.toMatch(/^[A-Z]+-\d+$/);
  });

  it("still opens a PR for a first occurrence, with no previous run to compare against", async () => {
    const entry = scheduleEntry({ scheduledFor: "2026-08-01T05:30:00.000Z" });
    expect(entry).not.toHaveProperty("previousScheduledFor");
    const scenario = scheduleScenario(entry);
    scriptPrepare(scenario);
    scriptAgent(scenario);
    scriptFinalize(scenario, entry.scheduledFor);
    scriptOpenPr(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const [agent] = executorRunsOf(outcome, "agent");
    const [openPr] = executorRunsOf(outcome, "open-pr");

    // A missing `previousScheduledFor` does not stop the run, and the graph
    // never binds it, so there is no empty-string chain to smuggle through:
    // the same bound fields resolve exactly as they do for a later occurrence.
    expect(agent.resolvedInputs).toEqual({ prompt: entry.scheduledFor });
    const expectedBranch = branchNameFor(entry.scheduledFor);
    expect(openPr.resolvedInputs).toEqual({
      title: TASK_TITLE,
      body: TASK_DESCRIPTION,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: expectedBranch,
          defaultBranch: "main",
          expectedHead: "before",
          pushedHead: "after",
        },
      ],
    });
    // A different occurrence synthesizes a different branch: the identifier
    // is per-occurrence, not a fixed placeholder that would silently repeat
    // across every run of the schedule.
    expect(expectedBranch).not.toBe(branchNameFor("2026-08-08T06:00:00.000Z"));
  });
});
