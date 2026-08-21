import { describe, expect, it } from "vitest";
import {
  describePrePrCheckIssues,
  emptyRepoScriptsConfig,
  expandGroupCommands,
  prePrCheckConfigSchema,
  repoScriptsConfigSchema,
  resolveGateGroups,
  type RepoScriptsRepositoryConfig,
} from "./config.js";

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

describe("repoScriptsConfigSchema", () => {
  it("normalizes a legacy repository entry (no groups key) to groups.checks", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        { provider: "github", repoPath: "acme/web", commands: ["pnpm test", "pnpm lint"] },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            setup: [],
            env: [],
            groups: {
              checks: { commands: ["pnpm test", "pnpm lint"], restoreTree: true },
            },
          },
        ],
      });
    }
  });

  it("parses a mixed repositories[] array (one legacy entry, one new-shape entry)", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        { provider: "github", repoPath: "acme/web", commands: ["pnpm test", "pnpm lint"] },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          env: ["GITLAB_UNIFY_FRONTEND_TOKEN"],
          groups: { test: { commands: ["uv run pytest"] } },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            setup: [],
            env: [],
            groups: {
              checks: { commands: ["pnpm test", "pnpm lint"], restoreTree: true },
            },
          },
          {
            provider: "gitlab",
            repoPath: "acme/api",
            setup: [],
            env: ["GITLAB_UNIFY_FRONTEND_TOKEN"],
            groups: { test: { commands: ["uv run pytest"], restoreTree: true } },
          },
        ],
      });
    }
  });

  it("accepts the new shape with groups, env, gateGroups, and timeouts", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "gitlab",
          repoPath: "acme/api",
          setup: ["uv sync"],
          env: ["GITLAB_UNIFY_FRONTEND_TOKEN"],
          groups: {
            test: { commands: ["pytest"] },
            lint: { commands: ["ruff check ."] },
          },
          gateGroups: ["test"],
          commandTimeoutMinutes: 15,
        },
      ],
      batchTimeoutMinutes: 30,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        repositories: [
          {
            provider: "gitlab",
            repoPath: "acme/api",
            setup: ["uv sync"],
            env: ["GITLAB_UNIFY_FRONTEND_TOKEN"],
            groups: {
              test: { commands: ["pytest"], restoreTree: true },
              lint: { commands: ["ruff check ."], restoreTree: true },
            },
            gateGroups: ["test"],
            commandTimeoutMinutes: 15,
          },
        ],
        batchTimeoutMinutes: 30,
      });
    }
  });

  it("defaults restoreTree to true and accepts an explicit false", () => {
    // The default is what makes a group safe by omission: a group that says
    // nothing about the tree must not be the one that leaves it edited.
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: {
            test: { commands: ["pnpm test"] },
            format: { commands: ["prettier --write ."], restoreTree: false },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories[0]!.groups).toEqual({
        test: { commands: ["pnpm test"], restoreTree: true },
        format: { commands: ["prettier --write ."], restoreTree: false },
      });
    }
  });

  it("rejects a restoreTree that is not a boolean", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: { test: { commands: ["pnpm test"], restoreTree: "no" } },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a group with only extends and no commands of its own", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: {
            test: { commands: ["pnpm test"] },
            lint: { commands: ["pnpm lint"] },
            verify: { commands: [], extends: ["test", "lint"] },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a group with neither commands nor extends", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: { empty: { commands: [] } },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a repository with an empty groups object", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [{ provider: "github", repoPath: "acme/web", groups: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a cycle in extends and names the cycle path", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: {
            verify: { commands: [], extends: ["test"] },
            test: { commands: [], extends: ["verify"] },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describePrePrCheckIssues(result.error)).toContain("verify -> test -> verify");
    }
  });

  it("rejects an extends reference to an unknown group", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: { verify: { commands: [], extends: ["missing"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describePrePrCheckIssues(result.error)).toContain(
        'unknown group referenced in extends: "missing"',
      );
    }
  });

  it("rejects a gateGroups reference to an unknown group", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: { checks: { commands: ["pnpm test"] } },
          gateGroups: ["missing"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describePrePrCheckIssues(result.error)).toContain(
        'unknown group referenced in gateGroups: "missing"',
      );
    }
  });

  it("rejects an env name that is not SCREAMING_SNAKE_CASE", () => {
    const result = repoScriptsConfigSchema.safeParse({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          env: ["not_valid"],
          groups: { checks: { commands: ["pnpm test"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts integer timeouts >= 1 and rejects 0 or fractional minutes", () => {
    const validRepo = {
      provider: "github" as const,
      repoPath: "acme/web",
      groups: { checks: { commands: ["pnpm test"] } },
      commandTimeoutMinutes: 5,
    };
    expect(
      repoScriptsConfigSchema.safeParse({ repositories: [validRepo], batchTimeoutMinutes: 30 })
        .success,
    ).toBe(true);
    expect(
      repoScriptsConfigSchema.safeParse({
        repositories: [{ ...validRepo, commandTimeoutMinutes: 0 }],
      }).success,
    ).toBe(false);
    expect(
      repoScriptsConfigSchema.safeParse({
        repositories: [{ ...validRepo, commandTimeoutMinutes: 1.5 }],
      }).success,
    ).toBe(false);
    expect(
      repoScriptsConfigSchema.safeParse({ repositories: [validRepo], batchTimeoutMinutes: 0 })
        .success,
    ).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(
      repoScriptsConfigSchema.safeParse({ repositories: [], extra: true }).success,
    ).toBe(false);
  });

  it("emptyRepoScriptsConfig is an empty repository list", () => {
    expect(emptyRepoScriptsConfig).toEqual({ repositories: [] });
  });
});

describe("expandGroupCommands", () => {
  it("expands a composite group depth-first, deduplicating shared commands", () => {
    const repo: RepoScriptsRepositoryConfig = {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        test: { commands: ["pnpm test"] },
        lint: { commands: ["pnpm lint", "pnpm test"] },
        verify: { commands: ["pnpm build"], extends: ["test", "lint"] },
      },
    };
    expect(expandGroupCommands(repo, ["verify"])).toEqual(["pnpm test", "pnpm lint", "pnpm build"]);
  });

  it("throws a plain Error naming an unknown group", () => {
    const repo: RepoScriptsRepositoryConfig = {
      provider: "github",
      repoPath: "acme/web",
      groups: { checks: { commands: ["pnpm test"] } },
    };
    expect(() => expandGroupCommands(repo, ["missing"])).toThrow('unknown group: "missing"');
  });
});

describe("resolveGateGroups", () => {
  it("defaults to all group names in insertion order", () => {
    const repo: RepoScriptsRepositoryConfig = {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        lint: { commands: ["pnpm lint"] },
        test: { commands: ["pnpm test"] },
        build: { commands: ["pnpm build"] },
      },
    };
    expect(resolveGateGroups(repo)).toEqual(["lint", "test", "build"]);
  });

  it("returns gateGroups when configured", () => {
    const repo: RepoScriptsRepositoryConfig = {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        lint: { commands: ["pnpm lint"] },
        test: { commands: ["pnpm test"] },
      },
      gateGroups: ["test"],
    };
    expect(resolveGateGroups(repo)).toEqual(["test"]);
  });
});
