import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { findUnbackportedDestinationCommits, synchronizeArturSnapshot } from "./sync.js";
import type { ApprovedSourceRelease } from "./types.js";

const exec = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: dir })).stdout.trim();
}

async function initRepository(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "release-test@example.com");
  await git(dir, "config", "user.name", "Release Test");
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

test("Artur snapshot replaces all source-owned files and preserves destination-owned paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artur-snapshot-"));
  t.after(async () => {
    await exec("rm", ["-rf", root]);
  });
  const sourceSnapshotDir = path.join(root, "source-snapshot");
  const sourceMainDir = path.join(root, "source-main");
  const destinationDir = path.join(root, "destination");

  await initRepository(sourceSnapshotDir);
  await mkdir(path.join(sourceSnapshotDir, "apps"), { recursive: true });
  await mkdir(path.join(sourceSnapshotDir, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(sourceSnapshotDir, "apps", "app.txt"), "source application\n");
  await writeFile(path.join(sourceSnapshotDir, "apps", "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(sourceSnapshotDir, "apps", "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(sourceSnapshotDir, "apps", "run.sh"), 0o755);
  await symlink("app.txt", path.join(sourceSnapshotDir, "apps", "app-link"));
  await writeFile(path.join(sourceSnapshotDir, ".github", "workflows", "ci.yml"), "source-ci\n");
  await writeFile(path.join(sourceSnapshotDir, "renovate.json"), "{\"source\":true}\n");
  await mkdir(path.join(sourceSnapshotDir, "skills", "source-review"), { recursive: true });
  await writeFile(path.join(sourceSnapshotDir, "skills", "source-review", "SKILL.md"), "source skill\n");
  const sourceCommit = await commitAll(sourceSnapshotDir, "source snapshot");

  await initRepository(sourceMainDir);
  await mkdir(path.join(sourceMainDir, "docs", "releases", "artur"), { recursive: true });
  const notesPath = "docs/releases/artur/2026.08.0.md";
  await writeFile(path.join(sourceMainDir, notesPath), "approved release notes\n");
  await commitAll(sourceMainDir, "approved notes");

  await initRepository(destinationDir);
  await mkdir(path.join(destinationDir, "apps"), { recursive: true });
  await mkdir(path.join(destinationDir, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(destinationDir, "apps", "app.txt"), "old application\n");
  await writeFile(path.join(destinationDir, "apps", "obsolete.txt"), "remove me\n");
  await writeFile(path.join(destinationDir, ".github", "workflows", "ci.yml"), "arthur-ci\n");
  await writeFile(path.join(destinationDir, "renovate.json"), "{\"arthur\":true}\n");
  await mkdir(path.join(destinationDir, "skills", "arthur-review"), { recursive: true });
  await writeFile(path.join(destinationDir, "skills", "arthur-review", "SKILL.md"), "arthur skill\n");
  const destinationBaseCommit = await commitAll(destinationDir, "destination base");
  await writeFile(path.join(destinationDir, "untracked.txt"), "leave untracked\n");

  const approved: ApprovedSourceRelease = {
    version: "2026.08.0",
    previousSourceCommit: "a".repeat(40),
    targetSourceCommit: sourceCommit,
    notesPath,
    releaseNotesPullRequest: 193,
    releaseNotesApprovedBy: ["zak"],
  };

  const result = await synchronizeArturSnapshot({
    version: "2026.08.0",
    sourceMainDir,
    sourceSnapshotDir,
    destinationDir,
    approved,
  });

  assert.equal(result.sourceCommit, sourceCommit);
  assert.equal(result.destinationBaseCommit, destinationBaseCommit);
  assert.equal(await readFile(path.join(destinationDir, "apps", "app.txt"), "utf8"), "source application\n");
  assert.deepEqual(await readFile(path.join(destinationDir, "apps", "binary.bin")), Buffer.from([0, 1, 2, 255]));
  assert.equal(await readFile(path.join(destinationDir, ".github", "workflows", "ci.yml"), "utf8"), "arthur-ci\n");
  assert.equal(await readFile(path.join(destinationDir, "renovate.json"), "utf8"), "{\"arthur\":true}\n");
  // The tenant owns its skills: its own survives the snapshot untouched, and
  // the source repository's skill never reaches it, because a skill carries the
  // review knowledge of whoever ships it.
  assert.equal(
    await readFile(path.join(destinationDir, "skills", "arthur-review", "SKILL.md"), "utf8"),
    "arthur skill\n",
  );
  await assert.rejects(readFile(path.join(destinationDir, "skills", "source-review", "SKILL.md")));
  assert.equal(await readFile(path.join(destinationDir, notesPath), "utf8"), "approved release notes\n");
  assert.equal(await readFile(path.join(destinationDir, "untracked.txt"), "utf8"), "leave untracked\n");
  await assert.rejects(readFile(path.join(destinationDir, "apps", "obsolete.txt")));
  assert.deepEqual(result.preserved, [
    ".github/workflows/ci.yml",
    "renovate.json",
    "skills/arthur-review/SKILL.md",
  ]);
  assert.ok(result.added.includes("apps/binary.bin"));
  assert.ok(result.added.includes(notesPath));
  assert.ok(result.modified.includes("apps/app.txt"));
  assert.deepEqual(result.deleted, ["apps/obsolete.txt"]);
});

test("Artur snapshot rejects a source checkout at the wrong commit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artur-snapshot-sha-"));
  t.after(async () => {
    await exec("rm", ["-rf", root]);
  });
  for (const name of ["source-main", "source-snapshot", "destination"]) {
    const dir = path.join(root, name);
    await initRepository(dir);
    await writeFile(path.join(dir, "file.txt"), `${name}\n`);
    await commitAll(dir, name);
  }
  await assert.rejects(
    synchronizeArturSnapshot({
      version: "2026.08.0",
      sourceMainDir: path.join(root, "source-main"),
      sourceSnapshotDir: path.join(root, "source-snapshot"),
      destinationDir: path.join(root, "destination"),
      approved: {
        version: "2026.08.0",
        previousSourceCommit: "a".repeat(40),
        targetSourceCommit: "b".repeat(40),
        notesPath: "docs/releases/artur/2026.08.0.md",
        releaseNotesPullRequest: 193,
        releaseNotesApprovedBy: ["zak"],
      },
    }),
    /does not match targetSourceCommit/,
  );
});

test("destination drift ignores repository config and patch-equivalent backports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artur-drift-"));
  t.after(async () => {
    await exec("rm", ["-rf", root]);
  });
  const baseDir = path.join(root, "base");
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  await initRepository(baseDir);
  await mkdir(path.join(baseDir, "apps"), { recursive: true });
  await writeFile(path.join(baseDir, "apps", "shared.txt"), "before\n");
  await commitAll(baseDir, "base");
  await exec("git", ["clone", "-q", baseDir, sourceDir]);
  await exec("git", ["clone", "-q", baseDir, destinationDir]);
  for (const dir of [sourceDir, destinationDir]) {
    await git(dir, "config", "user.email", "release-test@example.com");
    await git(dir, "config", "user.name", "Release Test");
  }
  const baseline = await git(destinationDir, "rev-parse", "HEAD");
  const previousSourceCommit = await git(sourceDir, "rev-parse", "HEAD");

  await writeFile(path.join(sourceDir, "apps", "shared.txt"), "after\n");
  const targetSourceCommit = await commitAll(sourceDir, "backported fix");

  await writeFile(path.join(destinationDir, "apps", "shared.txt"), "after\n");
  await commitAll(destinationDir, "Artur hotfix already backported");
  await mkdir(path.join(destinationDir, ".github"), { recursive: true });
  await writeFile(path.join(destinationDir, ".github", "release.yml"), "destination config\n");
  await commitAll(destinationDir, "destination config");
  await mkdir(path.join(destinationDir, "skills", "arthur-review"), { recursive: true });
  await writeFile(
    path.join(destinationDir, "skills", "arthur-review", "SKILL.md"),
    "arthur skill\n",
  );
  // The tenant adding its own skills is not an application change waiting to be
  // backported, so it must not hold up a release the way a real hotfix would.
  await commitAll(destinationDir, "tenant skills");
  await writeFile(path.join(destinationDir, "apps", "unique.txt"), "not backported\n");
  const uniqueCommit = await commitAll(destinationDir, "unbackported Artur hotfix");

  assert.deepEqual(
    await findUnbackportedDestinationCommits({
      sourceSnapshotDir: sourceDir,
      destinationDir,
      previousSourceCommit,
      targetSourceCommit,
      previousDestinationRef: baseline,
    }),
    [uniqueCommit],
  );
});

test("destination drift uses stable patch IDs across unrelated source changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artur-drift-patch-id-"));
  t.after(async () => {
    await exec("rm", ["-rf", root]);
  });
  const baseDir = path.join(root, "base");
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  const original = ["header", "1", "2", "3", "4", "5", "6", "7", "before", "footer", ""].join("\n");
  await initRepository(baseDir);
  await mkdir(path.join(baseDir, "apps"), { recursive: true });
  await writeFile(path.join(baseDir, "apps", "shared.txt"), original);
  await commitAll(baseDir, "base");
  await exec("git", ["clone", "-q", baseDir, sourceDir]);
  await exec("git", ["clone", "-q", baseDir, destinationDir]);
  for (const dir of [sourceDir, destinationDir]) {
    await git(dir, "config", "user.email", "release-test@example.com");
    await git(dir, "config", "user.name", "Release Test");
  }
  const baseline = await git(destinationDir, "rev-parse", "HEAD");
  const previousSourceCommit = await git(sourceDir, "rev-parse", "HEAD");

  await writeFile(path.join(sourceDir, "apps", "shared.txt"), original.replace("header", "new header"));
  await commitAll(sourceDir, "unrelated source change");
  await writeFile(
    path.join(sourceDir, "apps", "shared.txt"),
    original.replace("header", "new header").replace("before", "after"),
  );
  const targetSourceCommit = await commitAll(sourceDir, "backported hotfix");

  await writeFile(path.join(destinationDir, "apps", "shared.txt"), original.replace("before", "after"));
  await commitAll(destinationDir, "Artur hotfix");

  assert.deepEqual(
    await findUnbackportedDestinationCommits({
      sourceSnapshotDir: sourceDir,
      destinationDir,
      previousSourceCommit,
      targetSourceCommit,
      previousDestinationRef: baseline,
    }),
    [],
  );
});

test("destination drift does not accept a patch that exists only before the release range", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artur-drift-range-"));
  t.after(async () => {
    await exec("rm", ["-rf", root]);
  });
  const baseDir = path.join(root, "base");
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  await initRepository(baseDir);
  await mkdir(path.join(baseDir, "apps"), { recursive: true });
  await writeFile(path.join(baseDir, "apps", "shared.txt"), "before\n");
  await commitAll(baseDir, "base");
  await exec("git", ["clone", "-q", baseDir, sourceDir]);
  await exec("git", ["clone", "-q", baseDir, destinationDir]);
  for (const dir of [sourceDir, destinationDir]) {
    await git(dir, "config", "user.email", "release-test@example.com");
    await git(dir, "config", "user.name", "Release Test");
  }
  const baseline = await git(destinationDir, "rev-parse", "HEAD");

  await writeFile(path.join(sourceDir, "apps", "shared.txt"), "after\n");
  await commitAll(sourceDir, "old source patch");
  await writeFile(path.join(sourceDir, "apps", "shared.txt"), "before\n");
  const previousSourceCommit = await commitAll(sourceDir, "revert old source patch");
  await writeFile(path.join(sourceDir, "source-only.txt"), "current range\n");
  const targetSourceCommit = await commitAll(sourceDir, "current release change");

  await writeFile(path.join(destinationDir, "apps", "shared.txt"), "after\n");
  const destinationHotfix = await commitAll(destinationDir, "Artur hotfix matching old patch");

  assert.deepEqual(
    await findUnbackportedDestinationCommits({
      sourceSnapshotDir: sourceDir,
      destinationDir,
      previousSourceCommit,
      targetSourceCommit,
      previousDestinationRef: baseline,
    }),
    [destinationHotfix],
  );
});

test("destination drift tolerates source merge commits with no first-parent diff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artur-drift-merge-"));
  t.after(async () => {
    await exec("rm", ["-rf", root]);
  });
  const baseDir = path.join(root, "base");
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  await initRepository(baseDir);
  await mkdir(path.join(baseDir, "apps"), { recursive: true });
  await writeFile(path.join(baseDir, "apps", "shared.txt"), "before\n");
  await commitAll(baseDir, "base");
  await exec("git", ["clone", "-q", baseDir, sourceDir]);
  await exec("git", ["clone", "-q", baseDir, destinationDir]);
  for (const dir of [sourceDir, destinationDir]) {
    await git(dir, "config", "user.email", "release-test@example.com");
    await git(dir, "config", "user.name", "Release Test");
  }
  const baseline = await git(destinationDir, "rev-parse", "HEAD");
  const previousSourceCommit = await git(sourceDir, "rev-parse", "HEAD");

  await git(sourceDir, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(sourceDir, "apps", "shared.txt"), "after\n");
  await commitAll(sourceDir, "feature change");
  await git(sourceDir, "checkout", "-q", "-");
  await writeFile(path.join(sourceDir, "apps", "shared.txt"), "after\n");
  await commitAll(sourceDir, "same change on main");
  await git(sourceDir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  const targetSourceCommit = await git(sourceDir, "rev-parse", "HEAD");
  assert.equal(await git(sourceDir, "diff", "HEAD^1", "HEAD"), "");

  await writeFile(path.join(destinationDir, "apps", "unique.txt"), "not backported\n");
  const uniqueCommit = await commitAll(destinationDir, "unbackported Artur hotfix");

  assert.deepEqual(
    await findUnbackportedDestinationCommits({
      sourceSnapshotDir: sourceDir,
      destinationDir,
      previousSourceCommit,
      targetSourceCommit,
      previousDestinationRef: baseline,
    }),
    [uniqueCommit],
  );
});
