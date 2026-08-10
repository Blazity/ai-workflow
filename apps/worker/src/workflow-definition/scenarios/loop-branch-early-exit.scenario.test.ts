import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import type { WorkflowBlockRegistryContext } from "../block-registry.js";
import {
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionSchema,
} from "../schema.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  portsOf,
} from "./assertions.js";
import { createScenario } from "./harness.js";

const SNAPSHOT = { path: "loop-branch-early-exit-v1.json" };

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

/**
 * A customer-authored Loop shape that no shipped template can reach.
 *
 * The six built-in templates all wire a Loop with exactly one incoming edge, so
 * none of them exercises what happens when a Branch inside a loop region selects
 * an exit while the Loop is still live. The editor imposes no such restriction,
 * and the product's premise is that customers draw their own graphs, so this
 * shape is reachable in the field even though the catalog never produces it.
 *
 * The graph in `loop-branch-early-exit-v1.json` satisfies both conditions the
 * scheduler needs to build a region with a contested boundary:
 *
 *   1. the Loop carries an incoming edge from outside its own region
 *      (`seed -> loop`, alongside the in-region `gate -> loop`), and
 *   2. the region has an external body entry, an edge from outside into a member
 *      that is not the Loop itself (`seed -> work`).
 *
 * The strongly connected component is therefore `{loop, work, gate}`, and `work`
 * is reachable without passing through the Loop. On the first pass `gate` can
 * take its `true` port and leave the region while the Loop has attempts left.
 *
 * AIW-228 predicts an `executionError { category: "engine", phase: "loop" }` on
 * exactly this shape, from the boundary being resolved twice. That crash does not
 * happen, because `setEdgeToken` treats a write of the value an edge already
 * carries as a no-op rather than a contradiction (`v2-scheduler.ts:830`).
 *
 * What happens instead is quieter, and for an agent block worse. `seed -> loop`
 * goes active the moment `seed` finishes, and a node is admitted when *any*
 * incoming edge is active rather than when a particular one is
 * (`resolveNodeIfReady`, `v2-scheduler.ts:922-923`). Whichever port `gate` picks,
 * the Loop is therefore never skipped: it is admitted, and its fresh branch
 * spawns an iteration (`v2-scheduler.ts:1298`) that re-runs the whole region in a
 * child scope, alongside the exit the Branch has already selected. The run's own
 * bookkeeping is reconciled afterwards, so the outcome reads `completed` with no
 * error while `work` really did execute twice.
 *
 * The scenarios below pin that duplicate as an assertion rather than describe it
 * in prose, so the day it is fixed the pin fails and the fix is visible instead
 * of silent.
 */

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-228",
  ticketKey: "AIW-228",
  ownerToken: "owner-1",
};

const TICKET_CONTEXT = {
  identifier: "AIW-228",
  title: "Loop boundary resolves twice when a Branch exits a running region",
  description: "A customer-authored graph, not a shipped template.",
  acceptanceCriteria: "The engine does not fail a legal graph.",
  labels: ["ai"],
  comments: [],
};

function snapshotDefinition(): WorkflowDefinitionV2 {
  const raw = JSON.parse(
    readFileSync(new URL(`./snapshots/${SNAPSHOT.path}`, import.meta.url), "utf8"),
  );
  return workflowDefinitionSchema.parse(raw) as WorkflowDefinitionV2;
}

function scenarioFor(verdict: string) {
  const scenario = createScenario({
    snapshot: SNAPSHOT,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
  scenario.script({ nodeId: "seed" }, {
    kind: "next",
    output: { status: "completed", body: "First draft." },
  });
  scenario.script({ nodeId: "work" }, {
    kind: "next",
    output: { status: "completed", verdict, data: { verdict } },
  });
  return scenario;
}

describe("customer-authored loop with a contested boundary", () => {
  it("deploys with no validation issues", () => {
    // Load bearing for everything below: the point of these scenarios is that a
    // customer can draw this graph and ship it. If validation refused it, the
    // engine behaviour would be unreachable and this file would assert nothing.
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        snapshotDefinition(),
        REGISTRY_CONTEXT,
        { checkEnvironmentAvailability: false },
      ),
    ).toEqual([]);
  });

  it("does not fail the run when a Branch exits a region the Loop still owns", async () => {
    // The graph is legal in the editor, so an engine error would be unreadable
    // advice: the user has no way to act on "resolved more than once".
    const outcome = await scenarioFor("accept").execute();

    expect(outcome.result.executionError).toBeUndefined();
    expect(outcome.result.outcome).toBe("completed");
  });

  it("runs the region twice for one logical pass, which is the defect", async () => {
    // Pinned, not endorsed. One pass through the graph executes the agent block
    // twice, in two activation scopes, and the run reports success either way.
    // `generic_agent` can hold a workspace open, commit, and cost money, so a
    // second silent execution is not bookkeeping. The outcome above stays clean,
    // which is exactly why nothing surfaces this today.
    const outcome = await scenarioFor("accept").execute();

    expect(
      executorRunsOf(outcome, "work").map((invocation) => ({
        attempt: invocation.attempt,
        activationScopeId: invocation.activationScopeId,
      })),
    ).toEqual([
      { attempt: 1, activationScopeId: "root" },
      { attempt: 2, activationScopeId: "root/loop:loop:1" },
    ]);
    expect(portsOf(outcome, "gate")).toEqual(["true", "true"]);
  });

  it("still reaches the Loop's exhausted port when the Branch keeps rejecting", async () => {
    // The other half of the boundary: with the exit never selected, the region
    // runs its attempts out and leaves through `exhausted`. The failure below is
    // the graph's own Terminate, not an engine fault, and Terminate is never
    // scripted, so this is the production dispatcher's result.
    const outcome = await scenarioFor("reject").execute();

    // The externally entered pass plus one per attempt: `maxAttempts: 3` buys
    // four decisions, the same arithmetic the shipped reviewed-ticket template
    // shows as four review passes.
    expect(portsOf(outcome, "gate")).toEqual([
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(portsOf(outcome, "loop")).toEqual([
      "exhausted",
      "continue",
      "continue",
      undefined,
    ]);
    expect(executorRunsOf(outcome, "giveup")).toHaveLength(1);
    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toEqual({
      nodeId: "giveup",
      attempt: 1,
      category: "engine",
      phase: "terminate",
      message:
        "The workflow engine could not continue. (Terminated by workflow.)",
      diagnosticId: "AIW-DIAG-test-run-giveup-1",
    });
    expectNeverInvoked(outcome, ["done"]);
  });
});
