import { z } from "zod";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

export const WORKSPACE_MANIFEST_PATH = "/vercel/sandbox/aiw-repos.json";
export const WORKSPACE_REPOS_DIR = "/vercel/sandbox/repos";

export const workspaceRepoSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  repoPath: z.string().min(1),
  slug: z.string().min(1),
  localPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  branchName: z.string().min(1),
  selectedRationale: z.string(),
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

export function buildRepoSlug(repoPath: string): string {
  return repoPath
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("__");
}

export function buildWorkspaceManifest(input: {
  branchName: string;
  repositories: SelectedRepository[];
}): WorkspaceManifest {
  return {
    version: 1,
    repositories: input.repositories.map((repo) => {
      const slug = buildRepoSlug(repo.repoPath);
      return {
        provider: repo.provider,
        repoPath: repo.repoPath,
        slug,
        localPath: `${WORKSPACE_REPOS_DIR}/${slug}`,
        defaultBranch: repo.defaultBranch,
        branchName: repo.workflowOwnedBranch?.branchName ?? input.branchName,
        selectedRationale: repo.selectedRationale,
        ...(repo.workflowOwnedBranch ? { workflowOwnedBranch: repo.workflowOwnedBranch } : {}),
      };
    }),
  };
}

export function parseWorkspaceManifest(raw: string): WorkspaceManifest {
  return workspaceManifestSchema.parse(JSON.parse(raw));
}
