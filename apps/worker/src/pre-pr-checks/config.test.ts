import { describe, expect, it } from "vitest";
import { describePrePrCheckIssues, prePrCheckConfigSchema } from "./config.js";

describe("prePrCheckConfigSchema", () => {
  it("accepts per-repo check commands", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [
        { provider: "github", repoPath: "acme/web", commands: ["pnpm typecheck", "pnpm test"] },
        { provider: "gitlab", repoPath: "acme/api", commands: ["bun test"] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty repository list (gate disabled)", () => {
    expect(prePrCheckConfigSchema.safeParse({ repositories: [] }).success).toBe(true);
  });

  it("rejects a repository with no commands", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [{ provider: "github", repoPath: "acme/web", commands: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys and bad providers", () => {
    expect(
      prePrCheckConfigSchema.safeParse({
        repositories: [{ provider: "svn", repoPath: "acme/web", commands: ["make"] }],
      }).success,
    ).toBe(false);
    expect(
      prePrCheckConfigSchema.safeParse({ repositories: [], extra: true }).success,
    ).toBe(false);
  });

  it("formats issues with their path", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [{ provider: "github", repoPath: "", commands: ["x"] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describePrePrCheckIssues(result.error)).toContain("repositories.0.repoPath");
    }
  });
});
