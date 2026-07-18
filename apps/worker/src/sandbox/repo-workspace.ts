import { z } from "zod";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

export const WORKSPACE_MANIFEST_PATH = "/vercel/sandbox/aiw-repos.json";
export const WORKSPACE_ROOT_DIR = "/vercel/sandbox";
export const WORKSPACE_REPOS_DIR = "/vercel/sandbox/repos";

export const workspaceRepoSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  repoPath: z.string().min(1),
  slug: z.string().min(1),
  localPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  branchName: z.string().min(1),
  mergeBase: z.string().min(1).optional(),
  selectedRationale: z.string(),
  /** Remote branch head observed immediately after checkout, before any local
   * merge-base preparation. Finalize compares its fresh fetch to this SHA. */
  expectedRemoteSha: z.string().optional(),
  preAgentSha: z.string().optional(),
  workflowOwnedBranch: z.object({
    branchName: z.string().min(1),
    pr: z.object({
      id: z.number(),
      url: z.string(),
      branch: z.string(),
    }).optional(),
  }).optional(),
});

export const workspaceManifestSchema = z.object({
  version: z.literal(1),
  repositories: z.array(workspaceRepoSchema),
});

export type WorkspaceRepo = z.infer<typeof workspaceRepoSchema>;
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

export interface WorkspaceRepositoryInput extends SelectedRepository {
  mergeBase?: string;
}

export function buildRepoSlug(repoPath: string): string {
  return repoPath
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("__");
}

export function buildProviderRepoSlug(provider: SelectedRepository["provider"], repoPath: string): string {
  return `${provider}__${buildRepoSlug(repoPath)}`;
}

export function buildWorkspaceLocalPath(
  provider: SelectedRepository["provider"],
  repoPath: string,
  index: number,
): string {
  return index === 0 ? WORKSPACE_ROOT_DIR : `${WORKSPACE_REPOS_DIR}/${buildProviderRepoSlug(provider, repoPath)}`;
}

export function buildWorkspaceManifest(input: {
  branchName: string;
  repositories: WorkspaceRepositoryInput[];
}): WorkspaceManifest {
  const seen = new Set<string>();
  return {
    version: 1,
    repositories: input.repositories.map((repo, index) => {
      const key = `${repo.provider}:${repo.repoPath}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate selected repository: ${key}`);
      }
      seen.add(key);
      const slug = index === 0 ? buildRepoSlug(repo.repoPath) : buildProviderRepoSlug(repo.provider, repo.repoPath);
      return {
        provider: repo.provider,
        repoPath: repo.repoPath,
        slug,
        localPath: buildWorkspaceLocalPath(repo.provider, repo.repoPath, index),
        defaultBranch: repo.defaultBranch,
        branchName: repo.workflowOwnedBranch?.branchName ?? input.branchName,
        ...(repo.mergeBase ? { mergeBase: repo.mergeBase } : {}),
        selectedRationale: repo.selectedRationale,
        ...(repo.workflowOwnedBranch ? { workflowOwnedBranch: repo.workflowOwnedBranch } : {}),
      };
    }),
  };
}

export function parseWorkspaceManifest(raw: string): WorkspaceManifest {
  return workspaceManifestSchema.parse(JSON.parse(raw));
}

/** Parse the sandbox copy and prove that it is still exactly the manifest the
 * manager authored before agent code ran. Arrays remain order-sensitive and
 * object keys are compared independent of serialization order. */
export function parseVerifiedWorkspaceManifest(
  raw: string,
  trusted: WorkspaceManifest,
): WorkspaceManifest {
  const parsedJson: unknown = JSON.parse(raw);
  const manifest = workspaceManifestSchema.parse(parsedJson);
  if (!jsonValuesEqual(parsedJson, trusted)) {
    throw new Error("Workspace manifest does not match the trusted provisioned manifest");
  }
  return manifest;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]),
    );
}
