import { describe, expect, it } from "vitest";
import {
  checkpointSourceHeads,
  checkpointStepsForPersistence,
  restoreCheckpointSandboxReferences,
  researchPlanFromCheckpoint,
} from "./checkpoint.js";

describe("clarification checkpoint payload safety", () => {
  it("preserves binding outputs while redacting credential-shaped fields", () => {
    const persisted = checkpointStepsForPersistence({
      trigger: { output: { status: "fired", ticketKey: "AIW-96" } },
      prepare: {
        output: {
          status: "ready",
          sandboxId: "sbx-source",
          nested: {
            API_KEY: "secret",
            authorization: "Bearer secret",
            accessToken: "secret",
            clientSecret: "secret",
            value: "safe",
          },
        },
      },
    });

    expect(persisted.prepare.output).toEqual({
      status: "ready",
      sandboxId: "sbx-source",
      nested: {
        API_KEY: "[redacted]",
        authorization: "[redacted]",
        accessToken: "[redacted]",
        clientSecret: "[redacted]",
        value: "safe",
      },
    });
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
      workspace: { id: "sbx-restored", repositories: ["github:acme/api"] },
      note: "sbx-source is mentioned in prose and must stay unchanged",
    });
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
