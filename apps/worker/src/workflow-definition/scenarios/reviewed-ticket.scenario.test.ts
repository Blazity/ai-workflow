import { describe, expect, it } from "vitest";
import type { BlockOutput } from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { executionError } from "../interpreter.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  expectStartsAfterFinishOf,
  portsOf,
} from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The reviewed ticket workflow as an executable specification.
 *
 * Every scenario runs the shipped `reviewed-ticket-workflow` template through
 * the production v2 scheduler, so the review fan-out, the join, the Branch
 * combinator, the Loop attempt counter and the Terminate dispatch are the real
 * ones. Only the agent blocks are scripted.
 *
 * KNOWN ENGINE DEFECT, and the reason every scenario below approves from the
 * SECOND pass onwards: when all three reviews approve while the run is still in
 * the "root" scope, the scheduler fails the Branch with `edge
 * "...reviews-approved-true-checks" resolved more than once in scope "root"`.
 * Selecting "true" marks that Loop boundary edge active, skipping the Loop then
 * re-resolves every boundary edge of the same region to inactive, and
 * `setEdgeToken` rejects the second resolution. Approving from the second pass
 * on is unaffected, because the exit is then taken from a Loop iteration scope.
 * The scenarios therefore prove the fan-out, the join and the retry semantics
 * across passes that the engine can actually run today.
 *
 * That defect is pinned by "fails when every review approves on the first
 * pass", which is a lock rather than a specification: it goes red the day the
 * engine is fixed, and going red is the instruction to delete it and restore
 * the reshaped scenarios. TODO(ticket).
 */

const TICKET_TEMPLATE = {
  id: "reviewed-ticket-workflow",
  options: { includeReview: true, provider: "claude" as const },
};

/** Declaration order, which is also the order the Loop carries them into Fix. */
const REVIEWS = [
  "security-review",
  "quality-review",
  "requirements-review",
] as const;

/** Everything downstream of an approving join. */
const PUBLICATION = ["checks", "finalize", "open-pr", "status"];

/** Everything downstream of an exhausted Loop. */
const EXHAUSTION = ["exhausted-message", "exhausted-failure"];

/** The Loop spawns one activation scope per attempt, named after the Loop. */
const LOOP_SCOPES = [
  "root/loop:retry:1",
  "root/loop:retry:2",
  "root/loop:retry:3",
];

/** The template's own copy for the exhaustion notice. Asserted verbatim so a
 * silent rewording of the shipped message fails a scenario. */
const EXHAUSTION_MESSAGE =
  "The workflow could not resolve all review findings after three fix attempts.";

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-198",
  ticketKey: "AIW-198",
  ownerToken: "owner-1",
};

const TICKET_CONTEXT = {
  identifier: "AIW-198",
  title: "Reviewed ticket scenarios",
  description: "Cover the reviewed ticket workflow with scenarios.",
  acceptanceCriteria: "Scenarios drive the production scheduler.",
  labels: ["ai"],
  comments: [],
};

function ticketScenario(): Scenario {
  return createScenario({
    template: TICKET_TEMPLATE,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
}

function reviewOutput(
  nodeId: string,
  decision: "approve" | "request_changes",
  pass: number,
): BlockOutput {
  return {
    status: "reviewed",
    decision,
    feedback: `${nodeId} pass ${pass}`,
    findings:
      decision === "approve"
        ? []
        : [
            {
              file: `${nodeId}.ts`,
              description: `Finding from pass ${pass}.`,
              // "Blocker" and "High" are the severities that hold a review
              // back; the optional line span rides along so the carry is
              // asserted against a whole finding, not a trimmed one.
              severity: "Blocker",
              startLine: 10,
              endLine: 12,
            },
          ],
  };
}

/**
 * Approves from `approveFrom` onwards, so the run leaves the retry Loop on a
 * pass the engine can exit from.
 *
 * This is the knob the engine defect forced. TODO(ticket): once the scheduler
 * can leave the region from the "root" scope, delete "locks the engine defect
 * that breaks first-pass approval" below and set the two scenarios that pass
 * `reviewsApprovingFrom(2)` back to `reviewsApprovingFrom(1)`, each then
 * expecting a single "true" port from `reviews-approved` and no Fix run.
 */
function reviewsApprovingFrom(
  approveFrom: number,
): (nodeId: string, attempt: number) => BlockOutput {
  return (nodeId, attempt) =>
    reviewOutput(
      nodeId,
      attempt >= approveFrom ? "approve" : "request_changes",
      attempt,
    );
}

function fixOutput(summary: string): BlockOutput {
  return {
    status: "fixed",
    workspaceId: "sbx-scenario",
    commits: [],
    resolvedConflicts: [],
    unresolvedConflicts: [],
    summary,
  };
}

/** Everything the template needs before its review fan-out. */
function scriptPrelude(scenario: Scenario): void {
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: {
      status: "ok",
      sandboxId: "sbx-scenario",
      repositories: ["github:acme/app"],
      workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
    },
  });
  scenario.script({ nodeId: "planning" }, {
    kind: "next",
    output: { status: "ready", plan: "Implement the ticket." },
  });
  scenario.script({ nodeId: "implementation" }, {
    kind: "next",
    output: {
      status: "implemented",
      workspaceId: "sbx-scenario",
      branches: [],
      commits: [],
      summary: "Implemented.",
    },
  });
}

function scriptFix(scenario: Scenario): void {
  scenario.script({ nodeId: "fix" }, {
    kind: "next",
    output: fixOutput("Fixed."),
  });
}

/** Everything the template needs after an approving join. */
function scriptPublication(scenario: Scenario): void {
  scenario.script({ nodeId: "checks" }, {
    kind: "next",
    output: {
      status: "ok",
      ok: true,
      outcome: "passed",
      fixCycles: 0,
      summary: "Checks passed.",
    },
  });
  scenario.script({ nodeId: "finalize" }, {
    kind: "next",
    output: {
      status: "finalized",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: "ai-workflow/AIW-198",
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
          branch: "ai-workflow/AIW-198",
          isNew: true,
        },
      ],
      prUrl: "https://github.test/acme/app/pull/1",
      prNumber: 1,
    },
  });
  scenario.script({ nodeId: "status" }, {
    kind: "next",
    output: { status: "ok", target: "ai_review" },
  });
}

describe("reviewed ticket workflow: the review fan-out", () => {
  it("starts all three reviews before any of them can finish", async () => {
    const scenario = ticketScenario();
    // Structural proof of concurrency: every review is held inside the executor
    // until all three have arrived, so none of them can have finished before
    // the last one started. The gate re-arms per pass, so this holds for the
    // fan-out out of Implementation and for the fan-out out of Fix alike.
    scenario.barrier([...REVIEWS]);
    const review = reviewsApprovingFrom(2);
    scriptPrelude(scenario);
    for (const nodeId of REVIEWS) {
      scenario.script({ nodeId }, (_node, _inputs, context) => ({
        kind: "next",
        output: review(nodeId, context.attempt),
      }));
    }
    scriptFix(scenario);
    scriptPublication(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const implementation = executorRunsOf(outcome, "implementation");
    expect(implementation).toHaveLength(1);
    const fix = executorRunsOf(outcome, "fix");
    expect(fix).toHaveLength(1);
    for (const nodeId of REVIEWS) {
      const runs = executorRunsOf(outcome, nodeId);
      expect(runs.map((invocation) => invocation.attempt)).toEqual([1, 2]);
      expectStartsAfterFinishOf(runs[0], implementation[0]);
      // The second fan-out belongs to Fix, not to Implementation, so the gate
      // really did re-arm behind the Loop rather than replaying one round.
      expectStartsAfterFinishOf(runs[1], fix[0]);
    }
    expect(portsOf(outcome, "reviews-approved")).toEqual(["false", "true"]);
    expectNeverInvoked(outcome, EXHAUSTION);
  });

  /**
   * REGRESSION LOCK for the engine defect described at the top of this file,
   * not a statement of intended behaviour. The shipped happy path, all three
   * reviews approving on the first pass, cannot run today.
   *
   * WHEN THIS TEST GOES RED THE DEFECT IS FIXED. That is the signal to delete
   * this test and restore the two scenarios above and below it: see
   * `reviewsApprovingFrom`. TODO(ticket).
   */
  it("fails when every review approves on the first pass", async () => {
    const scenario = ticketScenario();
    scriptPrelude(scenario);
    for (const nodeId of REVIEWS) {
      scenario.script({ nodeId }, {
        kind: "next",
        output: reviewOutput(nodeId, "approve", 1),
      });
    }
    // No Fix or publication scripts on purpose: the run dies at the Branch, so
    // scripting them would trip the harness's unused-script check first and
    // mask the failure this test exists to pin.

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toEqual({
      nodeId: "reviews-approved",
      attempt: 1,
      category: "engine",
      phase: "branch",
      message: "The workflow engine could not continue.",
      diagnosticId: "AIW-DIAG-test-run-reviews-approved-1",
    });
    expectNeverInvoked(outcome, ["fix", ...PUBLICATION, ...EXHAUSTION]);
  });

  it.each([
    [["security-review", "quality-review", "requirements-review"]],
    [["security-review", "requirements-review", "quality-review"]],
    [["quality-review", "security-review", "requirements-review"]],
    [["quality-review", "requirements-review", "security-review"]],
    [["requirements-review", "security-review", "quality-review"]],
    [["requirements-review", "quality-review", "security-review"]],
  ])("joins all three reviews when they finish %j", async (releaseOrder) => {
    const scenario = ticketScenario();
    const review = reviewsApprovingFrom(2);
    scriptPrelude(scenario);
    // Completion order is the permutation, on every pass. The join must not
    // depend on it.
    scenario.releaseInOrder(releaseOrder, (nodeId, context) => ({
      kind: "next",
      output: review(nodeId, context.attempt),
    }));
    scriptFix(scenario);
    scriptPublication(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const join = outcome.invocationsOf("reviews-approved");
    // One evaluation per pass, and never before the whole fan-out has landed.
    expect(join.map((invocation) => invocation.selectedTransition?.port)).toEqual(
      ["false", "true"],
    );
    for (const [pass, evaluation] of join.entries()) {
      for (const nodeId of REVIEWS) {
        const runs = executorRunsOf(outcome, nodeId);
        expect(runs).toHaveLength(2);
        expectStartsAfterFinishOf(evaluation, runs[pass]);
      }
    }
    expectNeverInvoked(outcome, EXHAUSTION);
  });
});

describe("reviewed ticket workflow: requesting changes", () => {
  it("takes the false port and the Loop's continue port when one review dissents", async () => {
    const scenario = ticketScenario();
    scriptPrelude(scenario);
    // The Branch combines its three conditions with "all", so one dissenting
    // review is enough to select Fix. Security dissents on the first two
    // passes; the other two approve throughout.
    scenario.script(
      { nodeId: "security-review" },
      (_node, _inputs, context) => ({
        kind: "next",
        output: reviewOutput(
          "security-review",
          context.attempt === 3 ? "approve" : "request_changes",
          context.attempt,
        ),
      }),
    );
    for (const nodeId of ["quality-review", "requirements-review"]) {
      scenario.script({ nodeId }, (_node, _inputs, context) => ({
        kind: "next",
        output: reviewOutput(nodeId, "approve", context.attempt),
      }));
    }
    scriptFix(scenario);
    scriptPublication(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    expect(portsOf(outcome, "reviews-approved")).toEqual([
      "false",
      "false",
      "true",
    ]);
    // The Loop re-enters Fix through its own "continue" port. Its owning
    // invocation in "root" reports the boundary edge the region finally left
    // by, which is why the continue port is looked up rather than indexed.
    const continued = outcome
      .invocationsOf("retry")
      .filter(
        (invocation) => invocation.selectedTransition?.port === "continue",
      );
    expect(
      continued.map((invocation) => ({
        attempt: invocation.attempt,
        activationScopeId: invocation.activationScopeId,
      })),
    ).toEqual([{ attempt: 2, activationScopeId: LOOP_SCOPES[0] }]);
    expect(executorRunsOf(outcome, "fix")).toHaveLength(2);
    expectNeverInvoked(outcome, EXHAUSTION);
  });

  it("hands Fix the whole review outputs of the pass that rejected", async () => {
    const scenario = ticketScenario();
    const review = reviewsApprovingFrom(4);
    scriptPrelude(scenario);
    // Released back to front, so the order Fix sees can only come from the
    // declared reference list, never from completion order.
    scenario.releaseInOrder([...REVIEWS].reverse(), (nodeId, context) => ({
      kind: "next",
      output: review(nodeId, context.attempt),
    }));
    scriptFix(scenario);
    scriptPublication(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const fixRuns = executorRunsOf(outcome, "fix");
    expect(fixRuns).toHaveLength(3);
    for (const [index, run] of fixRuns.entries()) {
      const pass = index + 1;
      // Whole objects and the whole input record: every field of every review
      // crosses the Loop carry unchanged, in declaration order, and Fix
      // receives nothing else.
      expect(run.resolvedInputs).toEqual({
        reviewResults: REVIEWS.map((nodeId) =>
          reviewOutput(nodeId, "request_changes", pass),
        ),
      });
    }
    expectNeverInvoked(outcome, EXHAUSTION);
  });

  it("runs four review passes and then publishes", async () => {
    const scenario = ticketScenario();
    const review = reviewsApprovingFrom(4);
    scriptPrelude(scenario);
    // A held join whose members vary per Loop attempt: released back to front
    // on every pass, approving only on the fourth.
    scenario.releaseInOrder([...REVIEWS].reverse(), (nodeId, context) => ({
      kind: "next",
      output: review(nodeId, context.attempt),
    }));
    scriptFix(scenario);
    scriptPublication(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    for (const nodeId of REVIEWS) {
      expect(
        executorRunsOf(outcome, nodeId).map((invocation) => invocation.attempt),
      ).toEqual([1, 2, 3, 4]);
    }
    const join = outcome.invocationsOf("reviews-approved");
    expect(join.map((invocation) => invocation.selectedTransition?.port)).toEqual(
      ["false", "false", "false", "true"],
    );
    for (const [pass, evaluation] of join.entries()) {
      for (const nodeId of REVIEWS) {
        expectStartsAfterFinishOf(
          evaluation,
          executorRunsOf(outcome, nodeId)[pass],
        );
      }
    }
    // Four records behind three runs, and the extra one is NOT an unlaunched
    // fourth attempt: there is no such thing here. "fix" is a Loop-region
    // member, so the enclosing "root" scope resolves and skips it as soon as
    // "retry --continue--> fix" goes inactive there, which happens before the
    // trigger's own record exists. The three real runs are attempts 2, 3 and 4,
    // one per Loop iteration scope. Pinned as records rather than described,
    // so the trap cannot quietly change shape.
    expect(
      outcome.invocationsOf("fix").map((invocation) => ({
        attempt: invocation.attempt,
        activationScopeId: invocation.activationScopeId,
        enteredExecutor: invocation.enteredExecutor,
        skipped: invocation.skipped,
      })),
    ).toEqual([
      {
        attempt: 1,
        activationScopeId: "root",
        enteredExecutor: false,
        skipped: true,
      },
      {
        attempt: 2,
        activationScopeId: LOOP_SCOPES[0],
        enteredExecutor: true,
        skipped: undefined,
      },
      {
        attempt: 3,
        activationScopeId: LOOP_SCOPES[1],
        enteredExecutor: true,
        skipped: undefined,
      },
      {
        attempt: 4,
        activationScopeId: LOOP_SCOPES[2],
        enteredExecutor: true,
        skipped: undefined,
      },
    ]);
    expect(executorRunsOf(outcome, "fix")).toHaveLength(3);
    for (const nodeId of PUBLICATION) {
      expect(executorRunsOf(outcome, nodeId)).toHaveLength(1);
    }
    expectNeverInvoked(outcome, EXHAUSTION);
  });
});

describe("reviewed ticket workflow: exhausting the retries", () => {
  it("reports the exhaustion and fails the run through Terminate", async () => {
    const scenario = ticketScenario();
    let announced: unknown;
    scriptPrelude(scenario);
    for (const nodeId of REVIEWS) {
      scenario.script({ nodeId }, (_node, _inputs, context) => ({
        kind: "next",
        output: reviewOutput(nodeId, "request_changes", context.attempt),
      }));
    }
    scriptFix(scenario);
    // Read off the node the scheduler actually dispatched, so the assertion
    // covers the message the shipped template carries.
    scenario.script({ nodeId: "exhausted-message" }, (node) => {
      announced = node.configuration.message;
      return { kind: "next", output: { status: "ok" } };
    });

    const outcome = await scenario.execute();

    expect(announced).toBe(EXHAUSTION_MESSAGE);
    for (const nodeId of REVIEWS) {
      expect(
        executorRunsOf(outcome, nodeId).map((invocation) => invocation.attempt),
      ).toEqual([1, 2, 3, 4]);
    }
    expect(executorRunsOf(outcome, "fix")).toHaveLength(3);
    // The owning invocation in "root" leaves the region through "exhausted"
    // after the third iteration re-entered Fix twice through "continue". The
    // fourth record is the iteration invocation the Loop no longer launches.
    expect(
      outcome.invocationsOf("retry").map((invocation) => ({
        attempt: invocation.attempt,
        activationScopeId: invocation.activationScopeId,
        port: invocation.selectedTransition?.port,
      })),
    ).toEqual([
      { attempt: 1, activationScopeId: "root", port: "exhausted" },
      { attempt: 2, activationScopeId: LOOP_SCOPES[0], port: "continue" },
      { attempt: 3, activationScopeId: LOOP_SCOPES[1], port: "continue" },
      { attempt: 4, activationScopeId: LOOP_SCOPES[2], port: undefined },
    ]);
    // Terminate is never scripted: the harness replays the production
    // dispatcher, so the failure below is the product's own.
    const terminate = executorRunsOf(outcome, "exhausted-failure");
    expect(terminate).toHaveLength(1);
    expect(terminate[0].runtimeState).toBe("failed");
    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toEqual({
      nodeId: "exhausted-failure",
      attempt: 1,
      category: "engine",
      phase: "terminate",
      message:
        "The workflow engine could not continue. (Terminated by workflow.)",
      diagnosticId: "AIW-DIAG-test-run-exhausted-failure-1",
    });
    expectNeverInvoked(outcome, PUBLICATION);
  });
});

describe("reviewed ticket workflow: a failing review", () => {
  it("fails the run instead of treating a technical failure as request_changes", async () => {
    const scenario = ticketScenario();
    scriptPrelude(scenario);
    // Held together so all three reviews really run, and only then does one of
    // them fail for a reason that is not a review verdict at all.
    scenario.barrier([...REVIEWS]);
    scenario.script(
      { nodeId: "security-review" },
      executionError("The review sandbox crashed.", {
        category: "sandbox",
        phase: "agent",
      }),
    );
    for (const nodeId of ["quality-review", "requirements-review"]) {
      scenario.script({ nodeId }, {
        kind: "next",
        output: reviewOutput(nodeId, "approve", 1),
      });
    }

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toEqual({
      nodeId: "security-review",
      attempt: 1,
      category: "sandbox",
      phase: "agent",
      message:
        "The workspace environment could not complete this block. (The review sandbox crashed.)",
      diagnosticId: "AIW-DIAG-test-run-security-review-1",
    });
    // A control node leaves a record whenever it runs, and there is none: the
    // Branch was never evaluated, so no review verdict was inferred from a
    // technical failure.
    expect(outcome.invocationsOf("reviews-approved")).toEqual([]);
    expect(outcome.invocationsOf("retry")).toEqual([]);
    expectNeverInvoked(outcome, ["fix", ...PUBLICATION, ...EXHAUSTION]);
  });

  it("cancels the sibling reviews still running when one of them fails", async () => {
    const scenario = ticketScenario();
    scriptPrelude(scenario);
    const held = ["quality-review", "requirements-review"];
    // "checks" runs far downstream of the reviews and can never join this
    // group, so the two held reviews can only be freed by the cancellation the
    // failing sibling triggers.
    scenario.barrier([...held, "checks"]);
    for (const nodeId of held) {
      scenario.script({ nodeId }, {
        kind: "next",
        output: reviewOutput(nodeId, "approve", 1),
      });
    }
    scenario.script(
      { nodeId: "security-review" },
      executionError("The review sandbox crashed.", {
        category: "sandbox",
        phase: "agent",
      }),
    );

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    for (const nodeId of held) {
      const runs = executorRunsOf(outcome, nodeId);
      expect(runs).toHaveLength(1);
      expect(runs[0].runtimeState).toBe("cancelled");
    }
    // One failure, not one per sibling: the run keeps its primary failure.
    expect(
      outcome.invocations
        .filter((invocation) => invocation.runtimeState === "failed")
        .map((invocation) => invocation.nodeId),
    ).toEqual(["security-review"]);
    expect(outcome.result.executionError?.nodeId).toBe("security-review");
    expect(outcome.invocationsOf("reviews-approved")).toEqual([]);
    expectNeverInvoked(outcome, ["fix", ...PUBLICATION, ...EXHAUSTION]);
  });
});

describe("reviewed ticket workflow: attempt and scope keying", () => {
  it("serves an attempt-keyed and a scope-keyed script exactly once", async () => {
    const scenario = ticketScenario();
    const review = reviewsApprovingFrom(4);
    scriptPrelude(scenario);
    for (const nodeId of REVIEWS) {
      scenario.script({ nodeId }, (_node, _inputs, context) => ({
        kind: "next",
        output: review(nodeId, context.attempt),
      }));
    }
    // Beats the node-wide script above, for the second pass only.
    scenario.script({ nodeId: "security-review", attempt: 2 }, {
      kind: "next",
      output: reviewOutput("security-review", "request_changes", 99),
    });
    scriptFix(scenario);
    // Beats the node-wide script above, inside the second Loop attempt only.
    scenario.script({ nodeId: "fix", activationScopeId: LOOP_SCOPES[1] }, {
      kind: "next",
      output: fixOutput("Fixed in the second attempt."),
    });
    scriptPublication(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    expect(
      executorRunsOf(outcome, "security-review").map(
        (invocation) => invocation.result,
      ),
    ).toEqual([
      {
        kind: "next",
        output: reviewOutput("security-review", "request_changes", 1),
      },
      {
        kind: "next",
        output: reviewOutput("security-review", "request_changes", 99),
      },
      {
        kind: "next",
        output: reviewOutput("security-review", "request_changes", 3),
      },
      { kind: "next", output: reviewOutput("security-review", "approve", 4) },
    ]);
    const fixRuns = executorRunsOf(outcome, "fix");
    expect(fixRuns.map((invocation) => invocation.activationScopeId)).toEqual(
      LOOP_SCOPES,
    );
    expect(fixRuns.map((invocation) => invocation.result)).toEqual([
      { kind: "next", output: fixOutput("Fixed.") },
      { kind: "next", output: fixOutput("Fixed in the second attempt.") },
      { kind: "next", output: fixOutput("Fixed.") },
    ]);
    expectNeverInvoked(outcome, EXHAUSTION);
  });

  it("fails a script keyed to an attempt the run never reaches", async () => {
    const scenario = ticketScenario();
    const review = reviewsApprovingFrom(2);
    scriptPrelude(scenario);
    for (const nodeId of REVIEWS) {
      scenario.script({ nodeId }, (_node, _inputs, context) => ({
        kind: "next",
        output: review(nodeId, context.attempt),
      }));
    }
    scriptFix(scenario);
    scriptPublication(scenario);
    // The reviews approve on the second pass, so a third one never happens.
    scenario.script({ nodeId: "security-review", attempt: 3 }, {
      kind: "next",
      output: reviewOutput("security-review", "request_changes", 3),
    });

    // The violation is the whole outcome here: a scenario that scripts a pass
    // the run never makes must fail rather than quietly pass.
    await expect(scenario.execute()).rejects.toThrow(
      /scripted outcomes that never ran: node "security-review", attempt 3/,
    );
    expect(
      scenario.invocations
        .filter(
          (invocation) =>
            invocation.enteredExecutor &&
            invocation.nodeId === "security-review",
        )
        .map((invocation) => invocation.attempt),
    ).toEqual([1, 2]);
  });
});
