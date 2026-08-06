import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  JsonValue,
  ReviewResult,
  ReviewResultFinding,
} from "@shared/contracts";
import type { PrTriggerType } from "../../lib/trigger-events.js";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { buildReviewAgentSuccessOutput } from "../../workflows/agent.js";
import {
  partitionReviewFindings,
  reviewPublicationDecision,
} from "../../workflows/pr-external-resources.js";
import { executionError } from "../interpreter.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  expectStartsAfterFinishOf,
  portsOf,
} from "./assertions.js";
import {
  createScenario,
  type Scenario,
  type ScenarioOutcome,
} from "./harness.js";

/**
 * The shipped post-PR review workflow as an executable specification. This is
 * the template a client receives, so every scenario runs the real graph through
 * the production v2 scheduler: the two triggers, the review fan-out, the join
 * into Post PR review, the Branch and both check completions are the product's
 * own. Only action blocks are scripted.
 *
 * VERDICTS ARE NEVER STATED BY A SCENARIO. A scenario supplies findings and
 * asserts the verdict, never the other way round, because both verdict rules
 * come from production: `buildReviewAgentSuccessOutput` derives a review's
 * decision from the severities of its findings, and the Post PR review script
 * reproduces the one rule `publishRunOwnedPrReview` applies over the results it
 * is handed. Nothing else about that block is reproduced; see `scriptPostReview`.
 *
 * There is no Loop in this graph, so every block runs at most once, on attempt
 * 1, in the single "root" activation scope.
 */

const TEMPLATE = {
  id: "post-pr-review",
  options: { includeReview: true, provider: "claude" as const },
};

/** The committed copy of a deployed definition, so at least one scenario runs
 * the JSON a client actually has rather than the template that generated it. */
const SNAPSHOT = { path: "post-pr-review-v1.json" };

/** Declaration order, which is the order the reference list must hand to Post
 * PR review. */
const REVIEWS = [
  "security-review",
  "quality-review",
  "requirements-review",
] as const;

const COMPLETIONS = ["complete-success", "complete-failure"];

/** The handle Create PR check publishes. Every completion addresses the check
 * by this value, so it is the one piece of data that must cross the graph
 * unchanged. */
const CHECK_REF = {
  id: "check-1",
  headSha: "abc123",
  name: "AI Workflow / Review",
};

const APPROVED_SUMMARY = "Every review approved this commit.";
const REQUEST_CHANGES_SUMMARY = "One blocking finding must be resolved.";

function prEntry(triggerType: PrTriggerType): AgentWorkflowInput {
  return {
    kind: "pr_trigger",
    triggerType,
    subjectKey: "pr:github:acme/app#7",
    ownerToken: "owner-1",
    definitionId: 1,
    definitionVersion: 1,
    scope: "any",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 7,
      prUrl: "https://github.test/acme/app/pull/7",
      headRef: "feature",
      headSha: "abc123",
      baseRef: "main",
      title: "Add scenarios",
      author: "contributor",
      isDraft: false,
    },
  };
}

function templateScenario(
  triggerType: PrTriggerType,
  entryTriggerId: string,
): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: prEntry(triggerType),
    entryTriggerId,
  });
}

function snapshotScenario(
  triggerType: PrTriggerType,
  entryTriggerId: string,
): Scenario {
  return createScenario({
    snapshot: SNAPSHOT,
    entry: prEntry(triggerType),
    entryTriggerId,
  });
}

/** How a trigger node appears in the record, which is what tells "did not fire"
 * apart from "is not in the graph". */
function triggerRecordsOf(
  outcome: ScenarioOutcome,
  nodeId: string,
): unknown[] {
  return outcome.invocationsOf(nodeId).map((invocation) => ({
    attempt: invocation.attempt,
    activationScopeId: invocation.activationScopeId,
    enteredExecutor: invocation.enteredExecutor,
    skipped: invocation.skipped,
  }));
}

/**
 * A review output exactly as the product builds one. The decision is
 * deliberately not stated by the caller: it comes from the production builder,
 * so a scenario cannot claim a verdict the shipped severity rule would not
 * reach.
 */
function reviewOutputFor(
  nodeId: string,
  findings: readonly ReviewResultFinding[],
): BlockOutput {
  return buildReviewAgentSuccessOutput({
    feedback: `${nodeId} reviewed the head commit.`,
    issues: findings.map((finding) => ({ ...finding })),
  });
}

function reviewFeedbackOf(nodeId: string): string {
  return `${nodeId} reviewed the head commit.`;
}

/** Everything the graph needs before its review fan-out. */
function scriptPrelude(scenario: Scenario): void {
  scenario.script({ nodeId: "create-check" }, {
    kind: "next",
    output: { status: "ok", check: CHECK_REF },
  });
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: {
      status: "ok",
      sandboxId: "sbx-scenario",
      repositories: ["github:acme/app"],
      workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
    },
  });
}

function scriptReviews(
  scenario: Scenario,
  outputs: readonly BlockOutput[],
): void {
  REVIEWS.forEach((nodeId, index) => {
    scenario.script({ nodeId }, { kind: "next", output: outputs[index] });
  });
}

/**
 * Post PR review. ONLY the verdict follows production, and it is not reproduced
 * here at all: `reviewPublicationDecision` IS the function
 * `publishRunOwnedPrReview` calls, over the clusters `partitionReviewFindings`
 * builds out of the resolved inputs. A rule change in production therefore
 * reaches these scenarios instead of leaving them green against a graph that no
 * longer behaves this way. The decision is computed from the resolved inputs
 * rather than fixed per scenario, so what the Branch reads follows the findings
 * the reviews actually reported.
 *
 * The empty file list is the single difference from the production call. That
 * list decides only whether a finding can be anchored to the diff; the
 * clustering the verdict reads is a pure function of the findings themselves.
 *
 * The two counts are contract filler, not aggregation. The block contract
 * requires them, and no edge in this graph binds either one. Production derives
 * them from the same partition, which splits findings by whether they could be
 * placed on the diff; that split needs the provider's file list and is not
 * reproduced here.
 */
function scriptPostReview(scenario: Scenario): void {
  scenario.script({ nodeId: "post-review" }, (_node, inputs) => {
    const results = inputs.reviewResults as ReviewResult[];
    const decision = reviewPublicationDecision(
      partitionReviewFindings(results, []).merged,
      results.length,
    );
    return {
      kind: "next",
      output: {
        status: "ok",
        decision,
        summary:
          decision === "approve" ? APPROVED_SUMMARY : REQUEST_CHANGES_SUMMARY,
        inlineCommentCount: results.reduce(
          (total, result) => total + result.findings.length,
          0,
        ),
        summaryFallbackCount: 0,
      },
    };
  });
}

interface CompletionConfiguration {
  conclusion?: JsonValue;
  details?: JsonValue;
}

/**
 * Scripts a completion block and reports back the configuration the graph
 * dispatched, so a scenario asserts the conclusion the template carries instead
 * of the one it wished for. The output is built from the resolved inputs, as
 * production does, so the check the block reports is the check it was handed.
 */
function scriptCompletion(
  scenario: Scenario,
  nodeId: string,
): CompletionConfiguration {
  const configured: CompletionConfiguration = {};
  scenario.script({ nodeId }, (node, inputs) => {
    configured.conclusion = node.configuration.conclusion;
    configured.details = node.configuration.details;
    return {
      kind: "next",
      output: {
        status: "ok",
        check: inputs.check as JsonValue,
        conclusion: node.configuration.conclusion,
      },
    };
  });
  return configured;
}

/**
 * Asserts that the check handle reached a completion block exactly as Create PR
 * check emitted it. Deep equality alone is not the claim: the provider call is
 * addressed by this object, so a re-keyed or re-serialized copy would complete
 * a different check, or none. The serialized forms are compared as well, which
 * also pins key order.
 */
function expectCheckPassedThrough(
  outcome: ScenarioOutcome,
  completionNodeId: string,
): void {
  const created = executorRunsOf(outcome, "create-check");
  expect(created).toHaveLength(1);
  const createdResult = created[0].result;
  expect(createdResult?.kind).toBe("next");
  const emitted =
    createdResult?.kind === "next" ? createdResult.output.check : null;
  const completion = executorRunsOf(outcome, completionNodeId);
  expect(completion).toHaveLength(1);
  const carried = completion[0].resolvedInputs?.check;
  expect(carried).toEqual(emitted);
  expect(JSON.stringify(carried)).toBe(JSON.stringify(emitted));
}

describe("post-PR review workflow: an approving review", () => {
  it("runs the three reviews together and passes the check", async () => {
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    // Structural proof of concurrency: every review is held inside the executor
    // until all three have arrived, so none of them can have finished before
    // the last one started.
    scenario.barrier([...REVIEWS]);
    scriptPrelude(scenario);
    scriptReviews(
      scenario,
      REVIEWS.map((nodeId) => reviewOutputFor(nodeId, [])),
    );
    scriptPostReview(scenario);
    const completion = scriptCompletion(scenario, "complete-success");

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const createCheck = executorRunsOf(outcome, "create-check");
    expect(createCheck).toHaveLength(1);
    const prepare = executorRunsOf(outcome, "prepare");
    expect(prepare).toHaveLength(1);
    // Causal claim, not a timing one: the workspace is prepared only once the
    // check the run will complete exists.
    expectStartsAfterFinishOf(prepare[0], createCheck[0]);
    const postReview = executorRunsOf(outcome, "post-review");
    expect(postReview).toHaveLength(1);
    // No Loop in this graph, asserted rather than described: one attempt, one
    // activation scope. Every other scenario reads its records the same way, so
    // pinning it once here covers the assumption they all rest on.
    expect({
      attempt: postReview[0].attempt,
      activationScopeId: postReview[0].activationScopeId,
    }).toEqual({ attempt: 1, activationScopeId: "root" });
    // The whole input record and whole review outputs, in declaration order:
    // the join carries every field of every review and nothing else.
    expect(postReview[0].resolvedInputs).toEqual({
      reviewResults: REVIEWS.map((nodeId) => ({
        status: "reviewed",
        decision: "approve",
        feedback: reviewFeedbackOf(nodeId),
        findings: [],
      })),
    });
    expect(postReview[0].result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        decision: "approve",
        summary: APPROVED_SUMMARY,
        inlineCommentCount: 0,
        summaryFallbackCount: 0,
      },
    });
    expect(portsOf(outcome, "review-approved")).toEqual(["true"]);
    expect(
      executorRunsOf(outcome, "complete-success")[0].resolvedInputs,
    ).toEqual({ check: CHECK_REF });
    expect(completion.conclusion).toBe("success");
    expectCheckPassedThrough(outcome, "complete-success");
    expectNeverInvoked(outcome, ["complete-failure"]);
  });

  it("skips the trigger that did not fire when a PR update starts the run", async () => {
    // The committed snapshot rather than the template: the deployed graph gets
    // a full end-to-end pass, from a second entry point.
    const scenario = snapshotScenario("trigger_pr_updated", "trigger-updated");
    scenario.barrier([...REVIEWS]);
    scriptPrelude(scenario);
    scriptReviews(
      scenario,
      REVIEWS.map((nodeId) => reviewOutputFor(nodeId, [])),
    );
    scriptPostReview(scenario);
    const completion = scriptCompletion(scenario, "complete-success");

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    // The distinction this scenario exists for: the trigger that did not fire
    // is present and SKIPPED, not absent. An absent record would mean the
    // scheduler never resolved that entry point, which would leave its
    // outgoing edge unresolved and stall the join at Create PR check.
    expect(triggerRecordsOf(outcome, "trigger-ready")).toEqual([
      {
        attempt: 1,
        activationScopeId: "root",
        enteredExecutor: false,
        skipped: true,
      },
    ]);
    expect(triggerRecordsOf(outcome, "trigger-updated")).toEqual([
      {
        attempt: 1,
        activationScopeId: "root",
        enteredExecutor: false,
        skipped: undefined,
      },
    ]);
    const postReview = executorRunsOf(outcome, "post-review");
    expect(postReview).toHaveLength(1);
    expect(postReview[0].resolvedInputs).toEqual({
      reviewResults: REVIEWS.map((nodeId) => ({
        status: "reviewed",
        decision: "approve",
        feedback: reviewFeedbackOf(nodeId),
        findings: [],
      })),
    });
    expect(portsOf(outcome, "review-approved")).toEqual(["true"]);
    expect(completion.conclusion).toBe("success");
    expectCheckPassedThrough(outcome, "complete-success");
    // "trigger-ready" is deliberately not in this list: a trigger never reaches
    // an executor, so naming it here could never fail. Its real claim is the
    // skipped record asserted above.
    expectNeverInvoked(outcome, ["complete-failure"]);
  });

  it("approves when the findings are only Medium and Nit", async () => {
    const polish: ReviewResultFinding[] = [
      {
        file: "src/app.ts",
        description: "Extract this branch into a helper.",
        severity: "Medium",
        startLine: 12,
        endLine: 18,
      },
      {
        file: "src/app.ts",
        description: "Rename this variable.",
        severity: "Nit",
        startLine: 40,
      },
    ];
    const outputs = REVIEWS.map((nodeId) => reviewOutputFor(nodeId, polish));
    // The severity rule, read off the production builder: nothing below High
    // holds a review back.
    expect(outputs.map((output) => output.decision)).toEqual([
      "approve",
      "approve",
      "approve",
    ]);
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    scenario.barrier([...REVIEWS]);
    scriptPrelude(scenario);
    scriptReviews(scenario, outputs);
    scriptPostReview(scenario);
    const completion = scriptCompletion(scenario, "complete-success");

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const postReview = executorRunsOf(outcome, "post-review");
    expect(postReview).toHaveLength(1);
    // Findings survive the join whole, line spans included, even though they
    // did not change the verdict.
    expect(postReview[0].resolvedInputs).toEqual({
      reviewResults: REVIEWS.map((nodeId) => ({
        status: "reviewed",
        decision: "approve",
        feedback: reviewFeedbackOf(nodeId),
        findings: [
          {
            file: "src/app.ts",
            description: "Extract this branch into a helper.",
            severity: "Medium",
            startLine: 12,
            endLine: 18,
          },
          {
            file: "src/app.ts",
            description: "Rename this variable.",
            severity: "Nit",
            startLine: 40,
          },
        ],
      })),
    });
    expect(postReview[0].result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        decision: "approve",
        summary: APPROVED_SUMMARY,
        inlineCommentCount: 6,
        summaryFallbackCount: 0,
      },
    });
    expect(portsOf(outcome, "review-approved")).toEqual(["true"]);
    expect(completion.conclusion).toBe("success");
    expectNeverInvoked(outcome, ["complete-failure"]);
  });
});

describe("post-PR review workflow: a blocking finding", () => {
  it("fails the check and still completes the run", async () => {
    const blocker: ReviewResultFinding = {
      file: "src/auth.ts",
      description: "The session token is written to the log in clear text.",
      severity: "Blocker",
      startLine: 88,
      endLine: 92,
    };
    const outputs = [
      reviewOutputFor(REVIEWS[0], [blocker]),
      reviewOutputFor(REVIEWS[1], []),
      reviewOutputFor(REVIEWS[2], []),
    ];
    // The severity rule again, from the production builder: one Blocker is
    // enough to hold the review back.
    expect(outputs.map((output) => output.decision)).toEqual([
      "request_changes",
      "approve",
      "approve",
    ]);
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    scenario.barrier([...REVIEWS]);
    scriptPrelude(scenario);
    scriptReviews(scenario, outputs);
    scriptPostReview(scenario);
    const completion = scriptCompletion(scenario, "complete-failure");

    const outcome = await scenario.execute();

    // THE REGRESSION THIS EPIC EXISTS FOR. Requesting changes is a review
    // VERDICT, not a technical failure: the check goes red and the run itself
    // still ends green. A failed run here would mark the workflow broken,
    // surface an engine error to the client, and block the next PR event on a
    // run that did exactly what it was asked to do.
    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const postReview = executorRunsOf(outcome, "post-review");
    expect(postReview).toHaveLength(1);
    expect(postReview[0].resolvedInputs).toEqual({
      reviewResults: [
        {
          status: "reviewed",
          decision: "request_changes",
          feedback: reviewFeedbackOf(REVIEWS[0]),
          findings: [
            {
              file: "src/auth.ts",
              description:
                "The session token is written to the log in clear text.",
              severity: "Blocker",
              startLine: 88,
              endLine: 92,
            },
          ],
        },
        {
          status: "reviewed",
          decision: "approve",
          feedback: reviewFeedbackOf(REVIEWS[1]),
          findings: [],
        },
        {
          status: "reviewed",
          decision: "approve",
          feedback: reviewFeedbackOf(REVIEWS[2]),
          findings: [],
        },
      ],
    });
    expect(postReview[0].result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        decision: "request_changes",
        summary: REQUEST_CHANGES_SUMMARY,
        inlineCommentCount: 1,
        summaryFallbackCount: 0,
      },
    });
    expect(portsOf(outcome, "review-approved")).toEqual(["false"]);
    const failed = executorRunsOf(outcome, "complete-failure");
    expect(failed).toHaveLength(1);
    // The graph hands the review summary to the failure completion as the
    // `details` INPUT, while the node's own configuration carries only an empty
    // string. Which of the two the published check text is taken from is the
    // executor's precedence rule (`blocks/complete-pr-check.ts`), which the
    // harness substitutes and no test in this suite currently covers.
    expect(completion.details).toBe("");
    expect(failed[0].resolvedInputs).toEqual({
      check: CHECK_REF,
      details: REQUEST_CHANGES_SUMMARY,
    });
    expect(completion.conclusion).toBe("failure");
    expect(failed[0].result).toEqual({
      kind: "next",
      output: { status: "ok", check: CHECK_REF, conclusion: "failure" },
    });
    expectCheckPassedThrough(outcome, "complete-failure");
    expectNeverInvoked(outcome, ["complete-success"]);
  });

  it("holds the review back on a High two reviewers agree on", async () => {
    const high = (description: string): ReviewResultFinding => ({
      file: "src/queue.ts",
      description,
      severity: "High",
      startLine: 31,
    });
    // "High" is the other half of the severity gate and the only one of the
    // four severities no other scenario reaches. Two reviewers report the same
    // line in their own words, which is the agreement the published gate asks
    // for before a High may fail the check: production merges them into one
    // cluster carrying two sources. Strip `|| finding.severity === "High"` from
    // the production derivation, or the agreement branch from
    // `reviewPublicationDecision`, and the next assertions are what go red.
    const outputs = [
      reviewOutputFor(REVIEWS[0], []),
      reviewOutputFor(REVIEWS[1], [
        high("A failed job is retried without any backoff."),
      ]),
      reviewOutputFor(REVIEWS[2], [
        high("Nothing delays the next attempt, so the queue is hammered."),
      ]),
    ];
    expect(outputs.map((output) => output.decision)).toEqual([
      "approve",
      "request_changes",
      "request_changes",
    ]);
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    scenario.barrier([...REVIEWS]);
    scriptPrelude(scenario);
    scriptReviews(scenario, outputs);
    scriptPostReview(scenario);
    const completion = scriptCompletion(scenario, "complete-failure");

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const postReview = executorRunsOf(outcome, "post-review");
    expect(postReview).toHaveLength(1);
    // The agreement is between the second and third members of the fan-out, so
    // the aggregate verdict cannot be reading the first review and stopping.
    // The count is 2 because `scriptPostReview` sums the reported findings, the
    // pre-merge total: production would publish these two reports as one comment.
    // Nothing in this graph binds the count, so the difference is inert here.
    expect(postReview[0].result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        decision: "request_changes",
        summary: REQUEST_CHANGES_SUMMARY,
        inlineCommentCount: 2,
        summaryFallbackCount: 0,
      },
    });
    expect(portsOf(outcome, "review-approved")).toEqual(["false"]);
    const failed = executorRunsOf(outcome, "complete-failure");
    expect(failed).toHaveLength(1);
    expect(failed[0].resolvedInputs).toEqual({
      check: CHECK_REF,
      details: REQUEST_CHANGES_SUMMARY,
    });
    expect(completion.conclusion).toBe("failure");
    expectNeverInvoked(outcome, ["complete-success"]);
  });

  it("does not count a High only one of three reviewers reported as blocking", async () => {
    const high: ReviewResultFinding = {
      file: "src/queue.ts",
      description: "A failed job is retried without any backoff.",
      severity: "High",
      startLine: 31,
    };
    const outputs = [
      reviewOutputFor(REVIEWS[0], []),
      reviewOutputFor(REVIEWS[1], [high]),
      reviewOutputFor(REVIEWS[2], []),
    ];
    // THE REASON THE PUBLISHED GATE STOPPED READING THESE DECISIONS. The
    // reviewer still asks for changes on a High of its own, and that
    // per-reviewer rule is untouched: what changed is that one reviewer's
    // unsupported High no longer decides the check, because it used to leave a
    // green check nearly unreachable on real code.
    expect(outputs.map((output) => output.decision)).toEqual([
      "approve",
      "request_changes",
      "approve",
    ]);
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    scenario.barrier([...REVIEWS]);
    scriptPrelude(scenario);
    scriptReviews(scenario, outputs);
    scriptPostReview(scenario);
    const completion = scriptCompletion(scenario, "complete-success");

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const postReview = executorRunsOf(outcome, "post-review");
    expect(postReview).toHaveLength(1);
    // Approving does not withhold the finding: it is still one published
    // comment, it just no longer fails the check on its own.
    expect(postReview[0].result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        decision: "approve",
        summary: APPROVED_SUMMARY,
        inlineCommentCount: 1,
        summaryFallbackCount: 0,
      },
    });
    expect(portsOf(outcome, "review-approved")).toEqual(["true"]);
    expect(
      executorRunsOf(outcome, "complete-success")[0].resolvedInputs,
    ).toEqual({ check: CHECK_REF });
    expect(completion.conclusion).toBe("success");
    expectNeverInvoked(outcome, ["complete-failure"]);
  });
});

describe("post-PR review workflow: a block that fails", () => {
  it("fails the run instead of treating a provider failure as request_changes", async () => {
    // SCOPE: this proves the scheduler never synthesizes a verdict out of a
    // block that failed. It says nothing about WHICH review failures become
    // execution errors rather than a "request_changes" output, which is decided
    // inside the review agent block and belongs to that block's own tests.
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    scriptPrelude(scenario);
    // Held together so all three reviews really run, and only then does one of
    // them fail for a reason that is not a review verdict at all.
    scenario.barrier([...REVIEWS]);
    scenario.script(
      { nodeId: "security-review" },
      executionError("The review provider connection dropped.", {
        category: "provider",
        phase: "agent",
      }),
    );
    for (const nodeId of [REVIEWS[1], REVIEWS[2]]) {
      scenario.script({ nodeId }, {
        kind: "next",
        output: reviewOutputFor(nodeId, []),
      });
    }

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toEqual({
      nodeId: "security-review",
      attempt: 1,
      category: "provider",
      phase: "agent",
      message:
        "An external service could not complete this block. (The review provider connection dropped.)",
      diagnosticId: "AIW-DIAG-test-run-security-review-1",
    });
    // A Branch leaves a record whenever it runs, and there is none: no verdict
    // was inferred from a technical failure.
    expect(outcome.invocationsOf("review-approved")).toEqual([]);
    expectNeverInvoked(outcome, ["post-review", ...COMPLETIONS]);
  });

  it("never reviews and never completes the check when the workspace fails", async () => {
    const scenario = templateScenario("trigger_pr_ready", "trigger-ready");
    scenario.script({ nodeId: "create-check" }, {
      kind: "next",
      output: { status: "ok", check: CHECK_REF },
    });
    scenario.script(
      { nodeId: "prepare" },
      executionError("The exact-head checkout failed.", {
        category: "sandbox",
        phase: "workspace",
      }),
    );

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toEqual({
      nodeId: "prepare",
      attempt: 1,
      category: "sandbox",
      phase: "workspace",
      message:
        "The workspace environment could not complete this block. (The exact-head checkout failed.)",
      diagnosticId: "AIW-DIAG-test-run-prepare-1",
    });
    expect(outcome.invocationsOf("review-approved")).toEqual([]);
    expectNeverInvoked(outcome, [...REVIEWS, "post-review", ...COMPLETIONS]);
  });
});

/*
 * THREE ABSENCES, each deliberate. Recorded here so the next reader does not
 * mistake one for an oversight and add the scenario that was refused.
 *
 * 1. "What happens to a check this run already created when a later TECHNICAL
 * failure ends the run" is DEFERRED, not refused: sandbox, provider and timeout
 * failures are being changed to complete that check WITHOUT asserting a
 * verdict, instead of completing it as a failure, so a scenario written today
 * would pin behaviour that is about to be removed. The two failure scenarios
 * above only claim that neither completion block IN THE GRAPH runs, which holds
 * before and after that change.
 *
 * 2. "Empty review results" is unreachable from a scenario, for two independent
 * reasons. The rejection lives in the production `post_pr_review` executor
 * (`workflows/blocks/post-pr-review.ts` calling `normalizeReviewResultsInput`),
 * which the harness replaces with a script; and this graph binds `reviewResults`
 * as a reference list over three fixed references, which resolves one to one and
 * therefore always yields three entries. Scripting the block to return a binding
 * error it cannot produce here would read as coverage of a failure mode that
 * cannot occur. The rejection itself is asserted in
 * `workflows/review-results.test.ts`, and "a failure upstream of the Branch
 * completes neither check" is the provider-failure scenario above.
 *
 * 3. "The review agent receives the pull request change set", and its gate "a
 * definition with no review_agent node fetches no change set", are outside what
 * ANY graph-level scenario can observe. Both happen in `agent.ts` before the
 * graph walk, where the change set is assembled and pushed into
 * `ctx.preSandboxAdditions.review`; this file drives `executeV2Graph` with the
 * harness executor, so that code never runs. Even if it did, `review_agent`
 * nodes here declare no inputs, so their resolved input record is `{}` and could
 * not carry a rendered prompt section. The assembly and its rendering already
 * have unit tests in `workflows/review-change-set.test.ts`; the one piece with
 * no test is the gate predicate itself,
 * `plan.nodes.some((node) => node.type === "review_agent")`, which is still
 * inline in `agent.ts` and needs to move next to `pullRequestChangeSetTarget`
 * before a unit test can reach it.
 */
