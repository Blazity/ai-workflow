import assert from "node:assert/strict";
import test from "node:test";

import { insertRelease } from "./collate.ts";
import { runCommand, type CommandRunner } from "./history.ts";
import type { ReleaseNotes } from "./notes.ts";
import { planPublish, publish } from "./publish.ts";
import { CHANGELOG_INTRO, createTestRepository, type TestRepository } from "./test-repository.ts";

const NOTES: ReleaseNotes = {
  areas: [{ area: "Dashboard", bullets: ["A ticket page has a Repositories panel."], summary: "Tickets show more." }],
  date: "2026-09-23",
  shortVersion: [{ area: "Dashboard", text: "Tickets list their repositories." }],
  version: "v2026.09.1",
};

/** main after one feature pull request and the collation pull request that released it. */
async function releasedRepository(): Promise<{ repo: TestRepository; collated: string }> {
  const repo = await createTestRepository();
  await repo.mergePullRequest(30, [
    {
      files: { "apps/dashboard/panel.tsx": "x", "changelog/unreleased/panel.md": "- A ticket page has a Repositories panel.\n" },
      subject: "feat(dashboard): add the panel",
    },
  ]);
  const collated = repo.git("rev-parse", "HEAD");
  repo.git("switch", "--quiet", "-c", "chore/changelog-2026-09-23");
  repo.git("rm", "--quiet", "changelog/unreleased/panel.md");
  await repo.commit("docs(changelog): release v2026.09.1", { "CHANGELOG.md": insertRelease(CHANGELOG_INTRO, NOTES) });
  repo.git("switch", "--quiet", "main");
  // main moves on before the collation pull request merges.
  await repo.commit("chore(repo): unrelated (#32)", { "README.md": "x" });
  repo.git("merge", "--quiet", "--no-ff", "chore/changelog-2026-09-23", "-m", "Merge pull request #31 from Blazity/chore/changelog-2026-09-23");
  return { collated, repo };
}

function fakeGh(options: { released: boolean; calls: string[][] }): CommandRunner {
  return async (command, args, cwd) => {
    if (command !== "gh") return runCommand(command, args, cwd);
    options.calls.push(args);
    if (args[0] === "api") return "filipmaszota\n";
    if (args[0] === "release" && args[1] === "view") {
      if (options.released) return "{}";
      throw new Error("release not found");
    }
    return "";
  };
}

test("the release tags the main commit the collation read and credits each bullet's pull request", async () => {
  const { collated, repo } = await releasedRepository();
  try {
    const calls: string[][] = [];
    const run = fakeGh({ calls, released: false });
    const plan = await planPublish({ log: () => {}, repository: "Blazity/ai-workflow", root: repo.root, run });

    assert.ok(plan);
    assert.equal(plan.version, "v2026.09.1");
    assert.equal(plan.action, "create");
    assert.equal(plan.target, collated, "the tag points at the main commit the collation read, not the later merge");
    assert.match(plan.body, /## The short version\n\n\*\*Dashboard:\*\* Tickets list their repositories\./u);
    assert.match(
      plan.body,
      /\* A ticket page has a Repositories panel\. \(in \[#30\]\(https:\/\/github\.com\/Blazity\/ai-workflow\/pull\/30\) by \[@filipmaszota\]\(https:\/\/github\.com\/filipmaszota\)/u,
    );
    assert.match(plan.body, /\*\*Full Changelog\*\*: https:\/\/github\.com\/Blazity\/ai-workflow\/commits\/v2026\.09\.1/u);

    await publish(plan, { repository: "Blazity/ai-workflow", root: repo.root, run });
    const create = calls.find((args) => args[0] === "release" && args[1] === "create");
    assert.deepEqual(create?.slice(0, 6), ["release", "create", "v2026.09.1", "--repo", "Blazity/ai-workflow", "--title"]);
    assert.deepEqual(create?.slice(-2), ["--target", collated]);
  } finally {
    await repo.cleanup();
  }
});

test("a version already tagged and released is left alone; a tag without a release gets its release", async () => {
  const { collated, repo } = await releasedRepository();
  try {
    repo.git("tag", "v2026.09.1", collated);

    const done = await planPublish({ log: () => {}, repository: "r/r", root: repo.root, run: fakeGh({ calls: [], released: true }) });
    assert.equal(done?.action, "done");

    const calls: string[][] = [];
    const run = fakeGh({ calls, released: false });
    const pending = await planPublish({ log: () => {}, repository: "r/r", root: repo.root, run });
    assert.equal(pending?.action, "release-only");
    await publish(pending!, { repository: "r/r", root: repo.root, run });
    const create = calls.find((args) => args[1] === "create");
    assert.ok(create);
    assert.equal(create.includes("--target"), false);
  } finally {
    await repo.cleanup();
  }
});

test("a CHANGELOG.md whose newest section is no release has nothing to publish", async () => {
  const repo = await createTestRepository();
  try {
    await repo.commit("docs(changelog): collate entries for 2026-09-20", {
      "CHANGELOG.md": `${CHANGELOG_INTRO}\n## 2026-09-20\n\n- An older dated section.\n`,
    });
    assert.equal(await planPublish({ repository: "r/r", root: repo.root, run: fakeGh({ calls: [], released: false }) }), undefined);
  } finally {
    await repo.cleanup();
  }
});
