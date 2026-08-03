import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureArturReleaseSlot,
  latestPublishedSourceCommit,
  prepareRelease,
  runCli,
  writeShareableRelease,
} from "./cli.js";
import { collection } from "./test-fixtures.js";

test("writes canonical notes and an audit report", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "artur-release-"));
  const result = await prepareRelease(
    {
      version: "2026.08.0",
      previousRef: "base",
      targetRef: "target",
      repository: "Blazity/ai-workflow",
      output,
    },
    {
      collect: async () => collection,
      generate: async () => ({
        highlights: "More repository providers are supported.",
        features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
        improvementsAndFixes: [],
        requiredAction: "No action is required.",
        knownLimitations: "No known user-facing limitations.",
        generatedBy: "fallback",
      }),
    },
  );

  assert.match(await readFile(result.notesPath, "utf8"), /AI Workflow — 2026\.08\.0/);
  assert.match(await readFile(result.reportPath, "utf8"), /Target commit/);
});

test("uses the source commit from the latest published Artur release", async () => {
  const calls: string[][] = [];
  const commit = await latestPublishedSourceCommit(
    "Blazity/ai-workflow-arthur",
    async (command, args) => {
      assert.equal(command, "gh");
      calls.push(args);
      if (args[1] === "view") return JSON.stringify({ tagName: "artur-v2026.08.0" });
      return JSON.stringify({
        version: "2026.08.0",
        sourceRepository: "Blazity/ai-workflow",
        sourceCommit: collection.targetCommit,
        destinationRepository: "Blazity/ai-workflow-arthur",
      });
    },
  );

  assert.equal(commit, collection.targetCommit);
  assert.deepEqual(calls, [
    ["release", "view", "--repo", "Blazity/ai-workflow-arthur", "--json", "tagName"],
    [
      "release",
      "download",
      "artur-v2026.08.0",
      "--repo",
      "Blazity/ai-workflow-arthur",
      "--pattern",
      "release-manifest.json",
      "--output",
      "-",
    ],
  ]);
});

test("allows only an unused Artur release slot or its matching open pull request", async () => {
  const input = {
    repository: "Blazity/ai-workflow-arthur",
    version: "2026.08.0",
    sourceCommit: "b".repeat(40),
    sourcePullRequest: 193,
  };
  const emptyRun = async (_command: string, args: string[]) => {
    if (args.join(" ").includes("releases?")) return JSON.stringify([[]]);
    if (args.join(" ").includes("pulls?")) return JSON.stringify([[]]);
    return JSON.stringify([]);
  };
  await assert.doesNotReject(ensureArturReleaseSlot(input, emptyRun));

  const marker = `<!-- artur-release\n${JSON.stringify({
    version: input.version,
    sourceCommit: input.sourceCommit,
    sourcePullRequest: input.sourcePullRequest,
  })}\n-->`;
  const matchingRun = async (_command: string, args: string[]) => {
    const call = args.join(" ");
    if (call.includes("releases?")) return JSON.stringify([[]]);
    if (call.includes("matching-refs/tags/")) return JSON.stringify([]);
    if (call.includes("matching-refs/heads/")) return JSON.stringify([{ ref: "refs/heads/release/artur-2026.08.0" }]);
    return JSON.stringify([[{
      number: 7,
      state: "open",
      body: marker,
      base: { ref: "main" },
      head: { ref: "release/artur-2026.08.0" },
    }]]);
  };
  await assert.doesNotReject(ensureArturReleaseSlot(input, matchingRun));
});

test("blocks a reused Artur version", async () => {
  await assert.rejects(
    ensureArturReleaseSlot(
      {
        repository: "Blazity/ai-workflow-arthur",
        version: "2026.08.0",
        sourceCommit: "b".repeat(40),
        sourcePullRequest: 193,
      },
      async (_command, args) =>
        args.join(" ").includes("releases?")
          ? JSON.stringify([[{ tag_name: "artur-v2026.08.0" }]])
          : JSON.stringify([]),
    ),
    /already published/,
  );
});

test("refuses to overwrite an existing release file", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "artur-release-"));
  const deps = {
    collect: async () => collection,
    generate: async () => ({
      highlights: "Update",
      features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
      improvementsAndFixes: [],
      requiredAction: "None.",
      knownLimitations: "None.",
      generatedBy: "fallback" as const,
    }),
  };
  const options = {
    version: "2026.08.0",
    previousRef: "base",
    targetRef: "target",
    repository: "Blazity/ai-workflow",
    output,
  };
  await prepareRelease(options, deps);
  await assert.rejects(prepareRelease(options, deps), /already exists/);
});

test("writes only the shareable section for GitHub Release publication", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "artur-release-"));
  const releaseDir = path.join(output, "docs", "releases", "artur");
  const deps = {
    collect: async () => collection,
    generate: async () => ({
      highlights: "Update",
      features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
      improvementsAndFixes: [],
      requiredAction: "None.",
      knownLimitations: "None.",
      generatedBy: "fallback" as const,
    }),
  };
  await prepareRelease(
    {
      version: "2026.08.0",
      previousRef: "base",
      targetRef: "target",
      repository: "Blazity/ai-workflow",
      output,
    },
    deps,
  );
  const destination = path.join(output, "shareable.md");
  await writeShareableRelease(path.join(releaseDir, "2026.08.0.md"), destination);
  const shareable = await readFile(destination, "utf8");
  assert.match(shareable, /AI Workflow — 2026\.08\.0/);
  assert.doesNotMatch(shareable, /Exact release scope/);
});

test("sync-artur CLI writes an auditable snapshot result", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "artur-sync-cli-"));
  const approvalPath = path.join(output, "approved.json");
  const resultPath = path.join(output, "result.json");
  const approved = {
    version: "2026.08.0",
    previousSourceCommit: "a".repeat(40),
    targetSourceCommit: "b".repeat(40),
    notesPath: "docs/releases/artur/2026.08.0.md",
    releaseNotesPullRequest: 193,
    releaseNotesApprovedBy: ["zak"],
  };
  await writeFile(approvalPath, JSON.stringify(approved));
  const expected = {
    version: "2026.08.0",
    sourceCommit: "b".repeat(40),
    destinationBaseCommit: "c".repeat(40),
    notesPath: approved.notesPath,
    added: [approved.notesPath],
    modified: ["apps/worker/index.ts"],
    deleted: [],
    preserved: [".github/workflows/ci.yml", "renovate.json"],
    driftCommits: [],
  };
  await runCli(
    [
      "sync-artur",
      "--version",
      "2026.08.0",
      "--approval",
      approvalPath,
      "--source-main",
      "/source-main",
      "--source-snapshot",
      "/source-snapshot",
      "--destination",
      "/destination",
      "--previous-destination-ref",
      "artur-v2026.07.0",
      "--output",
      resultPath,
    ],
    {
      findDrift: async () => [],
      sync: async () => expected,
    },
  );
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), expected);
});

test("sync-artur CLI blocks an unbackported destination commit", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "artur-sync-drift-"));
  const approvalPath = path.join(output, "approved.json");
  await writeFile(
    approvalPath,
    JSON.stringify({
      version: "2026.08.0",
      previousSourceCommit: "a".repeat(40),
      targetSourceCommit: "b".repeat(40),
      notesPath: "docs/releases/artur/2026.08.0.md",
      releaseNotesPullRequest: 193,
      releaseNotesApprovedBy: ["zak"],
    }),
  );
  let synchronized = false;
  await assert.rejects(
    runCli(
      [
        "sync-artur",
        "--version",
        "2026.08.0",
        "--approval",
        approvalPath,
        "--source-main",
        "/source-main",
        "--source-snapshot",
        "/source-snapshot",
        "--destination",
        "/destination",
        "--previous-destination-ref",
        "baseline",
        "--output",
        path.join(output, "result.json"),
      ],
      {
        findDrift: async () => ["d".repeat(40)],
        sync: async () => {
          synchronized = true;
          throw new Error("must not run");
        },
      },
    ),
    /not backported.*dddd/i,
  );
  assert.equal(synchronized, false);
});
