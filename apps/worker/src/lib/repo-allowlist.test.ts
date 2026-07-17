import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { warn: mocks.warn, error: mocks.error, info: vi.fn(), debug: vi.fn() },
}));

import { isRepoAllowed, filterAllowedRepositories } from "./repo-allowlist.js";

const ORIGINAL = process.env.AGENT_ALLOWED_REPOS;

function setAllowlist(value: string | undefined): void {
  if (value === undefined) delete process.env.AGENT_ALLOWED_REPOS;
  else process.env.AGENT_ALLOWED_REPOS = value;
}

afterEach(() => {
  setAllowlist(ORIGINAL);
  vi.clearAllMocks();
});

describe("repo-allowlist validation and fail-open warnings", () => {
  it("warns once at error level and ignores a malformed entry, keeping valid ones", () => {
    setAllowlist("acme/api, not-a-repo, acme/web/extra");

    // Valid entries still gate as before.
    expect(isRepoAllowed("acme/api")).toBe(true);
    expect(isRepoAllowed("acme/web")).toBe(false);
    // Second call must not re-log the same bad entries (one-time-per-entry dedupe).
    expect(isRepoAllowed("acme/api")).toBe(true);

    expect(mocks.error).toHaveBeenCalledTimes(2);
    const loggedEntries = mocks.error.mock.calls.map((call) => call[0].entry);
    expect(loggedEntries).toContain("not-a-repo");
    expect(loggedEntries).toContain("acme/web/extra");
    // A partially-valid allowlist is still a restriction, not fail-open.
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("warns once when the allowlist is empty (fail-open state is visible)", () => {
    setAllowlist("");
    expect(isRepoAllowed("acme/anything")).toBe(true);
    // Repeated checks do not re-warn.
    expect(isRepoAllowed("other/repo")).toBe(true);

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1]).toMatch(/AGENT_ALLOWED_REPOS is empty/);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("filters valid entries without warning and drops off-list repos", () => {
    setAllowlist("acme/api,acme/web");
    const result = filterAllowedRepositories([
      { repoPath: "Acme/API" },
      { repoPath: "acme/other" },
      { repoPath: "acme/web" },
    ]);
    expect(result).toEqual([{ repoPath: "Acme/API" }, { repoPath: "acme/web" }]);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
