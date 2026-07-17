import { getSandboxCredentials } from "../../sandbox/credentials.js";
import type { JsonValue } from "@shared/contracts";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
} from "../../sandbox/repo-workspace.js";

export interface FixCommitRef extends Record<string, JsonValue> {
  provider: "github" | "gitlab";
  repoPath: string;
  sha: string;
}

export interface FixConflictRef extends Record<string, JsonValue> {
  provider: "github" | "gitlab";
  repoPath: string;
  files: string[];
}

export interface FixWorkspaceState {
  commits: FixCommitRef[];
  unresolvedConflicts: FixConflictRef[];
}

/** Read the committed and conflict-index state of every attached repository. */
export async function inspectFixWorkspace(sandboxId: string): Promise<FixWorkspaceState> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    throw new Error(`Workspace manifest not found in sandbox at ${WORKSPACE_MANIFEST_PATH}`);
  }
  const manifest = parseWorkspaceManifest(await manifestResult.stdout());
  const commits: FixCommitRef[] = [];
  const unresolvedConflicts: FixConflictRef[] = [];

  for (const repo of manifest.repositories) {
    const commitResult = repo.preAgentSha
      ? await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "rev-list",
          "--reverse",
          `${repo.preAgentSha}..HEAD`,
        ])
      : await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
    if (commitResult.exitCode !== 0) {
      throw new Error(`Could not inspect commits for ${repo.provider}:${repo.repoPath}`);
    }
    for (const sha of lines(await commitResult.stdout())) {
      commits.push({ provider: repo.provider, repoPath: repo.repoPath, sha });
    }

    const conflictsResult = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (conflictsResult.exitCode !== 0) {
      throw new Error(`Could not inspect conflicts for ${repo.provider}:${repo.repoPath}`);
    }
    const files = lines(await conflictsResult.stdout());
    if (files.length > 0) {
      unresolvedConflicts.push({ provider: repo.provider, repoPath: repo.repoPath, files });
    }
  }

  return { commits, unresolvedConflicts };
}

export function resolvedFixConflicts(
  before: FixWorkspaceState,
  after: FixWorkspaceState,
): FixConflictRef[] {
  const unresolvedAfter = new Map(
    after.unresolvedConflicts.map((repo) => [
      `${repo.provider}:${repo.repoPath}`,
      new Set(repo.files),
    ]),
  );
  return before.unresolvedConflicts.flatMap((repo) => {
    const remaining = unresolvedAfter.get(`${repo.provider}:${repo.repoPath}`) ?? new Set<string>();
    const files = repo.files.filter((file) => !remaining.has(file));
    return files.length > 0 ? [{ ...repo, files }] : [];
  });
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
