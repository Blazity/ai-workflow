import { z } from "zod";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

export const WORKSPACE_MANIFEST_PATH = "/vercel/sandbox/aiw-repos.json";
export const WORKSPACE_ROOT_DIR = "/vercel/sandbox";
export const WORKSPACE_REPOS_DIR = "/vercel/sandbox/repos";

const workspaceRepoBaseShape = {
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
};

export const workspaceRepoV1Schema = z.object(workspaceRepoBaseShape);
export const workspaceRepoV2Schema = z.object({
  ...workspaceRepoBaseShape,
  access: z.enum(["read", "write"]),
  researchBaseSha: z.string().min(1).optional(),
});

export const workspaceManifestV1Schema = z.object({
  version: z.literal(1),
  repositories: z.array(workspaceRepoV1Schema),
});
export const workspaceManifestV2Schema = z.object({
  version: z.literal(2),
  repositories: z.array(workspaceRepoV2Schema).max(8),
});

export const workspaceManifestSchema = z.discriminatedUnion("version", [
  workspaceManifestV1Schema,
  workspaceManifestV2Schema,
]);

export type WorkspaceRepoV1 = z.infer<typeof workspaceRepoV1Schema>;
export type WorkspaceRepoV2 = z.infer<typeof workspaceRepoV2Schema>;
export type WorkspaceRepo = WorkspaceRepoV1 | WorkspaceRepoV2;
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
export type WorkspaceManifestV2 = z.infer<typeof workspaceManifestV2Schema>;

export interface WorkspaceRepositoryInput extends SelectedRepository {
  mergeBase?: string;
  /** Per-repository access override. When set it wins over the manifest-wide
   * default, so one provisioning call can attach a write remediation checkout
   * (a repo carrying workflowOwnedBranch) alongside read-only dependencies. */
  access?: "read" | "write";
  /** Baseline the approved plan was reviewed against. When set, provisioning must
   * observe this exact SHA as the checked-out branch's clone-time head (before any
   * local base merge); any drift means the branch moved between approval and clone,
   * so the run must fail loud and replan instead of silently running against
   * different code. Only the approved-scope path sets it; ticket, pr_trigger, and
   * discovery inputs leave it unset. */
  expectedResearchBaseSha?: string;
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

/**
 * A repository's trusted localPath is well-formed when it is either the sandbox
 * root (legacy primary checkout) or exactly this repository's slug directory
 * under the repos dir. Both provisioning paths construct localPaths this way:
 * deterministic provisioning via {@link buildWorkspaceLocalPath} and discovery
 * promotion via the research attach, which uses the same
 * {@link buildProviderRepoSlug}. Binding the path to the repository identity
 * rejects traversal, nesting, and cross-repo aliasing without a filesystem
 * probe, and accepts both the legacy root-primary layout and the
 * discovery-promoted layout where every repository lives under repos/.
 */
export function isValidWorkspaceLocalPath(repository: {
  provider: SelectedRepository["provider"];
  repoPath: string;
  localPath: string;
}): boolean {
  return (
    repository.localPath === WORKSPACE_ROOT_DIR ||
    repository.localPath ===
      `${WORKSPACE_REPOS_DIR}/${buildProviderRepoSlug(repository.provider, repository.repoPath)}`
  );
}

export function buildWorkspaceManifest(input: {
  branchName: string;
  repositories: WorkspaceRepositoryInput[];
  access?: "read" | "write";
}): WorkspaceManifestV2 {
  if (input.repositories.length === 0 || input.repositories.length > 8) {
    throw new Error("Workspace manifest requires between 1 and 8 repositories");
  }
  const seen = new Set<string>();
  return {
    version: 2,
    repositories: input.repositories.map((repo, index) => {
      const key = `${repo.provider}:${repo.repoPath}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate selected repository: ${key}`);
      }
      seen.add(key);
      const slug = index === 0 ? buildRepoSlug(repo.repoPath) : buildProviderRepoSlug(repo.provider, repo.repoPath);
      const access = repo.access ?? input.access ?? "write";
      return {
        provider: repo.provider,
        repoPath: repo.repoPath,
        slug,
        localPath: buildWorkspaceLocalPath(repo.provider, repo.repoPath, index),
        defaultBranch: repo.defaultBranch,
        branchName:
          repo.workflowOwnedBranch?.branchName ??
          (access === "read"
            ? (repo.reviewPullRequest?.branch ?? repo.defaultBranch)
            : input.branchName),
        access,
        ...(repo.mergeBase ? { mergeBase: repo.mergeBase } : {}),
        selectedRationale: repo.selectedRationale,
        ...(repo.workflowOwnedBranch ? { workflowOwnedBranch: repo.workflowOwnedBranch } : {}),
      };
    }),
  };
}

export function workspaceRepositoryAccess(
  manifest: WorkspaceManifest,
  repository: WorkspaceRepo,
): "read" | "write" {
  return manifest.version === 1
    ? "write"
    : (repository as WorkspaceRepoV2).access;
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
