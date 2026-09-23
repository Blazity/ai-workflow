import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { insertRelease, parseChangelog, renderChangelog, run, versionsInChangelog, type CollateDeps } from "./collate.ts";
import type { EntryOrigin } from "./history.ts";
import type { ReleaseNotes } from "./notes.ts";

const BASE_CHANGELOG = `# Changelog

This file lists what changed, newest first.
`;

const OLD_DATED = `${BASE_CHANGELOG}
## 2026-09-21

- An older change, from before versions.
- Another one.
`;

const NOTES: ReleaseNotes = {
  areas: [{ area: "Dashboard", bullets: ["A newer change."], summary: "One change in this area." }],
  date: "2026-09-23",
  shortVersion: [],
  version: "v2026.09.1",
};

test("a release goes above every existing section and leaves the older dated sections exactly as written", () => {
  const result = insertRelease(OLD_DATED, NOTES);

  assert.equal(
    result,
    `${BASE_CHANGELOG}
## v2026.09.1 (2026-09-23)

### Dashboard

_One change in this area._

- A newer change.

## 2026-09-21

- An older change, from before versions.
- Another one.
`,
  );
  assert.deepEqual(versionsInChangelog(result), ["v2026.09.1"]);
});

test("parseChangelog and renderChangelog round-trip a file with release and dated sections", () => {
  const text = insertRelease(OLD_DATED, NOTES);
  assert.equal(renderChangelog(parseChangelog(text)), text);
  assert.equal(renderChangelog(parseChangelog(BASE_CHANGELOG)), BASE_CHANGELOG);
});

async function fixtureRoot(changelog = BASE_CHANGELOG): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".changelog-collate-"));
  await mkdir(join(root, "changelog/unreleased"), { recursive: true });
  await writeFile(join(root, "changelog/unreleased/.gitkeep"), "");
  await writeFile(join(root, "changelog/README.md"), "# Entries\n\n## Tone rule\n\nForward, not backward.\n");
  await writeFile(join(root, "CHANGELOG.md"), changelog);
  return root;
}

function fakeDeps(overrides: Partial<CollateDeps> = {}): CollateDeps & { messages: string[] } {
  const messages: string[] = [];
  const origins: Record<string, EntryOrigin> = {
    "a-first.md": {
      commitPaths: ["apps/dashboard/components/cost.tsx"],
      commitSubject: "feat(dashboard): show cost",
      fileName: "a-first.md",
      pullRequest: 101,
      pullRequestPaths: [],
    },
    "b-second.md": {
      commitPaths: ["apps/worker/src/services/triggers/capacity.ts"],
      commitSubject: "feat(worker): limit triggers",
      fileName: "b-second.md",
      pullRequest: 102,
      pullRequestPaths: [],
    },
  };
  return {
    authors: async (numbers) => new Map(numbers.map((number) => [number, `author${number}`])),
    log: (message) => messages.push(message),
    messages,
    model: async () => {
      throw new Error("ANTHROPIC_API_KEY is not set");
    },
    tags: async () => [],
    trace: async (fileNames) =>
      fileNames.map((fileName) => origins[fileName] ?? { commitPaths: [], fileName, pullRequestPaths: [] }),
    ...overrides,
  };
}

async function withEntries(root: string): Promise<void> {
  await writeFile(join(root, "changelog/unreleased/a-first.md"), "- The dashboard shows run cost per repository.\n");
  await writeFile(join(root, "changelog/unreleased/b-second.md"), "- Workflow triggers respect the run capacity limit.\n");
}

test("no pending entries means no release: nothing is written and no version is claimed", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(join(root, "changelog/unreleased/empty.md"), "Prose without a bullet.\n");
    const result = await run({ date: "2026-09-23", dryRun: false, root }, fakeDeps());
    assert.match(result.output, /no pending entries, nothing to release/u);
    assert.equal(result.version, undefined);
    assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), BASE_CHANGELOG);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("with the model unavailable the collation still releases: grouped bullets, plain area lines, reason logged", async () => {
  const root = await fixtureRoot(OLD_DATED);
  try {
    await withEntries(root);
    const deps = fakeDeps({ tags: async () => ["v2026.09.1"] });
    const result = await run({ date: "2026-09-23", dryRun: false, root }, deps);

    assert.equal(result.version, "v2026.09.2");
    assert.match(result.output, /releasing v2026\.09\.2 from 2 entries \(prose by fallback\)/u);
    assert.match(deps.messages.join("\n"), /ANTHROPIC_API_KEY is not set/u);

    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    assert.equal(
      changelog,
      `${BASE_CHANGELOG}
## v2026.09.2 (2026-09-23)

### Dashboard

_One change in this area._

- The dashboard shows run cost per repository.

### Runs and workflows

_One change in this area._

- Workflow triggers respect the run capacity limit.

## 2026-09-21

- An older change, from before versions.
- Another one.
`,
    );
    assert.deepEqual((await readdir(join(root, "changelog/unreleased"))).sort(), [".gitkeep"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("running the same day's collation again adds no second release", async () => {
  const root = await fixtureRoot(OLD_DATED);
  try {
    await withEntries(root);
    const first = await run({ date: "2026-09-23", dryRun: false, root }, fakeDeps());
    const afterFirst = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const second = await run({ date: "2026-09-23", dryRun: false, root }, fakeDeps());

    assert.equal(first.version, "v2026.09.1");
    assert.equal(second.version, undefined);
    assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), afterFirst);
    assert.deepEqual(versionsInChangelog(afterFirst), ["v2026.09.1"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a version an untagged section already claims is skipped", async () => {
  const root = await fixtureRoot(insertRelease(BASE_CHANGELOG, NOTES));
  try {
    await withEntries(root);
    const result = await run({ date: "2026-09-24", dryRun: false, root }, fakeDeps());
    assert.equal(result.version, "v2026.09.2");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a dry run prints the section and the release body and touches nothing", async () => {
  const root = await fixtureRoot();
  try {
    await withEntries(root);
    const model = async () =>
      JSON.stringify({
        areaSummaries: [
          { area: "Dashboard", summary: "Costs are visible." },
          { area: "Runs and workflows", summary: "Triggers share the limit." },
        ],
        shortVersion: [
          { area: "Dashboard", text: "See run cost per repository." },
          { area: "Runs and workflows", text: "Triggers wait for capacity." },
        ],
      });
    const result = await run({ date: "2026-09-23", dryRun: true, root }, fakeDeps({ model }));

    assert.match(result.output, /===== CHANGELOG.md section =====\n## v2026\.09\.1 \(2026-09-23\)/u);
    assert.match(result.output, /## The short version\n\n\*\*Dashboard:\*\* See run cost per repository\./u);
    assert.match(
      result.output,
      /\* The dashboard shows run cost per repository\. \(in \[#101\]\(https:\/\/github\.com\/Blazity\/ai-workflow\/pull\/101\) by \[@author101\]/u,
    );
    assert.match(result.output, /dry run, nothing was written, tagged or released/u);
    assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), BASE_CHANGELOG);
    assert.deepEqual((await readdir(join(root, "changelog/unreleased"))).sort(), [".gitkeep", "a-first.md", "b-second.md"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
