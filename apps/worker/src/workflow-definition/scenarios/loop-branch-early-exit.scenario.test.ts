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
  expectStartsAfterFinishOf,
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
 * exactly this shape, from the boundary being resolved twice. It does not fire,
 * but not because a repeated write is harmless. `setEdgeToken` only tolerates a
 * write of the value an edge already carries (`v2-scheduler.ts:841`); writing
 * "active" over an "inactive" a first pass left is still a contradiction, and a
 * region with two exits produces exactly that write. What keeps the boundary
 * consistent is the deferral: a member resolves only the edges its own selected
 * port takes, leaves the rest of the region's boundary unresolved because a
 * retry may still select it, and `settleLoopBoundaryEdges` fills in the leftover
 * once, never rewriting a decision already recorded. On this first shape there is
 * one member with one exit, so there is nothing to contradict; the two-exit
 * scenarios at the bottom of this file are where that claim is actually tested.
 *
 * What the shape really tests is quieter, and for an agent block worse.
 * `seed -> loop` goes active the moment `seed` finishes, and a node is admitted
 * when *any* incoming edge is active rather than when a particular one is
 * (`resolveNodeIfReady`, `v2-scheduler.ts:923-926`), so the Loop's own arm going
 * inactive is not enough to keep it from running. AIW-242 was exactly that: the
 * Loop was admitted after `gate` had already left the region, and its fresh
 * branch spawned an iteration (`v2-scheduler.ts:1330`) that re-ran the whole
 * region in a child scope. Nothing surfaced it, because the run's bookkeeping is
 * reconciled afterwards and the outcome reads `completed` with no error while
 * `work` had really executed twice.
 *
 * The requirement the scenarios below hold is that leaving the region ends the
 * pass: one logical pass is one execution of each body block, and the Loop
 * retries only when the Branch hands control back to it.
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

function snapshotDefinition(path: string = SNAPSHOT.path): WorkflowDefinitionV2 {
  const raw = JSON.parse(
    readFileSync(new URL(`./snapshots/${path}`, import.meta.url), "utf8"),
  );
  return workflowDefinitionSchema.parse(raw) as WorkflowDefinitionV2;
}

function noValidationIssues(path: string): unknown[] {
  return validateWorkflowDefinitionIssuesForDeployment(
    snapshotDefinition(path),
    REGISTRY_CONTEXT,
    { checkEnvironmentAvailability: false },
  );
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

  it("runs the region once for one logical pass", async () => {
    // One pass through the graph is one execution of the agent block, in one
    // activation scope. `generic_agent` can hold a workspace open, commit, and
    // cost money, so an extra execution the user never authored is not
    // bookkeeping, and the clean outcome above would hide it. The Branch left
    // the region through `true`, so the Loop's retry never starts.
    const outcome = await scenarioFor("accept").execute();

    expect(
      executorRunsOf(outcome, "work").map((invocation) => ({
        attempt: invocation.attempt,
        activationScopeId: invocation.activationScopeId,
      })),
    ).toEqual([{ attempt: 1, activationScopeId: "root" }]);
    expect(portsOf(outcome, "gate")).toEqual(["true"]);
    // The control-level statement of the same requirement: the Loop leaves by no
    // port at all. It is recorded once, skipped, so it never selected `continue`
    // and never opened a second activation scope.
    expect(portsOf(outcome, "loop")).toEqual([undefined]);
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

/**
 * The same region, plus the most ordinary thing a customer adds to a block
 * inside a loop: a second edge out of the SAME port, to something outside the
 * region ("tell the reporter we started"). `work -> gate` keeps the pass inside
 * the region and `work -> notify` leaves it, on one port.
 *
 * That is not an exit, and reading it as one costs the customer their retries:
 * the Loop would be skipped on the first pass and `maxAttempts` would be
 * silently ignored, on a graph whose whole point is to retry. Control is only
 * leaving the region when the selected port does not continue to another member.
 * An edge back to the Loop node is not such a continuation, which is why
 * "terminates before an ordinary same-port body edge can return to Loop" in
 * v2-scheduler.test.ts still ends its loop.
 */
const SIDE_OUTPUT_SNAPSHOT = { path: "loop-region-side-output-v1.json" };

function sideOutputScenario(verdictAt: (attempt: number) => string) {
  const scenario = createScenario({
    snapshot: SIDE_OUTPUT_SNAPSHOT,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
  scenario.script({ nodeId: "seed" }, {
    kind: "next",
    output: { status: "completed", body: "First draft." },
  });
  scenario.script({ nodeId: "notify" }, {
    kind: "next",
    output: { status: "completed", body: "Progress posted." },
  });
  scenario.script({ nodeId: "work" }, (_node, _inputs, context) => {
    const verdict = verdictAt(context.attempt);
    return {
      kind: "next",
      output: { status: "completed", verdict, data: { verdict } },
    };
  });
  return scenario;
}

describe("loop region with a side output on the same port", () => {
  it("deploys with no validation issues", () => {
    expect(noValidationIssues(SIDE_OUTPUT_SNAPSHOT.path)).toEqual([]);
  });

  it("keeps every Loop attempt when a member fans out past the region", async () => {
    const outcome = await sideOutputScenario(() => "reject").execute();

    // Identical arithmetic to the reject case above: the side output changes
    // nothing about how many attempts the customer bought.
    expect(executorRunsOf(outcome, "work")).toHaveLength(4);
    expect(portsOf(outcome, "loop")).toEqual([
      "exhausted",
      "continue",
      "continue",
      undefined,
    ]);
    expect(outcome.result.outcome).toBe("failed");
    expect(executorRunsOf(outcome, "giveup")).toHaveLength(1);
    expectNeverInvoked(outcome, ["done"]);
  });

  it("leaves through the exit a retry selects, with the side branch resolved", async () => {
    // The exit arrives on a later pass, so the boundary is resolved twice over
    // the run: once by `work` for its own side branch, once by the Loop when the
    // Branch finally leaves. Both writes have to stand, or the run fails with
    // "resolved more than once" (AIW-228) on a graph the editor accepts.
    const outcome = await sideOutputScenario((attempt) =>
      attempt >= 2 ? "accept" : "reject",
    ).execute();

    expect(outcome.result.executionError).toBeUndefined();
    expect(executorRunsOf(outcome, "work")).toHaveLength(2);
    expect(portsOf(outcome, "gate")).toEqual(["false", "true"]);
    expectNeverInvoked(outcome, ["giveup"]);
  });

  it("runs the side branch once per pass that reaches it", async () => {
    // `notify` sits outside the region, so only the externally entered pass can
    // reach it: retries run in an activation that does not contain it. Pinned
    // because it is the boundary's other half, not because it is desirable.
    const outcome = await sideOutputScenario(() => "reject").execute();

    expect(executorRunsOf(outcome, "notify")).toHaveLength(1);
  });
});

/**
 * Two members of one region, each with its own exit. One logical pass can select
 * both, and both are authored, so both have to run.
 *
 * The region is `{loop, workA, gateA, workB, gateB}`: every arm returns to the
 * Loop, so the strongly connected component spans them all, and `seed` enters
 * two of them from outside. Resolving the whole boundary on the first exit made
 * the second one a contradiction (`edge "..." resolved more than once`, a failed
 * run) in the initial activation, and made it disappear inside a retry, where
 * the Loop had already ended and the second exit was dropped with the run still
 * reporting success.
 */
const TWO_EXITS_SNAPSHOT = { path: "loop-two-region-exits-v1.json" };

function twoExitsScenario(verdictAt: (attempt: number) => string) {
  const scenario = createScenario({
    snapshot: TWO_EXITS_SNAPSHOT,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
  scenario.script({ nodeId: "seed" }, {
    kind: "next",
    output: { status: "completed", body: "First draft." },
  });
  for (const nodeId of ["workA", "workB"]) {
    scenario.script({ nodeId }, (_node, _inputs, context) => {
      const verdict = verdictAt(context.attempt);
      return {
        kind: "next",
        output: { status: "completed", verdict, data: { verdict } },
      };
    });
  }
  for (const nodeId of ["doneA", "doneB"]) {
    scenario.script({ nodeId }, {
      kind: "next",
      output: { status: "completed", body: "Published." },
    });
  }
  return scenario;
}

describe("loop region with two member exits", () => {
  it("deploys with no validation issues", () => {
    expect(noValidationIssues(TWO_EXITS_SNAPSHOT.path)).toEqual([]);
  });

  it("resolves the Loop only after every member of its region", async () => {
    // The invariant the initial activation's correctness rests on, and the only
    // reason the test below cannot crash: the Loop settles the region's boundary
    // when it is skipped, so if it were skipped while `gateB` still had `true` to
    // select, that exit would be frozen inactive (silently skipped) or crash the
    // run on the contradicting write. It cannot be, because the region is a
    // strongly connected component: `gateB -> loop` resolves only after `gateB`,
    // and the Loop waits on all of its incoming edges.
    //
    // Nothing about this is local to the scheduler's loop code, which is why it
    // is pinned here as well as asserted in `assertRegionDecidedBeforeLoop`:
    // admitting only part of a region into a scope, by widening
    // `hasExternalBodyEntry` or `allowedNodeIds`, would break it from a distance.
    const outcome = await twoExitsScenario(() => "accept").execute();

    const [loopRecord] = outcome.invocationsOf("loop");
    expect(loopRecord).toBeDefined();
    for (const memberId of ["workA", "workB", "gateA", "gateB"]) {
      const [memberRecord] = outcome.invocationsOf(memberId);
      expect(memberRecord).toBeDefined();
      expectStartsAfterFinishOf(loopRecord!, memberRecord!);
    }
  });

  it("runs both exits one pass selects in the initial activation", async () => {
    const outcome = await twoExitsScenario(() => "accept").execute();

    expect(outcome.result.executionError).toBeUndefined();
    expect(outcome.result.outcome).toBe("completed");
    expect(executorRunsOf(outcome, "doneA")).toHaveLength(1);
    expect(executorRunsOf(outcome, "doneB")).toHaveLength(1);
    expectNeverInvoked(outcome, ["giveup"]);
  });

  it("runs both exits one pass selects inside a retry", async () => {
    const outcome = await twoExitsScenario((attempt) =>
      attempt >= 2 ? "accept" : "reject",
    ).execute();

    expect(outcome.result.executionError).toBeUndefined();
    expect(outcome.result.outcome).toBe("completed");
    expect(executorRunsOf(outcome, "workA")).toHaveLength(2);
    expect(executorRunsOf(outcome, "workB")).toHaveLength(2);
    expect(executorRunsOf(outcome, "doneA")).toHaveLength(1);
    expect(executorRunsOf(outcome, "doneB")).toHaveLength(1);
    expectNeverInvoked(outcome, ["giveup"]);
  });
});
