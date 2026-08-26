import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finalizeWorkspacePublication: vi.fn(),
  createRepositoryVCS: vi.fn(),
}));

vi.mock("../workspace-publication.js", () => ({
  finalizeWorkspacePublication: mocks.finalizeWorkspacePublication,
}));

vi.mock("../../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

import type {
  ReviewLedgerDurableFeedEntry,
  ReviewLedgerState,
  SettleReviewThreadInput,
} from "../../adapters/vcs/types.js";
import type {
  WorkspaceManifest,
  WorkspaceRepositoryInput,
} from "../../sandbox/repo-workspace.js";
import { execute, paramsSchema } from "./finalize-workspace.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  makePrPayload,
  runControlErrorCases,
} from "./test-support.js";

const repo: WorkspaceRepositoryInput = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "selected",
};

const trustedManifest: WorkspaceManifest = {
  version: 1,
  repositories: [{
    ...repo,
    slug: "acme__api",
    localPath: "/vercel/sandbox",
    branchName: "blazebot/awt-1",
    expectedRemoteSha: "before",
    preAgentSha: "before",
  }],
};

const finalized = {
  status: "finalized" as const,
  repositories: [
    {
      provider: "github" as const,
      repoPath: "acme/api",
      branchName: "blazebot/awt-1",
      defaultBranch: "main",
      expectedHead: "before",
      pushedHead: "after",
    },
  ],
  prs: [] as [],
};

/**
 * A scripts step output with every field the emitter writes.
 *
 * Full, not partial, because the recoveries recognise this output through the
 * one shared guard and that guard tests the FULL field set: a fixture missing
 * half the fields would be recognised here and by nothing in production.
 */
function scriptsOutput(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    ok: true,
    outcome: "passed",
    allPassed: true,
    anyFailed: false,
    groupStatuses: [],
    results: [],
    failures: [],
    dirtied: [],
    setupFailed: false,
    summary: "Repository scripts passed (1 command).",
    ...overrides,
  };
}

describe("finalize_workspace paramsSchema", () => {
  it("accepts empty params and rejects retired authoring params", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ legacyRequiredChecks: ["checks.with dots"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ requiredChecks: ["checks-1"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("finalize_workspace execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalizeWorkspacePublication.mockResolvedValue(finalized);
  });

  it("ignores unrelated prior step records", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      { "checks-1": { output: { status: "ok", ok: false } } },
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );
    expect(result.kind).toBe("next");
  });

  it("rejects any resolved check status that is not ok", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx(),
      { "checks.lint": "ok", "checks.test": "failed" },
    );
    expect(result).toEqual({
      kind: "execution_error",
      error: {
        category: "checks",
        message: "The checks could not be started. (required checks not satisfied: test)",
        detail: "required checks not satisfied: test",
      },
    });
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("publishes a v1-converted definition whose tenant configured no scripts", async () => {
    // A v1 definition binds checks.<node> to that node's output STATUS, and an
    // unconfigured tenant's scripts block reports "skipped". Reading that as
    // unmet failed EVERY run of every tenant who never opened the scripts
    // screen, at the publication boundary, with "required checks not
    // satisfied" naming a check that was never asked to run.
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      { "checks.checks": "skipped" },
    );

    expect(result.kind).toBe("next");
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalled();
  });

  it("publishes when the configured scripts matched none of the changed repositories", async () => {
    // The zero-match skip, which reports the same status for the same reason:
    // nothing was verified because there was nothing this run needed verified.
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      { "checks.gate": "skipped", "checks.lint": "ok" },
    );

    expect(result.kind).toBe("next");
  });

  it("still blocks publication for a check status that is neither ok nor skipped", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      { "checks.gate": "failed", "checks.lint": "skipped" },
    );

    expect(result).toMatchObject({
      kind: "execution_error",
      error: { category: "checks", detail: "required checks not satisfied: gate" },
    });
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("publishes when every resolved check status is ok", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      { "checks.lint": "ok", "checks.test": "ok" },
    );

    expect(result.kind).toBe("next");
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledOnce();
  });

  it("fails when no workspace is attached", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ sandboxId: null }),
    );
    expect(result.kind).toBe("execution_error");
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace has no manager-authored trusted manifest", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ sandboxId: "sbx-1", workspaceManifest: null }),
    );

    expect(result).toEqual(expect.objectContaining({
      kind: "execution_error",
      error: expect.objectContaining({ detail: expect.stringContaining("trusted") }),
    }));
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("passes the manager-authored manifest as the publication authority", async () => {
    await execute(
      makeNode("finalize_workspace", {}, "finalize"),
      {},
      makeCtx({
        selectedRepositories: [repo],
        workspaceManifest: trustedManifest,
      }),
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceManifest: trustedManifest }),
    );
  });

  it("pushes and emits finalized branch metadata", async () => {
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    });
    const result = await execute(makeNode("finalize_workspace", {}, "finalize"), {}, ctx);

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith({
      runId: "run-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner:test",
      sandboxId: "sbx-1",
      ticketKey: "AWT-1",
      workspaceManifest: trustedManifest,
      prePrGate: null,
      // No script block ran, so the boundary is told there is no drift to
      // attribute rather than being left to guess, and that no scripts output
      // failed: with none, the only true refusal is the one about the gate
      // record itself.
      scriptDrift: [],
      scriptsFailure: null,
      clarifications: undefined,
      sourcePullRequest: undefined,
    });
    expect(ctx.publication).toEqual(finalized);
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "finalized",
        repositories: finalized.repositories,
      },
    });
    expectOutputConformsToRegistry("finalize_workspace", result.output!);
  });

  it("passes the captured workspace gate into the independent publication boundary", async () => {
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    }) as ReturnType<typeof makeCtx> & {
      prePrGate: { configurationVersion: number; fingerprint: string } | null;
    };
    ctx.prePrGate = {
      configurationVersion: 7,
      fingerprint: "workspace-fingerprint",
    };

    await execute(makeNode("finalize_workspace"), {}, ctx);

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        prePrGate: {
          configurationVersion: 7,
          fingerprint: "workspace-fingerprint",
        },
      }),
    );
  });

  it("recovers the gate from the durable checks output when heap state was lost on resume", async () => {
    // Simulate a scheduler resume in a cold instance: the checks handler body
    // never re-ran, so ctx.prePrGate (ephemeral heap) is null, but the checks
    // node's durable checkpointed output still carries the gate value.
    const recoveredGate = {
      configurationVersion: 7,
      fingerprint: "workspace-fingerprint",
    };
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    });
    ctx.prePrGate = null;

    await execute(
      makeNode("finalize_workspace"),
      {
        checks: {
          output: {
            status: "ok",
            ok: true,
            outcome: "passed",
            fixCycles: 0,
            summary: "all checks passed",
            gate: recoveredGate,
          },
        },
      },
      ctx,
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({ prePrGate: recoveredGate }),
    );
  });

  it("prefers the live heap gate over a durable checks output gate", async () => {
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    }) as ReturnType<typeof makeCtx> & {
      prePrGate: { configurationVersion: number; fingerprint: string } | null;
    };
    ctx.prePrGate = { configurationVersion: 9, fingerprint: "live-heap" };

    await execute(
      makeNode("finalize_workspace"),
      {
        checks: {
          output: {
            status: "ok",
            ok: true,
            outcome: "passed",
            fixCycles: 0,
            summary: "all checks passed",
            gate: { configurationVersion: 7, fingerprint: "durable-stale" },
          },
        },
      },
      ctx,
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        prePrGate: { configurationVersion: 9, fingerprint: "live-heap" },
      }),
    );
  });

  it("passes a null gate when neither heap nor any durable output carries one", async () => {
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    });
    ctx.prePrGate = null;

    await execute(
      makeNode("finalize_workspace"),
      { research: { output: { status: "ok", summary: "no gate here" } } },
      ctx,
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({ prePrGate: null }),
    );
  });

  it("passes the exact triggering PR/MR source head into publication", async () => {
    const pr = makePrPayload({ headSha: "trigger-head" });
    await execute(
      makeNode("finalize_workspace", {}, "finalize"),
      {},
      makeCtx({
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_review",
          subjectKey: "pr:github:acme/api#7",
          ticketKey: "AWT-1",
          ownerToken: "owner-1",
          scope: "workflow_owned",
          definitionId: 1,
          definitionVersion: 1,
          pr,
        },
        selectedRepositories: [repo],
        workspaceManifest: trustedManifest,
      }),
    );
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePullRequest: {
          provider: "github",
          repoPath: "acme/api",
          prId: 7,
          headSha: "trigger-head",
          baseRef: "main",
        },
      }),
    );
  });

  it("maps a failed durable publication to the push phase without PR side effects", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      reason: "lease rejected",
      repositories: [],
      prs: [],
    });
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    });
    const result = await execute(makeNode("finalize_workspace"), {}, ctx);

    expect(result).toEqual({
      kind: "execution_error",
      error: {
        category: "provider",
        message: "An external service could not complete this block. (lease rejected)",
        detail: "lease rejected",
        phase: "push",
      },
    });
  });

  it("maps publication-boundary gate rejection to a checks execution failure", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      failureKind: "pre_pr_gate",
      reason: "The Run Workspace changed after pre-publication checks passed.",
      repositories: [],
      prs: [],
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({
        selectedRepositories: [repo],
        workspaceManifest: trustedManifest,
      }),
    );

    expect(result).toEqual({
      kind: "execution_error",
      error: {
        category: "checks",
        message:
          "The checks could not be started. (The Run Workspace changed after pre-publication checks passed.)",
        detail: "The Run Workspace changed after pre-publication checks passed.",
        phase: "pre-pr-checks",
      },
    });
  });

  it("hands the publication boundary every repository the scripts dirtied", async () => {
    // Every script block the walk ran, not just the last: a group configured
    // with restoreTree false can run early and the gating selection later, and
    // it is the early one whose files are still in the tree at publication.
    await execute(
      makeNode("finalize_workspace"),
      {
        format: {
          output: scriptsOutput({
            dirtied: [
              {
                repo: "github:acme/api",
                files: ["src/generated.ts"],
                preExisting: [],
              },
            ],
          }),
        },
        gate: {
          output: scriptsOutput({
            outcome: "failed",
            dirtied: [
              {
                repo: "github:acme/api",
                // The same path twice across two selections is normal and must
                // not be reported twice.
                files: ["src/generated.ts", "dist/bundle.js"],
                preExisting: ["src/agent-work.ts"],
              },
            ],
          }),
        },
        prepare: { output: { status: "ok", sandboxId: "sbx-1" } },
      },
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptDrift: [
          {
            repo: "github:acme/api",
            files: ["src/generated.ts", "dist/bundle.js"],
            preExisting: ["src/agent-work.ts"],
          },
        ],
      }),
    );
  });

  it("reports no drift for a run whose graph never ran a script block", async () => {
    await execute(
      makeNode("finalize_workspace"),
      { prepare: { output: { status: "ok", sandboxId: "sbx-1" } } },
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({ scriptDrift: [] }),
    );
  });

  it("tells the boundary the scripts failed, so the gate does not contradict them", async () => {
    await execute(
      makeNode("finalize_workspace"),
      {
        gate: {
          output: scriptsOutput({
            ok: false,
            outcome: "failed",
            allPassed: false,
            anyFailed: true,
            failures: [
              {
                repo: "github:acme/api",
                command: "pnpm test",
                exitCode: 1,
                output: "",
                phase: null,
              },
            ],
          }),
        },
      },
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        // The whole output, not a flag: the boundary refuses with the command.
        scriptsFailure: expect.objectContaining({
          failures: [
            expect.objectContaining({ command: "pnpm test", exitCode: 1 }),
          ],
        }),
      }),
    );
  });

  it("carries the boundary's own attribution as isolated cause evidence", async () => {
    // The composed reason is clamped head-and-tail into a 160-character
    // snippet, and an appended attribution sits exactly where that cut lands.
    // Handed over as evidence.cause it is given priority instead, so the one
    // fragment that names the culprit is the one that survives.
    const attribution =
      "Repository scripts modified 1 tracked file in github:acme/api: src/generated.ts.";
    const drifted = Array.from(
      { length: 20 },
      (_, index) => `packages/app/src/generated/module-${index}.ts`,
    ).join(", ");
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      failureKind: "pre_pr_gate",
      reason:
        "The Run Workspace could not be verified at the publication boundary. " +
        `Run Workspace is not clean for github:acme/api: ${drifted}. ${attribution}`,
      cause: attribution,
      repositories: [],
      prs: [],
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );

    expect(result.kind).toBe("execution_error");
    const message =
      result.kind === "execution_error" ? result.error.message : "";
    expect(message).toContain(
      "The Run Workspace could not be verified at the publication boundary.",
    );
    expect(message).toContain(attribution);
    // The paths in the middle of the reason are exactly what clamping eats.
    expect(message).not.toContain("packages/app/src/generated/module-9.ts");
  });

  it("leads the run failure with the scripts refusal, not with the checks category", async () => {
    // The refusal names the command. Left to the checks category default it is
    // announced as "The checks could not be started." with the command buried
    // in the parenthesised snippet, which is the fragment the clamp eats: that
    // is how a failing `pnpm test` reached production as a sentence about a
    // missing gate record.
    const refusal =
      "Repository scripts failed, so publication was refused: github:acme/api: pnpm test (exit 1)";
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      failureKind: "pre_pr_gate",
      reason: refusal,
      repositories: [],
      prs: [],
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );

    const message = result.kind === "execution_error" ? result.error.message : "";
    expect(message).toBe(refusal);
    expect(message).not.toContain("The checks could not be started.");
  });

  it.each(runControlErrorCases())("rethrows %s from publication", async (_label, error) => {
    mocks.finalizeWorkspacePublication.mockRejectedValue(error);

    await expect(
      execute(
        makeNode("finalize_workspace"),
        {},
        makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      ),
    ).rejects.toBe(error);
  });
});

const ledgerState = (): ReviewLedgerState => {
  const accepted = [
    { alias: "T1", disposition: "actionable" as const, reply: "Renamed the helper." },
    { alias: "T2", disposition: "question" as const, reply: "Which case do you mean?" },
  ];
  return {
    feed: {
      threads: [
        {
          threadId: "th-1",
          alias: "T1",
          source: "human",
          resolvable: true,
          awaitingHuman: false,
          notes: [
            {
              author: "reviewer",
              body: "Please rename this helper.",
              createdAt: "2026-08-21T10:00:00.000Z",
              isLedgerReply: false,
            },
          ],
        },
        {
          threadId: "th-2",
          alias: "T2",
          source: "human",
          resolvable: true,
          awaitingHuman: false,
          notes: [
            {
              author: "reviewer",
              body: "Why this order?",
              createdAt: "2026-08-21T10:01:00.000Z",
              isLedgerReply: false,
            },
          ],
        },
      ],
      truncated: 0,
      contextTruncated: 0,
      snapshotAt: "2026-08-21T10:05:00.000Z",
    },
    dispositions: accepted,
    verification: { accepted, rejected: [] },
  };
};

/**
 * What an agent node checkpoints under `reviewLedger`: the same projection the
 * hot path builds from ctx, which is all a cold resume gets back.
 */
const durableLedgerOutput = (feedLite?: ReviewLedgerDurableFeedEntry[]) => ({
  status: "implemented",
  reviewLedger: {
    dispositions: [
      { alias: "T1", threadId: "th-1", disposition: "actionable", reply: "Renamed the helper." },
      { alias: "T2", threadId: "th-2", disposition: "question", reply: "Which case do you mean?" },
    ],
    declaredWrites: true,
    truncated: 0,
    rejectedCount: 0,
    feedLite: feedLite ?? [
      {
        threadId: "th-1",
        alias: "T1",
        source: "human",
        resolvable: true,
        awaitingHuman: false,
        snapshotAt: "2026-08-21T10:05:00.000Z",
      },
      {
        threadId: "th-2",
        alias: "T2",
        source: "human",
        resolvable: true,
        awaitingHuman: false,
        snapshotAt: "2026-08-21T10:05:00.000Z",
      },
    ],
  },
});

const prTriggerCtx = (reviewLedger?: ReviewLedgerState) =>
  makeCtx({
    entry: {
      kind: "pr_trigger",
      triggerType: "trigger_pr_review",
      subjectKey: "pr:github:acme/api#7",
      ticketKey: "AWT-1",
      ownerToken: "owner-1",
      scope: "workflow_owned",
      definitionId: 1,
      definitionVersion: 1,
      pr: makePrPayload({ headSha: "trigger-head" }),
    },
    selectedRepositories: [repo],
    workspaceManifest: trustedManifest,
    reviewLedger,
  });

describe("finalize_workspace review ledger settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalizeWorkspacePublication.mockResolvedValue(finalized);
  });

  it("never touches the VCS when the run carries no ledger", async () => {
    const result = await execute(makeNode("finalize_workspace"), {}, prTriggerCtx());

    expect(result.output).toEqual({
      status: "finalized",
      repositories: finalized.repositories,
    });
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("settles every accepted thread against the pushed head of the PR's repository", async () => {
    const calls: SettleReviewThreadInput[] = [];
    const settleReviewThread = vi.fn(async (input: SettleReviewThreadInput) => {
      calls.push(input);
      return { action: input.resolve ? ("replied_and_resolved" as const) : ("replied" as const) };
    });
    mocks.createRepositoryVCS.mockReturnValue({ settleReviewThread });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      prTriggerCtx(ledgerState()),
    );

    expect(mocks.createRepositoryVCS).toHaveBeenCalledExactlyOnceWith({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    expect(calls.map((call) => [call.prId, call.thread.threadId, call.resolve])).toEqual([
      [7, "th-1", true],
      [7, "th-2", false],
    ]);
    // `after` is the pushedHead of acme/api in the publication result.
    expect(calls[0]!.body).toContain("Addressed in `after`.");
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "finalized",
        repositories: finalized.repositories,
        reviewLedgerSettled: [
          { threadId: "th-1", alias: "T1", action: "replied_and_resolved" },
          { threadId: "th-2", alias: "T2", action: "replied" },
        ],
      },
    });
    // The settle field has to be declared by the block contract: the scheduler
    // validates every output and would fail the node after a successful push.
    expectOutputConformsToRegistry("finalize_workspace", result.output!);
  });

  // A sibling repository's head means nothing to this reviewer, so the run has
  // no commit to cite; saying so beats leaving the thread unmentioned.
  it("reports an error for the actionable thread when the PR's repository pushed nothing", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      ...finalized,
      repositories: [{ ...finalized.repositories[0]!, repoPath: "acme/other" }],
    });
    const settleReviewThread = vi.fn(async (_input: SettleReviewThreadInput) => ({
      action: "replied" as const,
    }));
    mocks.createRepositoryVCS.mockReturnValue({ settleReviewThread });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      prTriggerCtx(ledgerState()),
    );

    expect(settleReviewThread).toHaveBeenCalledOnce();
    expect(settleReviewThread.mock.calls[0]![0]!.thread.threadId).toBe("th-2");
    expect(result.output!.reviewLedgerSettled).toEqual([
      { threadId: "th-1", alias: "T1", error: "no pushed head for acme/api" },
      { threadId: "th-2", alias: "T2", action: "replied" },
    ]);
    expectOutputConformsToRegistry("finalize_workspace", result.output!);
  });

  it("keeps a successful publication when the provider rejects every reply", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      settleReviewThread: vi.fn(async () => {
        throw new Error("thread locked");
      }),
    });
    const ctx = prTriggerCtx(ledgerState());

    const result = await execute(makeNode("finalize_workspace"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(ctx.publication).toEqual(finalized);
    expect(result.output).toEqual({
      status: "finalized",
      repositories: finalized.repositories,
      reviewLedgerSettled: [
        { threadId: "th-1", alias: "T1", error: "thread locked" },
        { threadId: "th-2", alias: "T2", error: "thread locked" },
      ],
    });
    expectOutputConformsToRegistry("finalize_workspace", result.output!);
  });

  it("keeps a successful publication when no adapter can be built at all", async () => {
    mocks.createRepositoryVCS.mockImplementation(() => {
      throw new Error("github is not configured");
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      prTriggerCtx(ledgerState()),
    );

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "finalized",
        repositories: finalized.repositories,
        reviewLedgerSettled: [
          { threadId: "th-1", alias: "T1", error: "github is not configured" },
          { threadId: "th-2", alias: "T2", error: "github is not configured" },
        ],
      },
    });
  });

  it("degrades the reply for an already_addressed quote the second pass could not find", async () => {
    const accepted = [
      {
        alias: "T1",
        threadId: "th-1",
        disposition: "already_addressed" as const,
        evidence: { filePath: "src/a.ts", quote: "const kept = true;" },
      },
      {
        alias: "T2",
        threadId: "th-2",
        disposition: "already_addressed" as const,
        evidence: { filePath: "src/b.ts", quote: "const stale = true;" },
      },
    ];
    const base = ledgerState();
    const calls: SettleReviewThreadInput[] = [];
    const settleReviewThread = vi.fn(async (input: SettleReviewThreadInput) => {
      calls.push(input);
      return { action: "replied" as const };
    });
    mocks.createRepositoryVCS.mockReturnValue({ settleReviewThread });

    await execute(
      makeNode("finalize_workspace"),
      {},
      prTriggerCtx({
        ...base,
        dispositions: accepted,
        verification: { accepted, rejected: [] },
        // Keyed by threadId, not by the positional alias: a feed re-read after
        // the push can hand T1 to a different thread.
        evidencePresentThreadIds: ["th-1"],
      }),
    );

    expect(calls.map((call) => call.thread.alias)).toEqual(["T1", "T2"]);
    expect(calls[0]!.body).toContain("const kept = true;");
    expect(calls[1]!.body).not.toContain("const stale = true;");
    expect(calls[1]!.body).toContain("`src/b.ts` changed in `after`");
  });

  it("does not settle when the publication failed", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      reason: "lease rejected",
      repositories: [],
      prs: [],
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      prTriggerCtx(ledgerState()),
    );

    expect(result.kind).toBe("execution_error");
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  // The whole point of the durable projection: ctx.reviewLedger is heap, and a
  // scheduler resume in a cold instance re-enters finalize without it. Answering
  // nothing here is indistinguishable, to the reviewer, from a dead webhook.
  it("settles from the checkpointed agent output when heap state was lost on resume", async () => {
    const calls: SettleReviewThreadInput[] = [];
    const settleReviewThread = vi.fn(async (input: SettleReviewThreadInput) => {
      calls.push(input);
      return { action: input.resolve ? ("replied_and_resolved" as const) : ("replied" as const) };
    });
    mocks.createRepositoryVCS.mockReturnValue({ settleReviewThread });
    const ctx = prTriggerCtx();

    const result = await execute(
      makeNode("finalize_workspace"),
      { implement: { output: durableLedgerOutput() } },
      ctx,
    );

    expect(calls.map((call) => [call.thread.threadId, call.resolve])).toEqual([
      ["th-1", true],
      ["th-2", false],
    ]);
    expect(calls[0]!.body).toContain("Addressed in `after`.");
    expect(calls[0]!.snapshotAt).toBe("2026-08-21T10:05:00.000Z");
    expect(result.output!.reviewLedgerSettled).toEqual([
      { threadId: "th-1", alias: "T1", action: "replied_and_resolved" },
      { threadId: "th-2", alias: "T2", action: "replied" },
    ]);
    expect(ctx.reviewLedgerSettled).toEqual(result.output!.reviewLedgerSettled);
  });

  // A step output that carries `reviewLedger` and cannot be read is a wiring
  // bug. Falling back to the silent no-ledger path would hide it forever.
  it("reports a loud error when a checkpointed ledger cannot be reconstructed", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      { implement: { output: { status: "implemented", reviewLedger: { feedLite: "nope" } } } },
      prTriggerCtx(),
    );

    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
    expect(result.output!.reviewLedgerSettled).toEqual([
      {
        threadId: "unknown",
        alias: "unknown",
        error:
          "review ledger recovery failed: the checkpointed reviewLedger output is not a durable ledger projection",
      },
    ]);
    expectOutputConformsToRegistry("finalize_workspace", result.output!);
  });

  it("prefers the live ledger over a checkpointed one", async () => {
    const settleReviewThread = vi.fn(async (_input: SettleReviewThreadInput) => ({
      action: "replied" as const,
    }));
    mocks.createRepositoryVCS.mockReturnValue({ settleReviewThread });

    await execute(
      makeNode("finalize_workspace"),
      {
        implement: {
          output: durableLedgerOutput([
            {
              threadId: "th-stale",
              alias: "T1",
              source: "human",
              resolvable: true,
              awaitingHuman: false,
              snapshotAt: "2026-08-21T10:05:00.000Z",
            },
          ]),
        },
      },
      prTriggerCtx(ledgerState()),
    );

    expect(
      settleReviewThread.mock.calls.map((call) => call[0]!.thread.threadId),
    ).toEqual(["th-1", "th-2"]);
  });

  // Without this the publisher cannot tell a run that answered every thread
  // without touching code from a model that skipped the work, and the honest
  // run dies on "Agent reported success but made no commits".
  it("hands the publish guard the ledger summary, on both the hot and the cold path", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      settleReviewThread: vi.fn(async () => ({ action: "replied" as const })),
    });

    await execute(makeNode("finalize_workspace"), {}, prTriggerCtx(ledgerState()));
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewLedger: {
          workItems: [
            { alias: "T1", threadId: "th-1" },
            { alias: "T2", threadId: "th-2" },
          ],
          acceptedAliases: ["T1", "T2"],
          actionableAliases: ["T1"],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: true,
        },
      }),
    );

    mocks.finalizeWorkspacePublication.mockClear();
    await execute(
      makeNode("finalize_workspace"),
      { implement: { output: durableLedgerOutput() } },
      prTriggerCtx(),
    );
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewLedger: expect.objectContaining({ actionableAliases: ["T1"] }),
      }),
    );
  });

  it("leaves the publish guard alone on a run without a ledger", async () => {
    await execute(makeNode("finalize_workspace"), {}, prTriggerCtx());

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.not.objectContaining({ reviewLedger: expect.anything() }),
    );
  });

  it("does not settle on a ticket run that somehow carries a ledger", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({
        selectedRepositories: [repo],
        workspaceManifest: trustedManifest,
        reviewLedger: ledgerState(),
      }),
    );

    expect(result.output).toEqual({
      status: "finalized",
      repositories: finalized.repositories,
    });
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });
});
