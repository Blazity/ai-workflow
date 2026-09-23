/**
 * The repository picker when this deployment's own settings could not be read.
 * It used to show every provider "not connected", from an empty listing, and
 * keep showing it for a minute from the cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listVcsRepositories = vi.hoisted(() => vi.fn());
vi.mock("../../engine/support/vcs-runtime.js", () => ({ listVcsRepositories }));

const { IntegrationSettingsUnreadableError } = await import("../integrations/usable.js");
const { listCachedRepositoryDirectory, resetRepositoryDirectoryCacheForTests } = await import(
  "./directory.js"
);

beforeEach(() => {
  listVcsRepositories.mockReset();
  resetRepositoryDirectoryCacheForTests();
});

describe("the repository directory when the settings could not be read", () => {
  it("says so for every provider instead of calling them not connected", async () => {
    listVcsRepositories.mockRejectedValue(
      new IntegrationSettingsUnreadableError("so no repository could be listed", "connection terminated"),
    );

    const directory = await listCachedRepositoryDirectory();

    expect(directory.repositories).toEqual([]);
    expect(directory.providers.length).toBeGreaterThan(0);
    for (const provider of directory.providers) {
      expect(provider).toMatchObject({
        status: "error",
        error: expect.stringContaining("integration settings could not be read"),
      });
    }
    expect(JSON.stringify(directory)).not.toContain("connection terminated");
  });

  it("does not keep that answer: the next open asks again", async () => {
    listVcsRepositories
      .mockRejectedValueOnce(
        new IntegrationSettingsUnreadableError("so no repository could be listed", "connection terminated"),
      )
      .mockResolvedValueOnce({ repositories: [], providers: ["github"], failures: [] });

    await listCachedRepositoryDirectory();
    const next = await listCachedRepositoryDirectory();

    expect(listVcsRepositories).toHaveBeenCalledTimes(2);
    expect(next.providers).toContainEqual({ provider: "github", status: "ready" });
  });
});
