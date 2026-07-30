import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseManifest, validateReleaseCandidate } from "./manifest.js";
import { renderReleaseNotes } from "./render.js";
import { collection } from "./test-fixtures.js";

const candidate = "d".repeat(40);
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

test("validates an immutable docs-only candidate and lists migrations", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "diff" && args.includes("--name-only") && args.at(-1)?.includes("drizzle")) {
      return "apps/worker/drizzle/0037_example.sql";
    }
    if (args[0] === "diff") return "docs/releases/artur/2026.08.0.md";
    if (args[0] === "tag") return "";
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  const result = await validateReleaseCandidate(
    { version: "2026.08.0", markdown, mainRef: "main" },
    { run },
  );
  assert.equal(result.candidateCommit, candidate);
  assert.deepEqual(result.databaseMigrations, ["0037_example.sql"]);
});

test("rejects extra candidate changes", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "diff") return "docs/releases/artur/2026.08.0.md\napps/worker/src/index.ts";
    if (args[0] === "tag") return "";
    return "";
  };
  await assert.rejects(
    validateReleaseCandidate({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /unexpected changes/,
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
    approvedBy: "filip",
    now: new Date("2026-08-03T10:00:00Z"),
  });
  assert.equal(manifest.releasedAt, "2026-08-03T10:00:00.000Z");
  assert.equal(manifest.environment, "artur-production");
  assert.equal(manifest.workflowDefinitionVersion, "12");
});
