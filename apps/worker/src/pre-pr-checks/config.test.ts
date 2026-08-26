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
  it("refuses an empty gateGroups instead of silently disabling the gate", () => {
    // [] is not nullish, so resolveGateGroups would return it unchanged and the
    // publication gate would run zero groups and pass every run forever, with
    // ok true and nothing verified. Omitting the field is how you say "all".
    const withGateGroups = (gateGroups: string[] | undefined) =>
      repoScriptsConfigSchema.safeParse({
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            groups: { test: { commands: ["pnpm test"] } },
            ...(gateGroups === undefined ? {} : { gateGroups }),
          },
        ],
      });

    expect(withGateGroups([]).success).toBe(false);
    expect(withGateGroups(["test"]).success).toBe(true);
    expect(withGateGroups(undefined).success).toBe(true);
  });

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
      // Reported from the code-point-first group, not from whichever key the
      // store handed back first, so the same broken config always names the
      // same rotation of the cycle.
      expect(describePrePrCheckIssues(result.error)).toContain("test -> verify -> test");
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
    // Bounded above too. The ceiling is added to a sandbox lifetime, so a
    // number that overflows it buys a workspace that disappears mid-batch
    // rather than a batch that reports how far it got.
    expect(
      repoScriptsConfigSchema.safeParse({ repositories: [validRepo], batchTimeoutMinutes: 180 })
        .success,
    ).toBe(true);
    expect(
      repoScriptsConfigSchema.safeParse({ repositories: [validRepo], batchTimeoutMinutes: 181 })
        .success,
    ).toBe(false);
    // Only the phase ceiling is capped: a per-command override is not, because
    // it is bounded by the ceiling it runs inside.
    expect(
      repoScriptsConfigSchema.safeParse({
        repositories: [{ ...validRepo, commandTimeoutMinutes: 600 }],
      }).success,
    ).toBe(true);
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
    expect(expandGroupCommands(repo, ["verify"])).toEqual([
      { command: "pnpm test", group: "test" },
      { command: "pnpm lint", group: "lint" },
      { command: "pnpm build", group: "verify" },
    ]);
  });

  it("names the group that declares a command, not the one whose expansion reached it", () => {
    // The whole point of the owner. `pnpm install` is deduplicated into one
    // run, and blaming its failure on whichever selected group happened to
    // pull it in sent an operator to read `verify` for a broken deps install.
    const repo: RepoScriptsRepositoryConfig = {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        deps: { commands: ["pnpm install"] },
        lint: { commands: ["pnpm lint"], extends: ["deps"] },
        unit: { commands: ["pnpm unit"], extends: ["deps"] },
        verify: { commands: [], extends: ["lint", "unit"] },
      },
    };

    expect(expandGroupCommands(repo, ["verify"])).toEqual([
      { command: "pnpm install", group: "deps" },
      { command: "pnpm lint", group: "lint" },
      { command: "pnpm unit", group: "unit" },
    ]);
    // Same owners whoever asks: the second selector reaches the same commands.
    expect(expandGroupCommands(repo, ["unit"])).toEqual([
      { command: "pnpm install", group: "deps" },
      { command: "pnpm unit", group: "unit" },
    ]);
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
  it("defaults to every group name in code-point order, whatever order they were authored in", () => {
    // Groups are a set. The config is stored as jsonb, which reorders object
    // keys on the way back out, so authored order is not something the gate
    // can read: one sort everywhere is what makes the order reproducible.
    const repo: RepoScriptsRepositoryConfig = {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        zeta: { commands: ["pnpm zeta"] },
        alpha: { commands: ["pnpm alpha"] },
        mid: { commands: ["pnpm mid"] },
      },
    };
    expect(resolveGateGroups(repo)).toEqual(["alpha", "mid", "zeta"]);
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
