import assert from "node:assert/strict";
import test from "node:test";

import { pullRequestAuthors, pullRequestOfSubject, traceEntries } from "./history.ts";
import { createTestRepository } from "./test-repository.ts";

test("an entry is traced to the commit that added it and to the pull request that merged it", async () => {
  const repo = await createTestRepository();
  try {
    await repo.mergePullRequest(12, [
      { files: { "apps/worker/src/engine/run.ts": "x" }, subject: "feat(worker): run faster" },
      {
        files: {
          "apps/dashboard/components/panel.tsx": "x",
          "changelog/unreleased/panel.md": "- A ticket page has a Repositories panel.\n",
        },
        subject: "feat(dashboard): add the panel",
      },
      { files: { "integrations/jira/a.ts": "x" }, subject: "feat(integrations): later work in the same pull request" },
    ]);
    // Squash-merged straight onto main.
    await repo.commit("feat(mcp): read the catalog (#15)", {
      "apps/worker/src/mcp/catalog.ts": "x",
      "changelog/unreleased/catalog.md": "- MCP tools read the catalog.\n",
    });
    // Pushed to main without a pull request.
    await repo.commit("docs(changelog): note a change", { "changelog/unreleased/direct.md": "- Something.\n" });

    const origins = await traceEntries({ fileNames: ["panel.md", "catalog.md", "direct.md", "missing.md"], ref: "HEAD", root: repo.root });

    assert.equal(origins[0].pullRequest, 12);
    assert.equal(origins[0].commitSubject, "feat(dashboard): add the panel");
    assert.deepEqual(origins[0].commitPaths.sort(), ["apps/dashboard/components/panel.tsx", "changelog/unreleased/panel.md"]);
    assert.deepEqual(origins[0].pullRequestPaths.sort(), [
      "apps/dashboard/components/panel.tsx",
      "apps/worker/src/engine/run.ts",
      "changelog/unreleased/panel.md",
      "integrations/jira/a.ts",
    ]);

    assert.equal(origins[1].pullRequest, 15);
    assert.deepEqual(origins[1].pullRequestPaths.sort(), ["apps/worker/src/mcp/catalog.ts", "changelog/unreleased/catalog.md"]);

    assert.equal(origins[2].pullRequest, undefined);
    assert.equal(origins[2].commitSubject, "docs(changelog): note a change");

    assert.deepEqual(origins[3], { commitPaths: [], fileName: "missing.md", pullRequestPaths: [] });
  } finally {
    await repo.cleanup();
  }
});

test("tracing reads history as of the collated commit, not whatever main became later", async () => {
  const repo = await createTestRepository();
  try {
    await repo.mergePullRequest(20, [
      { files: { "changelog/unreleased/a.md": "- A.\n", "apps/dashboard/a.tsx": "x" }, subject: "feat(dashboard): a" },
    ]);
    const collated = repo.git("rev-parse", "HEAD");
    await repo.mergePullRequest(21, [{ files: { "changelog/unreleased/b.md": "- B.\n" }, subject: "feat(dashboard): b" }]);

    const [a, b] = await traceEntries({ fileNames: ["a.md", "b.md"], ref: collated, root: repo.root });
    assert.equal(a.pullRequest, 20);
    assert.equal(b.commitSha, undefined, "an entry merged after the collated commit is not part of that release");
  } finally {
    await repo.cleanup();
  }
});

test("pull request numbers come from merge and squash subjects only", () => {
  assert.equal(pullRequestOfSubject("Merge pull request #506 from Blazity/chore/changelog-2026-09-20"), 506);
  assert.equal(pullRequestOfSubject("fix(dashboard): lay out a replayed graph that carries no positions (#507)"), 507);
  assert.equal(pullRequestOfSubject("fix(dashboard): mention #507 in passing"), undefined);
});

test("an author lookup that fails leaves that author out and says why", async () => {
  const messages: string[] = [];
  const authors = await pullRequestAuthors({
    log: (message) => messages.push(message),
    numbers: [1, 2, 1],
    repository: "Blazity/ai-workflow",
    root: ".",
    run: async (_command, args) => {
      if (args[1].endsWith("/2")) throw new Error("HTTP 404: Not Found");
      return "octocat\n";
    },
  });
  assert.deepEqual([...authors], [[1, "octocat"]]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /author of #2: HTTP 404/u);
});
