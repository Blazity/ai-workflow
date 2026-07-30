import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseManifest, validateReleaseCandidate } from "./manifest.js";
import { renderReleaseNotes } from "./render.js";
import { collection } from "./test-fixtures.js";

const candidate = "d".repeat(40);
const notesPath = "docs/releases/artur/2026.08.0.md";
const markdown = renderReleaseNotes(
  collection,
  {
    highlights: "Update",
    features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
    improvementsAndFixes: [],
    requiredAction: "None.",
    knownLimitations: "None.",
    generatedBy: "fallback",
  },
  "2026.08.0",
);

function reviewedPullRequest() {
  return {
    number: 42,
    state: "MERGED",
    mergedAt: "2026-08-03T09:00:00Z",
    mergeCommit: { oid: candidate },
    baseRefName: "main",
    reviewDecision: "APPROVED",
    reviews: [{ state: "APPROVED", author: { login: "zak" } }],
    files: [{ path: notesPath }],
  };
}

test("validates an immutable docs-only candidate and lists migrations", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "diff" && args.includes("--name-only") && args.at(-1)?.includes("drizzle")) {
      return "apps/worker/drizzle/0037_example.sql";
    }
    if (args[0] === "diff") return notesPath;
    if (args[0] === "tag") return "";
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr") return JSON.stringify(reviewedPullRequest());
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  const result = await validateReleaseCandidate(
    { version: "2026.08.0", markdown, mainRef: "main" },
    { run },
  );
  assert.equal(result.candidateCommit, candidate);
  assert.equal(result.releaseNotesPullRequest, 42);
  assert.deepEqual(result.releaseNotesApprovedBy, ["zak"]);
  assert.deepEqual(result.databaseMigrations, ["0037_example.sql"]);
});

test("rejects extra candidate changes", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "diff") return `${notesPath}\napps/worker/src/index.ts`;
    if (args[0] === "tag") return "";
    return "";
  };
  await assert.rejects(
    validateReleaseCandidate({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /unexpected changes/,
  );
});

test("rejects release notes edited after the reviewed candidate", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return `${markdown}\nChanged later.\n`;
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateReleaseCandidate({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /differ from the reviewed candidate/i,
  );
});

test("rejects a release range whose previous commit is not an ancestor of the target", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base" && args[3] === "main") return "";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateReleaseCandidate({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /previousCommit is not an ancestor of targetCommit/,
  );
});

test("rejects a candidate without an approved docs-only pull request", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "diff") return notesPath;
    if (args[0] === "tag") return "";
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr") {
      return JSON.stringify({ ...reviewedPullRequest(), reviewDecision: "REVIEW_REQUIRED", reviews: [] });
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateReleaseCandidate({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /approved review/,
  );
});

test("rejects a release-note file added directly to main", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "diff") return notesPath;
    if (args[0] === "tag") return "";
    if (command === "gh" && args[0] === "api") return "[]";
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateReleaseCandidate({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /exactly one merged pull request/,
  );
});

test("creates an auditable release manifest", () => {
  const manifest = createReleaseManifest({
    version: "2026.08.0",
    candidateCommit: candidate,
    workerUrl: "https://worker.example.com",
    dashboardUrl: "https://dashboard.example.com",
    workflowVersion: "12",
    databaseMigrations: ["0037_example.sql"],
    testRun: "https://github.com/Blazity/ai-workflow/actions/runs/1",
    initiatedBy: "filip",
    productionApprovedBy: ["diana"],
    releaseNotesPullRequest: 42,
    releaseNotesApprovedBy: ["zak"],
    now: new Date("2026-08-03T10:00:00Z"),
  });
  assert.equal(manifest.releasedAt, "2026-08-03T10:00:00.000Z");
  assert.equal(manifest.environment, "artur-production");
  assert.equal(manifest.workflowDefinitionVersion, "12");
  assert.equal(manifest.initiatedBy, "filip");
  assert.deepEqual(manifest.productionApprovedBy, ["diana"]);
  assert.deepEqual(manifest.releaseNotesReview, { pullRequest: 42, approvedBy: ["zak"] });
});
