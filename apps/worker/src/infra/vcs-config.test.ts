import { describe, expect, it, vi } from "vitest";
import { findSettingDefinition } from "@shared/contracts";

// The parsed environment validates the whole schema at import, which a test
// machine does not satisfy. Only the constant below is under test here.
vi.mock("./runtime-env.js", () => ({ env: {} }));

const { DEFAULT_BASE_BRANCH } = await import("./vcs-config.js");

describe("legacy base branch", () => {
  it("falls back to what the registry defaults to", () => {
    // The constant is repeated in `infra/` because ADR-001 gives that tier no
    // outgoing edges, so it cannot import the registry that declares it. This
    // is the pin that keeps the copy honest: a registry default changed on its
    // own would otherwise leave the legacy single-repository path targeting a
    // branch nobody configured.
    expect(findSettingDefinition("GITHUB_BASE_BRANCH")?.default).toBe(
      DEFAULT_BASE_BRANCH,
    );
    expect(findSettingDefinition("GITLAB_BASE_BRANCH")?.default).toBe(
      DEFAULT_BASE_BRANCH,
    );
  });
});
