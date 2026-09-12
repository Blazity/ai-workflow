import { describe, expect, it } from "vitest";
import type { AgentWorkflowInput } from "../../engine/agent-input.js";
import { executionError } from "@shared/workflow-graph";
import { executorRunsOf, expectNeverInvoked, portsOf } from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The `fully-modular` template as an executable specification: a generic
 * planning agent, a generic implementation agent, a checks gate, an authored
 * Branch on the checks outcome, and either publication or a Terminate.
 *
 * The planning -> implementation handoff is NOT asserted here. That template
 * wires it as a `{{data:steps.planning.output.plan}}` token embedded in the
 * implementation node's `configuration.prompt`, with no declared `inputs`
 * binding at all. Substituting that token is `resolveV2PromptDataConfiguration`
 * in `engine/agent-workflow.ts`, called only from the production block dispatcher
 * the harness deliberately never runs (the harness's `resolvedInputs` comes
 * solely from `resolveWorkflowNodeInputsV2` over declared `inputs`/
 * `additionalInputs`, per packages/workflow-graph/scheduler.ts). Reimplementing
 * that substitution inside a scenario would duplicate product logic the
 * harness's own doctrine
 * forbids duplicating. See the AIW-197 report for the recommendation.
 *
 * Provider is fixed to "claude": see ticket-workflow.scenario.test.ts for why
 * varying it would not exercise anything the harness reads.
 */

const TEMPLATE = {
  id: "fully-modular",
  options: { includeReview: false, provider: "claude" as const },
};

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-412",
  ticketKey: "AIW-412",
  ownerToken: "owner-1",
};

function scenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
  });
}

const PREPARED_WORKSPACE_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    sandboxId: "sbx-scenario",
    repositories: ["github:acme/app"],
    workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
  },
};

// generic_agent with a custom outputSchema replaces the block's normal shape
// entirely: the response becomes `{ status, ...declaredProperties, data:
// <sameObject> }` (block-registry.ts `resolvedOutput`/`resolvedBindingOutput`
// for "generic_agent"), never the base `{ status, body }` shape.
const PLANNING_PLAN = "Implement the ticket by adding the missing check.";
const PLANNING_OUTPUT = {
  kind: "next" as const,
  output: { status: "completed", plan: PLANNING_PLAN, data: { plan: PLANNING_PLAN } },
};

const IMPLEMENTATION_SUMMARY = "Added the missing check and committed it.";
const IMPLEMENTATION_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "completed",
    summary: IMPLEMENTATION_SUMMARY,
    data: { summary: IMPLEMENTATION_SUMMARY },
  },
};

const CHECKS_PASSED_OUTPUT = {
  kind: "next" as const,
  output: { status: "ok", ok: true, outcome: "passed" as const, results: [], failures: [] },
};

const CHECKS_FAILED_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    ok: false,
    outcome: "failed" as const,
    results: [],
    failures: [{ command: "pnpm test", exitCode: 1 }],
  },
};

const FINALIZE_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "finalized",
    repositories: [
      {
        provider: "github",
        repoPath: "acme/app",
        branchName: "ai-workflow/AIW-412",
        defaultBranch: "main",
        expectedHead: "before",
        pushedHead: "after",
      },
    ],
  },
};

const OPEN_PR_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    prs: [
      {
        provider: "github",
        repoPath: "acme/app",
        id: 1,
        url: "https://github.test/acme/app/pull/1",
        branch: "ai-workflow/AIW-412",
        isNew: true,
      },
    ],
    prUrl: "https://github.test/acme/app/pull/1",
    prNumber: 1,
  },
};

describe("fully modular: happy path", () => {
  it("plans, implements, passes checks and opens a PR through the Branch's true port", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "planning" }, PLANNING_OUTPUT);
    s.script({ nodeId: "implementation" }, IMPLEMENTATION_OUTPUT);
    s.script({ nodeId: "checks" }, CHECKS_PASSED_OUTPUT);
    s.script({ nodeId: "finalize" }, FINALIZE_OUTPUT);
    s.script({ nodeId: "open-pr" }, OPEN_PR_OUTPUT);

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    expect(portsOf(outcome, "checks-passed")).toEqual(["true"]);
    // Bindings reach their real consumer: open-pr receives exactly the
    // repositories finalize published.
    expect(executorRunsOf(outcome, "open-pr")[0].resolvedInputs).toEqual({
      repositories: FINALIZE_OUTPUT.output.repositories,
    });
    expectNeverInvoked(outcome, ["checks-failed"]);
  });
});

describe("fully modular: checks fail (the authored Branch's other path, a domain failure)", () => {
  it("terminates the run as failed through the authored Branch, and never publishes", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "planning" }, PLANNING_OUTPUT);
    s.script({ nodeId: "implementation" }, IMPLEMENTATION_OUTPUT);
    s.script({ nodeId: "checks" }, CHECKS_FAILED_OUTPUT);

    const outcome = await s.execute();

    expect(portsOf(outcome, "checks-passed")).toEqual(["false"]);
    expect(outcome.result.outcome).toBe("failed");
    // The authored Terminate reports category "engine" / phase "terminate": a
    // domain decision the graph itself made by wiring the Branch's false port
    // to Terminate, never to be mistaken for the sandbox crash the next
    // describe block proves (category "sandbox").
    expect(outcome.result.executionError).toMatchObject({
      nodeId: "checks-failed",
      category: "engine",
      phase: "terminate",
    });
    expectNeverInvoked(outcome, ["finalize", "open-pr"]);
  });
});

describe("fully modular: a critical technical failure", () => {
  it("fails the run and blocks every node downstream of implementation, never reaching the Branch", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "planning" }, PLANNING_OUTPUT);
    s.script(
      { nodeId: "implementation" },
      executionError("The implementation sandbox crashed.", {
        category: "sandbox",
        phase: "agent",
      }),
    );

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toMatchObject({
      nodeId: "implementation",
      category: "sandbox",
    });
    // A control node leaves a record only when it runs, and there is none: the
    // Branch never evaluated a checks outcome that was never produced.
    expect(outcome.invocationsOf("checks-passed")).toEqual([]);
    expectNeverInvoked(outcome, ["checks", "finalize", "open-pr", "checks-failed"]);
  });
});
