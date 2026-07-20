import { describe, expect, it } from "vitest";
import { resolveVcsBotLogin } from "./vcs-bot-identity.js";

describe("resolveVcsBotLogin", () => {
  it("trims and case-normalizes a provider-specific login", () => {
    expect(
      resolveVcsBotLogin("github", ["github"], {
        github: "  GitHub-App[Bot]  ",
      }),
    ).toBe("github-app[bot]");
  });

  it("treats whitespace-only values as unset and falls back only when unambiguous", () => {
    expect(
      resolveVcsBotLogin("gitlab", ["gitlab"], {
        gitlab: "   ",
        legacy: "  Legacy-Bot  ",
      }),
    ).toBe("legacy-bot");
    expect(
      resolveVcsBotLogin("github", ["github"], {
        github: "   ",
        legacy: "   ",
      }),
    ).toBeUndefined();
  });
});
