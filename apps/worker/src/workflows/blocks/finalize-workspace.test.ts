import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ finalizeWorkspacePublication: vi.fn() }));

vi.mock("../workspace-publication.js", () => ({
  finalizeWorkspacePublication: mocks.finalizeWorkspacePublication,
}));

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
      // attribute rather than being left to guess, and that nothing failed:
      // the missing-gate sentence must not say the scripts "may have passed"
      // above a list of commands that did not.
      scriptDrift: [],
      scriptsFailed: false,
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
      expect.objectContaining({ scriptsFailed: true }),
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
