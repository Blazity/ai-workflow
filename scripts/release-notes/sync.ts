import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseVersion } from "./classify.js";
import type { SyncInput, SyncResult } from "./types.js";

const execFileAsync = promisify(execFile);

export const DESTINATION_OWNED_PATHS = [".github/", "renovate.json"] as const;

function isDestinationOwned(file: string): boolean {
  return file === "renovate.json" || file === ".github" || file.startsWith(".github/");
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function trackedFiles(dir: string): Promise<string[]> {
  return (await git(dir, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
}

export async function findUnbackportedDestinationCommits(input: {
  sourceSnapshotDir: string;
  destinationDir: string;
  previousSourceCommit: string;
  targetSourceCommit: string;
  previousDestinationRef: string;
}): Promise<string[]> {
  if (!input.previousDestinationRef.trim()) {
    throw new Error("A reviewed previous destination reference is required");
  }
  try {
    await git(input.destinationDir, [
      "merge-base",
      "--is-ancestor",
      input.previousDestinationRef,
      "HEAD",
    ]);
  } catch {
    throw new Error(
      `Previous destination reference ${input.previousDestinationRef} is not an ancestor of HEAD`,
    );
  }
  await git(input.destinationDir, [
    "fetch",
    "--quiet",
    "--no-tags",
    input.sourceSnapshotDir,
    input.targetSourceCommit,
  ]);
  const sourceCommits = (await git(input.destinationDir, [
    "rev-list",
    "--reverse",
    `${input.previousSourceCommit}..${input.targetSourceCommit}`,
  ]))
    .split("\n")
    .filter(Boolean);
  const sourcePatches = new Set<string>();
  for (const commit of sourceCommits) {
    sourcePatches.add(
      createHash("sha256")
        .update(
          await git(input.destinationDir, [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            `${commit}^1`,
            commit,
          ]),
        )
        .digest("hex"),
    );
  }
  const destinationCommits = (await git(input.destinationDir, [
    "rev-list",
    "--first-parent",
    "--reverse",
    `${input.previousDestinationRef}..HEAD`,
  ]))
    .split("\n")
    .filter(Boolean);
  const applicationCommits: string[] = [];
  for (const commit of destinationCommits) {
    const changed = (await git(input.destinationDir, [
      "diff",
      "--name-only",
      `${commit}^1`,
      commit,
    ]))
      .split("\n")
      .filter(Boolean);
    if (!changed.some((file) => !isDestinationOwned(file))) continue;
    const patch = createHash("sha256")
      .update(
        await git(input.destinationDir, [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          `${commit}^1`,
          commit,
        ]),
      )
      .digest("hex");
    if (!sourcePatches.has(patch)) applicationCommits.push(commit);
  }
  return applicationCommits.sort();
}

async function signature(root: string, file: string): Promise<string> {
  const absolute = path.join(root, file);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    return `120000:${createHash("sha256").update(await readlink(absolute)).digest("hex")}`;
  }
  const executable = stat.mode & 0o111 ? "100755" : "100644";
  return `${executable}:${createHash("sha256").update(await readFile(absolute)).digest("hex")}`;
}

async function copyTrackedFile(sourceRoot: string, destinationRoot: string, file: string): Promise<void> {
  const source = path.join(sourceRoot, file);
  const destination = path.join(destinationRoot, file);
  const stat = await lstat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { force: true, recursive: true });
  if (stat.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  await copyFile(source, destination);
  await chmod(destination, stat.mode & 0o777);
}

export async function synchronizeArturSnapshot(input: SyncInput): Promise<SyncResult> {
  const version = parseVersion(input.version);
  if (input.approved.version !== version) {
    throw new Error(`Approved release ${input.approved.version} does not match ${version}`);
  }
  const sourceCommit = (await git(input.sourceSnapshotDir, ["rev-parse", "HEAD"])).trim();
  if (sourceCommit !== input.approved.targetSourceCommit) {
    throw new Error(
      `Source snapshot ${sourceCommit} does not match targetSourceCommit ${input.approved.targetSourceCommit}`,
    );
  }
  const destinationBaseCommit = (await git(input.destinationDir, ["rev-parse", "HEAD"])).trim();
  const sourceTracked = (await trackedFiles(input.sourceSnapshotDir)).filter(
    (file) => !isDestinationOwned(file),
  );
  const sourceMainTracked = new Set(await trackedFiles(input.sourceMainDir));
  if (!sourceMainTracked.has(input.approved.notesPath)) {
    throw new Error(`Approved release note is not tracked: ${input.approved.notesPath}`);
  }
  const destinationTracked = await trackedFiles(input.destinationDir);
  const destinationTrackedSet = new Set(destinationTracked);
  const desired = new Set([...sourceTracked, input.approved.notesPath]);
  const preserved = destinationTracked.filter(isDestinationOwned);
  const added = [...desired].filter((file) => !destinationTrackedSet.has(file)).sort();
  const deleted = destinationTracked
    .filter((file) => !isDestinationOwned(file) && !desired.has(file))
    .sort();
  const modified: string[] = [];

  for (const file of sourceTracked) {
    if (destinationTrackedSet.has(file)) {
      const [sourceSignature, destinationSignature] = await Promise.all([
        signature(input.sourceSnapshotDir, file),
        signature(input.destinationDir, file),
      ]);
      if (sourceSignature !== destinationSignature) modified.push(file);
    }
  }
  if (destinationTrackedSet.has(input.approved.notesPath)) {
    const [sourceSignature, destinationSignature] = await Promise.all([
      signature(input.sourceMainDir, input.approved.notesPath),
      signature(input.destinationDir, input.approved.notesPath),
    ]);
    if (sourceSignature !== destinationSignature) modified.push(input.approved.notesPath);
  }

  const preservedSignatures = new Map(
    await Promise.all(
      preserved.map(async (file) => [file, await signature(input.destinationDir, file)] as const),
    ),
  );
  for (const file of deleted) {
    await rm(path.join(input.destinationDir, file), { force: true, recursive: true });
  }
  for (const file of sourceTracked) {
    await copyTrackedFile(input.sourceSnapshotDir, input.destinationDir, file);
  }
  await copyTrackedFile(input.sourceMainDir, input.destinationDir, input.approved.notesPath);

  for (const file of sourceTracked) {
    if ((await signature(input.sourceSnapshotDir, file)) !== (await signature(input.destinationDir, file))) {
      throw new Error(`Synchronized path does not match source snapshot: ${file}`);
    }
  }
  for (const [file, expected] of preservedSignatures) {
    if ((await signature(input.destinationDir, file)) !== expected) {
      throw new Error(`Destination-owned path changed during synchronization: ${file}`);
    }
  }
  if (
    (await signature(input.sourceMainDir, input.approved.notesPath)) !==
    (await signature(input.destinationDir, input.approved.notesPath))
  ) {
    throw new Error("Copied release notes differ from the approved source file");
  }

  return {
    version,
    sourceCommit,
    destinationBaseCommit,
    notesPath: input.approved.notesPath,
    added,
    modified: modified.sort(),
    deleted,
    preserved,
    driftCommits: [],
  };
}
