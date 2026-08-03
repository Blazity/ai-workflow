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
  assert.equal(await readFile(path.join(destinationDir, notesPath), "utf8"), "approved release notes\n");
  assert.equal(await readFile(path.join(destinationDir, "untracked.txt"), "utf8"), "leave untracked\n");
  await assert.rejects(readFile(path.join(destinationDir, "apps", "obsolete.txt")));
  assert.deepEqual(result.preserved, [".github/workflows/ci.yml", "renovate.json"]);
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

  await writeFile(path.join(sourceDir, "apps", "shared.txt"), "after\n");
  const targetSourceCommit = await commitAll(sourceDir, "backported fix");

  await writeFile(path.join(destinationDir, "apps", "shared.txt"), "after\n");
  await commitAll(destinationDir, "Artur hotfix already backported");
  await mkdir(path.join(destinationDir, ".github"), { recursive: true });
  await writeFile(path.join(destinationDir, ".github", "release.yml"), "destination config\n");
  await commitAll(destinationDir, "destination config");
  await writeFile(path.join(destinationDir, "apps", "unique.txt"), "not backported\n");
  const uniqueCommit = await commitAll(destinationDir, "unbackported Artur hotfix");

  assert.deepEqual(
    await findUnbackportedDestinationCommits({
      sourceSnapshotDir: sourceDir,
      destinationDir,
      targetSourceCommit,
      previousDestinationRef: baseline,
    }),
    [uniqueCommit],
  );
});
