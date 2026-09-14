import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { collate, parseChangelog, renderChangelog, run } from "./collate.js";

const BASE_CHANGELOG = `# Changelog

This file lists what changed, newest first. Entries come from changelog/unreleased/.
`;

function withSection(date: string, bullets: string[]): string {
  return `${BASE_CHANGELOG}
## ${date}

${bullets.join("\n")}
`;
}

test("collate is a no-op on an empty set of entries", () => {
  const result = collate({ changelog: BASE_CHANGELOG, date: "2026-09-15", entries: [] });

  assert.equal(result.changed, false);
  assert.equal(result.changelog, BASE_CHANGELOG);
  assert.deepEqual(result.bullets, []);
});

test("collate inserts one entry as a new section", () => {
  const result = collate({
    changelog: BASE_CHANGELOG,
    date: "2026-09-15",
    entries: [{ content: "- The dashboard shows run cost per repository.\n", fileName: "a.md" }],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.bullets, ["- The dashboard shows run cost per repository."]);
  assert.equal(
    result.changelog,
    withSection("2026-09-15", ["- The dashboard shows run cost per repository."]),
  );
});

test("collate merges two entries into an existing section for the same date", () => {
  const changelog = withSection("2026-09-15", ["- An MCP tool lists workflow triggers."]);

  const result = collate({
    changelog,
    date: "2026-09-15",
    entries: [
      { content: "- The dashboard shows run cost per repository.\n", fileName: "a-cost.md" },
      { content: "- Workflow triggers respect the run capacity limit.\n", fileName: "b-triggers.md" },
    ],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.bullets, [
    "- The dashboard shows run cost per repository.",
    "- Workflow triggers respect the run capacity limit.",
  ]);
  assert.equal(
    result.changelog,
    withSection("2026-09-15", [
      "- An MCP tool lists workflow triggers.",
      "- The dashboard shows run cost per repository.",
      "- Workflow triggers respect the run capacity limit.",
    ]),
  );
});

test("collate inserts a new section above the existing ones, newest first", () => {
  const changelog = withSection("2026-09-10", ["- An older change."]);

  const result = collate({
    changelog,
    date: "2026-09-15",
    entries: [{ content: "- A newer change.\n", fileName: "a.md" }],
  });

  const parsed = parseChangelog(result.changelog);
  assert.deepEqual(
    parsed.sections.map((section) => section.date),
    ["2026-09-15", "2026-09-10"],
  );
  assert.deepEqual(parsed.sections[0].bullets, ["- A newer change."]);
  assert.deepEqual(parsed.sections[1].bullets, ["- An older change."]);
});

test("collate leaves an existing older section in place rather than reordering it", () => {
  const changelog = [
    withSection("2026-09-12", ["- A middle change."]).trimEnd(),
    "",
    "## 2026-09-10",
    "",
    "- The oldest change.",
    "",
  ].join("\n");

  const result = collate({
    changelog,
    date: "2026-09-15",
    entries: [{ content: "- The newest change.\n", fileName: "a.md" }],
  });

  const parsed = parseChangelog(result.changelog);
  assert.deepEqual(
    parsed.sections.map((section) => section.date),
    ["2026-09-15", "2026-09-12", "2026-09-10"],
  );
});

test("parseChangelog and renderChangelog round-trip a canonical file", () => {
  const changelog = withSection("2026-09-15", ["- One.", "- Two."]);
  const parsed = parseChangelog(changelog);

  assert.equal(parsed.sections.length, 1);
  assert.equal(renderChangelog(parsed), changelog);
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".changelog-collate-"));
  await mkdir(join(root, "changelog/unreleased"), { recursive: true });
  await writeFile(join(root, "changelog/unreleased/.gitkeep"), "");
  await writeFile(join(root, "CHANGELOG.md"), BASE_CHANGELOG);
  return root;
}

test("run() is idempotent on an empty changelog/unreleased/ folder", async () => {
  const root = await fixtureRoot();
  try {
    const output = await run({ date: "2026-09-15", dryRun: false, root });
    assert.match(output, /no pending entries, nothing to do/u);
    assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), BASE_CHANGELOG);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run() writes CHANGELOG.md and deletes the collated files", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(
      join(root, "changelog/unreleased/a-first.md"),
      "- The dashboard shows run cost per repository.\n",
    );
    await writeFile(
      join(root, "changelog/unreleased/b-second.md"),
      "- Workflow triggers respect the run capacity limit.\n",
    );

    const output = await run({ date: "2026-09-15", dryRun: false, root });

    assert.match(output, /folding 2 entries into 2026-09-15/u);
    assert.match(output, /a-first\.md/u);
    assert.match(output, /b-second\.md/u);

    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    assert.equal(
      changelog,
      withSection("2026-09-15", [
        "- The dashboard shows run cost per repository.",
        "- Workflow triggers respect the run capacity limit.",
      ]),
    );

    const remaining = (await readdir(join(root, "changelog/unreleased"))).sort();
    assert.deepEqual(remaining, [".gitkeep"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run() with dryRun previews without touching the filesystem", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(
      join(root, "changelog/unreleased/a-first.md"),
      "- The dashboard shows run cost per repository.\n",
    );

    const output = await run({ date: "2026-09-15", dryRun: true, root });

    assert.match(output, /dry run, no files were written/u);
    assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), BASE_CHANGELOG);
    const remaining = (await readdir(join(root, "changelog/unreleased"))).sort();
    assert.deepEqual(remaining, [".gitkeep", "a-first.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
