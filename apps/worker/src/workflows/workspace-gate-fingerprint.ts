import { createHash } from "node:crypto";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

/**
 * Canonical fingerprint input includes the complete trusted manifest and one
 * HEAD per repository in manifest order. Clean-worktree verification happens
 * before this runtime-only helper is called.
 */
export function fingerprintWorkspaceState(
  workspaceManifest: WorkspaceManifest,
  headShas: readonly string[],
): string {
  if (headShas.length !== workspaceManifest.repositories.length) {
    throw new Error("Workspace fingerprint requires one HEAD for every repository");
  }
  const payload = {
    version: 1,
    workspaceManifest,
    repositories: workspaceManifest.repositories.map((repo, index) => ({
      provider: repo.provider,
      repoPath: repo.repoPath,
      headSha: headShas[index],
    })),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
