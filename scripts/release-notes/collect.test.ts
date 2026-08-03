import assert from "node:assert/strict";
import test from "node:test";

import { collectRelease, type CommandRunner } from "./collect.js";

const base = "a".repeat(40);
const target = "b".repeat(40);
const feature = "c".repeat(40);
const old = "d".repeat(40);
const unavailable = "e".repeat(40);

test("collects only PRs in the exact ancestry range and preserves audit groups", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "rev-parse") return args[2].startsWith("base") ? base : target;
    if (args[0] === "merge-base" && args[2] === base && args[3] === target) return "";
    if (args[0] === "rev-list") return feature;
    if (command === "gh") {
      return JSON.stringify([[
        {
          number: 7,
          title: "feat: GitLab support",
          body: "## User impact\nGitLab repositories work.\n## Release note\nUse GitLab repositories.",
          labels: [{ name: "release:feature" }],
          merged_at: "2026-07-29T10:00:00Z",
          merge_commit_sha: feature,
          html_url: "https://github.com/acme/repo/pull/7",
        },
        {
          number: 6,
          title: "chore: internal",
          body: "",
          labels: [{ name: "release:internal" }],
          merged_at: "2026-07-28T10:00:00Z",
          merge_commit_sha: old,
          html_url: "https://github.com/acme/repo/pull/6",
        },
        {
          number: 99,
          title: "fix: merged outside the local graph",
          body: "",
          labels: [{ name: "release:fix" }],
          merged_at: "2026-07-30T10:00:00Z",
          merge_commit_sha: unavailable,
          html_url: "https://github.com/acme/repo/pull/99",
        },
      ]]);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  const collection = await collectRelease(
    { repository: "acme/repo", previousRef: "base", targetRef: "target" },
    { run },
  );

  assert.equal(collection.previousCommit, base);
  assert.equal(collection.targetCommit, target);
  assert.deepEqual(collection.included.map((item) => item.number), [7]);
  assert.deepEqual(collection.internal, []);
  assert.deepEqual(collection.skipped, []);
  assert.ok(
    calls.some((call) =>
      call.startsWith("gh api --paginate --slurp repos/acme/repo/pulls?state=closed&per_page=100"),
    ),
  );
});

test("rejects a base that is not an ancestor of the target", async () => {
  const run: CommandRunner = async (_command, args) => {
    if (args[0] === "rev-parse") return args[2].startsWith("base") ? base : target;
    throw Object.assign(new Error("not ancestor"), { code: 1 });
  };
  await assert.rejects(
    collectRelease({ repository: "acme/repo", previousRef: "base", targetRef: "target" }, { run }),
    /not an ancestor/,
  );
});
