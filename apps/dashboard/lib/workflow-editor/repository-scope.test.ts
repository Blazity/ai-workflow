import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addPinnedRepositories,
  contradictingPinnedRepositories,
  describeRepositoryScope,
  effectiveScopeProviders,
  isRepositoryScopeEmpty,
  MAX_PINNED_REPOSITORIES,
  normalizeRepositoryScope,
  removePinnedRepository,
  repositoryScopeFromDefinition,
  togglePinnedProvider,
} from "./repository-scope.ts";

test("a definition without a pin seeds an empty scope", () => {
  const scope = repositoryScopeFromDefinition({
    schemaVersion: 1,
    nodes: [],
    edges: [],
  });
  assert.deepEqual(scope, {});
  assert.equal(isRepositoryScopeEmpty(scope), true);
});

test("an explicitly empty pin is indistinguishable from no pin", () => {
  const scope = repositoryScopeFromDefinition({
    schemaVersion: 1,
    repositoryScope: { repositories: [], providers: [] },
    nodes: [],
    edges: [],
  });
  assert.deepEqual(scope, {});
  assert.equal(isRepositoryScopeEmpty(scope), true);
});

test("a saved pin round-trips with its stored casing and canonical provider order", () => {
  const scope = repositoryScopeFromDefinition({
    schemaVersion: 2,
    repositoryScope: {
      repositories: [{ provider: "gitlab", repoPath: "Group/Sub/App" }],
      providers: ["gitlab", "github"],
    },
    nodes: [],
    edges: [],
  });
  assert.deepEqual(scope, {
    repositories: [{ provider: "gitlab", repoPath: "Group/Sub/App" }],
    providers: ["github", "gitlab"],
  });
});

test("duplicate repositories collapse case-insensitively and keep the first casing", () => {
  const scope = normalizeRepositoryScope({
    repositories: [
      { provider: "github", repoPath: "Blazity/ai-workflow" },
      { provider: "github", repoPath: "blazity/AI-Workflow" },
      { provider: "gitlab", repoPath: "blazity/ai-workflow" },
      { provider: "github", repoPath: "   " },
    ],
  });
  assert.deepEqual(scope.repositories, [
    { provider: "github", repoPath: "Blazity/ai-workflow" },
    { provider: "gitlab", repoPath: "blazity/ai-workflow" },
  ]);
});

test("the workspace limit caps a pin instead of growing past it", () => {
  const many = Array.from({ length: 12 }, (_value, index) => ({
    provider: "github" as const,
    repoPath: `owner/repo-${index}`,
  }));
  const scope = addPinnedRepositories({}, many);
  assert.equal(scope.repositories?.length, MAX_PINNED_REPOSITORIES);
  assert.equal(scope.repositories?.at(-1)?.repoPath, "owner/repo-7");

  const overflowed = addPinnedRepositories(scope, [
    { provider: "github", repoPath: "owner/late" },
  ]);
  assert.equal(overflowed.repositories?.length, MAX_PINNED_REPOSITORIES);
  assert.equal(
    overflowed.repositories?.some((repo) => repo.repoPath === "owner/late"),
    false,
  );
});

test("removing the last repository leaves no empty collection behind", () => {
  const pinned = addPinnedRepositories({}, [
    { provider: "github", repoPath: "owner/repo" },
  ]);
  const cleared = removePinnedRepository(pinned, {
    provider: "github",
    repoPath: "OWNER/REPO",
  });
  assert.deepEqual(cleared, {});
});

test("providers toggle to a canonical order and clear to an absent key", () => {
  const gitlabOnly = togglePinnedProvider({}, "gitlab");
  assert.deepEqual(gitlabOnly, { providers: ["gitlab"] });

  const both = togglePinnedProvider(gitlabOnly, "github");
  assert.deepEqual(both, { providers: ["github", "gitlab"] });

  const backToGitlab = togglePinnedProvider(both, "github");
  assert.deepEqual(backToGitlab, { providers: ["gitlab"] });
  assert.deepEqual(togglePinnedProvider(backToGitlab, "gitlab"), {});
});

test("providers are inherited from pinned repositories when not pinned explicitly", () => {
  const scope = addPinnedRepositories({}, [
    { provider: "gitlab", repoPath: "group/app" },
    { provider: "github", repoPath: "owner/repo" },
  ]);
  assert.deepEqual(effectiveScopeProviders(scope), ["github", "gitlab"]);
  assert.deepEqual(
    effectiveScopeProviders({ ...scope, providers: ["github"] }),
    ["github"],
  );
});

test("a provider pin that excludes a pinned repository is reported as contradicting", () => {
  const github = { provider: "github" as const, repoPath: "Blazity/ai-workflow-prod" };
  const gitlab = { provider: "gitlab" as const, repoPath: "acme-group/platform/billing-core" };

  assert.deepEqual(
    contradictingPinnedRepositories({ repositories: [github, gitlab] }),
    [],
    "no provider pin excludes nothing",
  );
  assert.deepEqual(
    contradictingPinnedRepositories({
      repositories: [github, gitlab],
      providers: ["gitlab"],
    }),
    [github],
  );
  assert.deepEqual(
    contradictingPinnedRepositories({
      repositories: [github, gitlab],
      providers: ["github", "gitlab"],
    }),
    [],
  );
});

test("the toolbar summary never asserts a provider its own repositories contradict", () => {
  const scope = {
    repositories: [{ provider: "github" as const, repoPath: "Blazity/ai-workflow-prod" }],
    providers: ["gitlab" as const],
  };

  assert.equal(describeRepositoryScope(scope), "1 repo, provider mismatch");
  assert.equal(
    describeRepositoryScope({ ...scope, providers: ["github", "gitlab"] }),
    "1 repo, GitHub + GitLab",
  );
});

test("the toolbar summary names the repository count and the effective providers", () => {
  assert.equal(describeRepositoryScope({}), null);
  assert.equal(
    describeRepositoryScope(
      addPinnedRepositories({}, [{ provider: "github", repoPath: "owner/repo" }]),
    ),
    "1 repo, GitHub",
  );
  assert.equal(
    describeRepositoryScope(
      addPinnedRepositories({}, [
        { provider: "github", repoPath: "owner/repo" },
        { provider: "gitlab", repoPath: "group/app" },
      ]),
    ),
    "2 repos, GitHub + GitLab",
  );
  assert.equal(
    describeRepositoryScope({ providers: ["github", "gitlab"] }),
    "GitHub + GitLab",
  );
});
