import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareRelease } from "./cli.js";
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
