import assert from "node:assert/strict";
import test from "node:test";

import { collectRelease, type CommandRunner } from "./collect.js";

const base = "a".repeat(40);
const target = "b".repeat(40);
const feature = "c".repeat(40);
const old = "d".repeat(40);

test("collects only PRs in the exact ancestry range and preserves audit groups", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "rev-parse") return args[2].startsWith("base") ? base : target;
    if (args[0] === "merge-base" && args[2] === base && args[3] === target) return "";
    if (command === "gh") {
      return JSON.stringify([
        {
          number: 7,
          title: "feat: GitLab support",
          body: "## User impact\nGitLab repositories work.\n## Release note\nUse GitLab repositories.",
          labels: [{ name: "release:feature" }],
          mergedAt: "2026-07-29T10:00:00Z",
          mergeCommit: { oid: feature },
          url: "https://github.com/acme/repo/pull/7",
        },
        {
          number: 6,
          title: "chore: internal",
          body: "",
          labels: [{ name: "release:internal" }],
          mergedAt: "2026-07-28T10:00:00Z",
          mergeCommit: { oid: old },
          url: "https://github.com/acme/repo/pull/6",
        },
      ]);
    }
    if (args[0] === "merge-base" && args[2] === feature) {
      return args[3] === base ? Promise.reject(Object.assign(new Error("not ancestor"), { code: 1 })) : "";
    }
    if (args[0] === "merge-base" && args[2] === old) return "";
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
  assert.ok(calls.some((call) => call.startsWith("gh pr list --repo acme/repo")));
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
