import { describe, expect, it } from "vitest";
import {
  emptyPrePrCheckConfig,
  parsePrePrCheckConfig,
} from "./config.js";

describe("parsePrePrCheckConfig", () => {
  it("treats missing config as no configured checks", () => {
    expect(parsePrePrCheckConfig(undefined)).toEqual(emptyPrePrCheckConfig);
  });

  it("accepts manually configured per-repo check commands", () => {
    const config = parsePrePrCheckConfig(JSON.stringify({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          commands: ["pnpm typecheck", "pnpm test"],
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          commands: ["bun test"],
        },
      ],
    }));

    expect(config.repositories).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        commands: ["pnpm typecheck", "pnpm test"],
      },
      {
        provider: "gitlab",
        repoPath: "acme/api",
        commands: ["bun test"],
      },
    ]);
  });

  it("rejects malformed config instead of guessing commands", () => {
    expect(() =>
      parsePrePrCheckConfig(JSON.stringify({
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            commands: [],
          },
        ],
      })),
    ).toThrow(/Invalid PRE_PR_CHECKS/);
  });
});
