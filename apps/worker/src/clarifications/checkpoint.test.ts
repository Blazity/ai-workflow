import { describe, expect, it } from "vitest";
import type { ClarificationRuntimeContext } from "../db/clarifications-schema.js";
import {
  checkpointRuntimeContextForPersistence,
  checkpointSourceHeads,
  checkpointStepsForPersistence,
  restoreCheckpointSandboxReferences,
  researchPlanFromCheckpoint,
} from "./checkpoint.js";

describe("clarification checkpoint payload safety", () => {
  it("fails visibly instead of silently changing a secret-shaped binding output", () => {
    expect(() =>
      checkpointStepsForPersistence({
        source: {
          output: {
            status: "ok",
            continuation_token: "opaque-value",
          },
        },
      }),
    ).toThrow(/cannot persist secret-like output.*source\.output\.continuation_token/i);
  });

  it("fails visibly instead of truncating outputs needed by downstream bindings", () => {
    expect(() =>
      checkpointStepsForPersistence({
        node: { output: { status: "ok", value: "x".repeat(300_000) } },
      }),
    ).toThrow(/checkpoint outputs exceed/i);
  });

  it("rewrites only sandbox references after snapshot restoration", () => {
    const restored = restoreCheckpointSandboxReferences(
      {
        prepare: {
          output: {
            status: "ready",
            sandboxId: "sbx-source",
            workspaceId: "sbx-source",
            workspace: { id: "sbx-source", repositories: ["github:acme/api"] },
            note: "sbx-source is mentioned in prose and must stay unchanged",
          },
        },
      },
      "sbx-source",
      "sbx-restored",
    );
    expect(restored.prepare.output).toEqual({
      status: "ready",
      sandboxId: "sbx-restored",
      workspaceId: "sbx-restored",
      workspace: { id: "sbx-restored", repositories: ["github:acme/api"] },
      note: "sbx-source is mentioned in prose and must stay unchanged",
    });
  });

  it("persists the bounded non-secret runtime state needed after replay-free resume", () => {
    const runtimeContext: ClarificationRuntimeContext = {
      preSandboxAdditions: { research: [], implementation: [], review: [] },
      implementationKind: "codex",
      implementationModel: "gpt-5-codex",
      publication: {
        status: "published",
        attemptId: "attempt-96",
        repositories: [],
        pushResult: { pushed: true, repositories: [] },
        prs: [{
          provider: "github",
          repoPath: "acme/api",
          id: 96,
          url: "https://github.com/acme/api/pull/96",
          branch: "codex/aiw-96",
          isNew: true,
        }],
      },
      clarifications: [{
        questions: ["Which region?"],
        answer: "eu-central",
        answeredBy: "Alice",
        answeredAt: "2026-07-18T00:00:00.000Z",
      }],
      phaseUsages: {
        Impl: {
          cost_usd: null,
          tokens: { input: 100, cached_input: 25, output: 50 },
          duration_ms: 60_000,
          duration_api_ms: 55_000,
          num_turns: 2,
        },
      },
      phaseModels: { Impl: "gpt-5-codex" },
      activeModel: "gpt-5-codex",
      prForTelemetry: { url: "https://github.com/acme/api/pull/96", number: 96 },
    };

    const persisted = checkpointRuntimeContextForPersistence(runtimeContext);

    expect(persisted).toEqual(runtimeContext);
    expect(persisted).not.toBe(runtimeContext);
  });

  it("rejects secret-shaped or oversized runtime checkpoint state", () => {
    expect(() => checkpointRuntimeContextForPersistence({
      preSandboxAdditions: { research: [], implementation: [], review: [] },
      apiKey: "must-not-be-persisted",
    } as unknown as ClarificationRuntimeContext)).toThrow(/cannot persist secret-like.*apiKey/i);
    expect(() => checkpointRuntimeContextForPersistence({
      preSandboxAdditions: { research: [], implementation: [], review: [] },
      clarifications: [{ questions: ["Q"], answer: "x".repeat(300_000) }],
    })).toThrow(/runtime context exceeds/i);
  });

  it("derives exact source heads and the last completed research plan", () => {
    const manifest = {
      version: 1 as const,
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/api",
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "ai/AIW-96",
          selectedRationale: "scope",
          preAgentSha: "abc123",
        },
      ],
    };
    expect(checkpointSourceHeads(manifest)).toEqual([
      { provider: "github", repoPath: "acme/api", sha: "abc123" },
    ]);
    expect(
      researchPlanFromCheckpoint({
        first: { output: { status: "ready", plan: "old" } },
        second: { output: { status: "ready", plan: "latest" } },
      }),
    ).toBe("latest");
  });
});
