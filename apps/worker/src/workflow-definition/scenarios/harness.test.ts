import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BlockOutput } from "@shared/contracts";
import type { PrTriggerType } from "../../lib/trigger-events.js";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { RunBudgetError } from "../../workflows/run-budget.js";
import { V2_PRODUCTION_SCHEDULER_BOUNDS } from "../v2-scheduler.js";
import { expectNeverInvoked, expectStartsAfterFinishOf } from "./assertions.js";
import {
  createScenario,
  nonScriptableBlockReason,
  QUIESCENCE_TURNS,
  ScenarioViolation,
  type CreateScenarioOptions,
} from "./harness.js";

const PR_TEMPLATE = {
  id: "post-pr-review",
  options: { includeReview: true, provider: "claude" as const },
};
const TICKET_TEMPLATE = {
  id: "reviewed-ticket-workflow",
  options: { includeReview: true, provider: "claude" as const },
};
const PR_REVIEWS = ["security-review", "quality-review", "requirements-review"];
const CHECK_REF = {
  id: "check-1",
  headSha: "abc123",
  name: "AI Workflow / Review",
};

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

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-195",
  ticketKey: "AIW-195",
  ownerToken: "owner-1",
};

const TICKET_CONTEXT = {
  identifier: "AIW-195",
  title: "Scenario harness",
  description: "Turn shipped workflows into executable specifications.",
  acceptanceCriteria: "Scenarios drive the production scheduler.",
  labels: ["ai"],
  comments: [],
};

function prScenario(
  overrides: Partial<CreateScenarioOptions> = {},
): ReturnType<typeof createScenario> {
  return createScenario({
    template: PR_TEMPLATE,
    entry: prEntry("trigger_pr_ready"),
    entryTriggerId: "trigger-ready",
    ...overrides,
  } as CreateScenarioOptions);
}

function ticketScenario(): ReturnType<typeof createScenario> {
  return createScenario({
    template: TICKET_TEMPLATE,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
}

function workspaceOutput(): BlockOutput {
  return {
    status: "ok",
    sandboxId: "sbx-scenario",
    repositories: ["github:acme/app"],
    workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
  };
}

function reviewOutput(
  decision: "approve" | "request_changes",
  file: string,
): BlockOutput {
  return {
    status: "reviewed",
    decision,
    findings:
      decision === "approve"
        ? []
        : [{ file, description: `Finding in ${file}.`, severity: "Blocker" }],
  };
}

function postReviewOutput(
  decision: "approve" | "request_changes",
): BlockOutput {
  return {
    status: "ok",
    decision,
    summary: "Reviewed.",
    inlineCommentCount: 0,
    summaryFallbackCount: 0,
  };
}

/**
 * Counts macrotask turns while `work` is in flight. Used to tell a release
 * driven by cancellation (immediate) apart from one driven by the quiescence
 * watchdog (QUIESCENCE_TURNS turns). Counting turns, not milliseconds, keeps
 * the assertion deterministic on any machine.
 */
async function turnsWhile(work: Promise<unknown>): Promise<number> {
  let running = true;
  const settled = work.then(
    () => {
      running = false;
    },
    () => {
      running = false;
    },
  );
  let turns = 0;
  while (running) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (running) turns += 1;
  }
  await settled;
  return turns;
}

/** Everything the PR review template needs up to the parallel review fan-out. */
function scriptPrPrelude(scenario: ReturnType<typeof createScenario>): void {
  scenario.script({ nodeId: "create-check" }, {
    kind: "next",
    output: { status: "ok", check: CHECK_REF },
  });
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: workspaceOutput(),
  });
}

/** Everything the reviewed ticket template needs before its review fan-out. */
function scriptTicketPrelude(
  scenario: ReturnType<typeof createScenario>,
): void {
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: workspaceOutput(),
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

/** The whole PR review graph on its approving path. */
function scriptPrApprovalPath(
  scenario: ReturnType<typeof createScenario>,
): void {
  scriptPrPrelude(scenario);
  for (const nodeId of PR_REVIEWS) {
    scenario.script({ nodeId }, {
      kind: "next",
      output: reviewOutput("approve", `${nodeId}.ts`),
    });
  }
  scenario.script({ nodeId: "post-review" }, {
    kind: "next",
    output: postReviewOutput("approve"),
  });
  scenario.script({ nodeId: "complete-success" }, {
    kind: "next",
    output: { status: "ok", check: CHECK_REF, conclusion: "success" },
  });
}

describe("scenario harness", () => {
  it("proves the three PR reviews run at the same time", async () => {
    const scenario = prScenario();
    scenario.barrier(PR_REVIEWS);
    scriptPrApprovalPath(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    // Hook-only evidence: a Branch never reaches a block executor.
    expect(outcome.invocationsOf("review-approved")[0].selectedTransition)
      .toMatchObject({ port: "true" });
    // A skipped trigger leaves a record, which is why "never ran" needs the
    // executor boundary rather than a record count.
    expect(outcome.invocationsOf("trigger-updated")[0].skipped).toBe(true);
    expectNeverInvoked(outcome, ["trigger-updated", "complete-failure"]);
    expectStartsAfterFinishOf(
      outcome.invocationsOf("post-review")[0],
      outcome.invocationsOf("security-review")[0],
    );
  });

  it("reports which of the named blocks actually ran", async () => {
    const scenario = prScenario();
    scriptPrApprovalPath(scenario);
    const outcome = await scenario.execute();

    expect(() => expectNeverInvoked(outcome, ["prepare", "complete-failure"]))
      .toThrow(/never to run, but the scheduler ran "prepare" \(attempt 1/);
  });

  it("orders a join's inputs by declaration rather than by completion", async () => {
    const scenario = prScenario();
    scriptPrPrelude(scenario);
    // Released back to front: the join must still see declaration order.
    scenario.releaseInOrder([...PR_REVIEWS].reverse(), (nodeId) => ({
      kind: "next",
      output: reviewOutput("request_changes", `${nodeId}.ts`),
    }));
    scenario.script({ nodeId: "post-review" }, {
      kind: "next",
      output: postReviewOutput("request_changes"),
    });
    scenario.script({ nodeId: "complete-failure" }, {
      kind: "next",
      output: { status: "ok", check: CHECK_REF, conclusion: "failure" },
    });

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    const reviewResults = outcome.invocationsOf("post-review")[0].resolvedInputs
      ?.reviewResults as Array<{ findings: Array<{ file: string }> }>;
    expect(reviewResults.map((review) => review.findings[0].file)).toEqual(
      PR_REVIEWS.map((nodeId) => `${nodeId}.ts`),
    );
  });

  it("varies a held join per Loop attempt", async () => {
    const scenario = ticketScenario();
    scriptTicketPrelude(scenario);
    // Released back to front on every pass, and approving only on the fourth,
    // so declaration order and per-attempt variation hold at the same time.
    scenario.releaseInOrder([...PR_REVIEWS].reverse(), (nodeId, context) =>
      ({
        kind: "next",
        output: reviewOutput(
          context.attempt === 4 ? "approve" : "request_changes",
          `${nodeId}.ts`,
        ),
      }),
    );
    scenario.script({ nodeId: "fix" }, {
      kind: "next",
      output: {
        status: "fixed",
        workspaceId: "sbx-scenario",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        summary: "Fixed.",
      },
    });
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
            branchName: "ai-workflow/AIW-195",
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
            branch: "ai-workflow/AIW-195",
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

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    for (const nodeId of PR_REVIEWS) {
      expect(
        outcome.invocationsOf(nodeId).map((invocation) => invocation.attempt),
      ).toEqual([1, 2, 3, 4]);
    }
    // Filtered on the executor boundary: the Loop leaves a record for the
    // attempt it never launched, so the raw record count is 4.
    expect(
      outcome
        .invocationsOf("fix")
        .filter((invocation) => invocation.enteredExecutor),
    ).toHaveLength(3);
    expectNeverInvoked(outcome, ["exhausted-message", "exhausted-failure"]);
  });

  it("resolves Terminate through the production dispatcher, not a script", async () => {
    const scenario = ticketScenario();
    scriptTicketPrelude(scenario);
    for (const nodeId of PR_REVIEWS) {
      scenario.script({ nodeId }, {
        kind: "next",
        output: reviewOutput("request_changes", `${nodeId}.ts`),
      });
    }
    scenario.script({ nodeId: "fix" }, {
      kind: "next",
      output: {
        status: "fixed",
        workspaceId: "sbx-scenario",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        summary: "Fixed.",
      },
    });
    scenario.script({ nodeId: "exhausted-message" }, {
      kind: "next",
      output: { status: "ok" },
    });

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toMatchObject({
      nodeId: "exhausted-failure",
      category: "engine",
      phase: "terminate",
    });
    // Hook-only evidence again: a Loop reports its exit port nowhere else.
    expect(
      outcome
        .invocationsOf("retry")
        .map((invocation) => invocation.selectedTransition?.port),
    ).toContain("exhausted");
  });

  it("fails when a block runs without a script", async () => {
    const scenario = prScenario();
    scenario.script({ nodeId: "create-check" }, {
      kind: "next",
      output: { status: "ok", check: CHECK_REF },
    });

    await expect(scenario.execute()).rejects.toThrow(
      /did not script node "prepare".*script\(\{ nodeId: "prepare", attempt: 1, activationScopeId: "root" \}/s,
    );
  });

  it("fails when a script never runs", async () => {
    const scenario = prScenario();
    scriptPrApprovalPath(scenario);
    scenario.script({ nodeId: "complete-failure" }, {
      kind: "next",
      output: { status: "ok", check: CHECK_REF, conclusion: "failure" },
    });

    await expect(scenario.execute()).rejects.toThrow(
      /scripted outcomes that never ran: node "complete-failure"/,
    );
  });

  it("fails an unused script even when the scheduler throws", async () => {
    const scenario = prScenario();
    scenario.script({ nodeId: "create-check" }, () => {
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit: 1,
        consumed: 2,
        reason: "Run budget exceeded.",
      });
    });
    scenario.script({ nodeId: "prepare" }, {
      kind: "next",
      output: workspaceOutput(),
    });

    await expect(scenario.execute()).rejects.toThrow(
      /scripted outcomes that never ran: node "prepare".*The run also ended with: Run budget exceeded\./s,
    );
  });

  it("refuses to script blocks the scheduler owns", () => {
    const scenario = ticketScenario();

    expect(() => scenario.script({ nodeId: "reviews-approved" }, {
      kind: "next",
      output: { status: "ok" },
    })).toThrow(/scheduler-owned "branch" block/);
    expect(() => scenario.script({ nodeId: "retry" }, {
      kind: "next",
      output: { status: "ok" },
    })).toThrow(/scheduler-owned "loop" block/);
  });

  it("refuses to script blocks the production dispatcher owns", () => {
    const scenario = ticketScenario();

    expect(() => scenario.script({ nodeId: "exhausted-failure" }, {
      kind: "next",
      output: { status: "done" },
    })).toThrow(/dispatcher-owned "terminate" block/);
    // No shipped template contains a Transform node, so the rule is asserted
    // against the predicate the harness itself consults.
    expect(nonScriptableBlockReason({ id: "shape", type: "transform" })).toMatch(
      /dispatcher-owned "transform" block/,
    );
  });

  it("rejects a scripted output that violates the block contract", () => {
    const scenario = ticketScenario();

    expect(() => scenario.script({ nodeId: "open-pr" }, {
      kind: "next",
      output: { status: "ok" },
    })).toThrow(/scripts an invalid "open_pr" output for node "open-pr"/);
  });

  it("names the real attempt and scope when a factory output is invalid", async () => {
    const scenario = prScenario();
    scenario.script({ nodeId: "create-check" }, {
      kind: "next",
      output: { status: "ok", check: CHECK_REF },
    });
    // A node-wide match, so only the invocation knows the attempt and scope.
    scenario.script({ nodeId: "prepare" }, () => ({
      kind: "next",
      output: { status: "ok" },
    }));

    await expect(scenario.execute()).rejects.toThrow(
      /invalid "prepare_workspace" output for node "prepare", attempt 1, scope "root"/,
    );
  });

  it("rejects a duplicate match key at registration", () => {
    const scenario = prScenario();
    scenario.script({ nodeId: "prepare" }, {
      kind: "next",
      output: workspaceOutput(),
    });

    expect(() => scenario.script({ nodeId: "prepare" }, {
      kind: "next",
      output: workspaceOutput(),
    })).toThrow(/already scripts node "prepare"/);
  });

  it("rejects a barrier wider than production concurrency at registration", () => {
    const scenario = prScenario();

    expect(() =>
      scenario.barrier([
        ...PR_REVIEWS,
        "post-review",
        "complete-success",
      ]),
    ).toThrow(
      new RegExp(
        `holds 5 blocks .* at most ${V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency}`,
      ),
    );
  });

  it("reports a barrier the graph can never satisfy instead of hanging", async () => {
    const scenario = prScenario();
    // "prepare" runs long before "post-review" can, so the group never fills.
    scenario.barrier(["prepare", "post-review"]);
    scenario.script({ nodeId: "create-check" }, {
      kind: "next",
      output: { status: "ok", check: CHECK_REF },
    });
    scenario.script({ nodeId: "prepare" }, {
      kind: "next",
      output: workspaceOutput(),
    });

    await expect(scenario.execute()).rejects.toThrow(
      /went quiet with only "prepare" started\. Never started: "post-review"/,
    );
  });

  it("releases held blocks through cancellation, not through the watchdog", async () => {
    const scenario = prScenario();
    scriptPrPrelude(scenario);
    const held = ["quality-review", "requirements-review"];
    // "post-review" cannot join the group, so the two held reviews can only be
    // freed by the cancellation the failing sibling triggers.
    scenario.barrier([...held, "post-review"]);
    for (const nodeId of held) {
      scenario.script({ nodeId }, {
        kind: "next",
        output: reviewOutput("approve", `${nodeId}.ts`),
      });
    }
    scenario.script({ nodeId: "security-review" }, () => {
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "tokens",
        limit: 1,
        consumed: 2,
        reason: "Token budget exceeded.",
      });
    });

    const run = scenario.execute();
    const turns = turnsWhile(run);
    await expect(run).rejects.toBeInstanceOf(RunBudgetError);

    // Both held reviews really did park on the gate, so the release path was
    // exercised rather than skipped by an early cancellation.
    for (const nodeId of held) {
      expect(
        scenario.invocations.find(
          (invocation) => invocation.nodeId === nodeId,
        ),
      ).toMatchObject({ enteredExecutor: true, runtimeState: "cancelled" });
    }
    // The watchdog needs QUIESCENCE_TURNS turns to fire, so finishing well
    // inside that budget proves cancellation freed them.
    expect(await turns).toBeLessThan(QUIESCENCE_TURNS);
  });

  it("rejects an entry whose trigger type does not match the entry node", () => {
    expect(() =>
      createScenario({
        template: PR_TEMPLATE,
        entry: prEntry("trigger_pr_updated"),
        entryTriggerId: "trigger-ready",
      }),
    ).toThrow(
      /enters at node "trigger-ready" \(type "trigger_pr_ready"\).*fires "trigger_pr_updated"/s,
    );
  });

  it("exposes the dispatch bounds the production call site uses", () => {
    expect(V2_PRODUCTION_SCHEDULER_BOUNDS).toEqual({
      maxConcurrency: 4,
      maxTotalExecutions: 200,
    });
    const agentSource = readFileSync(
      fileURLToPath(new URL("../../workflows/agent.ts", import.meta.url)),
      "utf8",
    );
    expect(agentSource).toContain(
      "maxConcurrency: V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency",
    );
    expect(agentSource).toContain(
      "V2_PRODUCTION_SCHEDULER_BOUNDS.maxTotalExecutions",
    );
  });
});

describe("scenario graph sources", () => {
  const snapshotDirectory = new URL("./snapshots/", import.meta.url);

  it("runs a committed snapshot of a deployed definition end to end", async () => {
    const scenario = createScenario({
      snapshot: { path: "post-pr-review-v1.json" },
      entry: prEntry("trigger_pr_ready"),
      entryTriggerId: "trigger-ready",
    });
    scenario.barrier(PR_REVIEWS);
    scriptPrApprovalPath(scenario);

    const outcome = await scenario.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    expectNeverInvoked(outcome, ["complete-failure"]);
  });

  it("rejects both a template and a snapshot", () => {
    expect(() =>
      createScenario({
        template: PR_TEMPLATE,
        snapshot: { path: "anything.json" },
        entry: prEntry("trigger_pr_ready"),
        entryTriggerId: "trigger-ready",
      } as unknown as CreateScenarioOptions),
    ).toThrow(/either `template` or `snapshot`, never both/);
  });

  it("rejects neither a template nor a snapshot", () => {
    expect(() =>
      createScenario({
        entry: prEntry("trigger_pr_ready"),
        entryTriggerId: "trigger-ready",
      } as unknown as CreateScenarioOptions),
    ).toThrow(/Inline nodes and edges are not accepted/);
  });

  it("fails a snapshot that does not satisfy the definition schema", () => {
    mkdirSync(snapshotDirectory, { recursive: true });
    const file = new URL("harness-test-invalid.json", snapshotDirectory);
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, nodes: [] }));
    try {
      expect(() =>
        createScenario({
          snapshot: { path: "harness-test-invalid.json" },
          entry: prEntry("trigger_pr_ready"),
          entryTriggerId: "trigger-ready",
        }),
      ).toThrow(
        /snapshot "harness-test-invalid\.json" is not a valid workflow definition/,
      );
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("fails a snapshot that parses but would not deploy", () => {
    const committed = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("post-pr-review-v1.json", snapshotDirectory)),
        "utf8",
      ),
    ) as { edges: Array<{ id: string; from: string; to: string }> };
    committed.edges.push({
      id: "dangling",
      from: "post-review",
      to: "no-such-node",
    });
    const file = new URL("harness-test-undeployable.json", snapshotDirectory);
    writeFileSync(file, JSON.stringify(committed));
    try {
      expect(() =>
        createScenario({
          snapshot: { path: "harness-test-undeployable.json" },
          entry: prEntry("trigger_pr_ready"),
          entryTriggerId: "trigger-ready",
        }),
      ).toThrow(/would not deploy/);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("refuses a snapshot path outside the committed directory", () => {
    expect(() =>
      createScenario({
        snapshot: { path: "../templates.ts" },
        entry: prEntry("trigger_pr_ready"),
        entryTriggerId: "trigger-ready",
      }),
    ).toThrow(/resolves outside the committed snapshots directory/);
  });
});
