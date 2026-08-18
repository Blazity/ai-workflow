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

  it("accepts a stored config with no setup key and defaults it to empty", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [{ provider: "github", repoPath: "acme/web", commands: ["pnpm test"] }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories[0]!.setup).toEqual([]);
    }
  });

  it("accepts per-repo setup commands and keeps their order", () => {
    const result = prePrCheckConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          setup: ["make bootstrap", "make deps"],
          commands: ["make lint"],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories[0]!.setup).toEqual(["make bootstrap", "make deps"]);
    }
  });

  it("accepts an empty setup list but rejects a blank setup command", () => {
    expect(
      prePrCheckConfigSchema.safeParse({
        repositories: [
          { provider: "github", repoPath: "acme/web", setup: [], commands: ["pnpm test"] },
        ],
      }).success,
    ).toBe(true);
    expect(
      prePrCheckConfigSchema.safeParse({
        repositories: [
          { provider: "github", repoPath: "acme/web", setup: ["   "], commands: ["pnpm test"] },
        ],
      }).success,
    ).toBe(false);
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
