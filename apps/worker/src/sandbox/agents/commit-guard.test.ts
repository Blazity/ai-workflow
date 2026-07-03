import { describe, expect, it } from "vitest";
import { buildCommitGuardCheckScript } from "./commit-guard.js";

describe("buildCommitGuardCheckScript", () => {
  it("checks every repository in the workspace manifest", () => {
    const script = buildCommitGuardCheckScript({
      manifestPath: "/vercel/sandbox/aiw-repos.json",
      ignoredDirs: [".codex"],
    });

    expect(script).toContain("/vercel/sandbox/aiw-repos.json");
    expect(script).toContain("manifest.repositories");
    expect(script).toContain("git");
    expect(script).toContain("status");
  });

  it("isolates git status failures per manifest repository", () => {
    const script = buildCommitGuardCheckScript({
      manifestPath: "/vercel/sandbox/aiw-repos.json",
      ignoredDirs: [".codex"],
    });

    expect(script).toContain("try {");
    expect(script).toContain("catch (err)");
    expect(script).toContain("continue;");
  });

  it("falls back to current repository when no manifest exists", () => {
    const script = buildCommitGuardCheckScript({
      manifestPath: "/missing.json",
      ignoredDirs: [".claude"],
    });

    expect(script).toContain("git status --porcelain");
  });
});
