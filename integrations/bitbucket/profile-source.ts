/**
 * What a Bitbucket repository says about itself: its metadata, its README, the
 * manifests and the Pipelines definition at its root.
 *
 * Every read is best effort, as on GitHub and GitLab: a repository with no
 * README is ordinary, and still gets a bundle carrying the provider's own
 * metadata. The whole read shares one deadline
 * (`REPOSITORY_PROFILE_DEADLINE_MS`), and the root listing is one page of 100
 * entries, recorded as a truncation when it is full.
 */
import {
  boundRepositoryProfileBundle,
  isRepositoryProfileLockfile,
  isRepositoryProfileManifest,
  pickRepositoryProfileReadme,
  RepositoryMissingAtProviderError,
  REPOSITORY_PROFILE_DEADLINE_MS,
  REPOSITORY_PROFILE_MAX_CI_FILES,
  REPOSITORY_PROFILE_MAX_MANIFESTS,
  type RepositoryProfileBundle,
  type RepositoryProfileFile,
  type RepositoryProfileSource,
} from "@integrations/sdk";
import { branchPath, repositoryPath, type BitbucketClient } from "./client";

/** One page of the root listing, the most the source API returns at once. */
const BITBUCKET_ROOT_PAGE_SIZE = 100;

/** Bitbucket Pipelines reads exactly this file at the repository root. */
const BITBUCKET_CI_FILES = ["bitbucket-pipelines.yml"] as const;

interface BitbucketSourceEntry {
  path?: string;
  type?: string;
}

class BitbucketProfileSource implements RepositoryProfileSource {
  constructor(
    private readonly client: BitbucketClient,
    private readonly repoPath: string,
  ) {}

  private get repo(): string {
    return repositoryPath(this.repoPath);
  }

  async loadProfile(): Promise<RepositoryProfileBundle> {
    const signal = AbortSignal.timeout(REPOSITORY_PROFILE_DEADLINE_MS);
    // The repository's own 404 is not "this path holds nothing": it is the
    // repository being gone, and a bundle of empty strings would describe a
    // repository nobody can open.
    const repository = await this.json<{
      description?: string;
      language?: string;
      mainbranch?: { name?: string } | null;
    }>(this.repo, signal);
    if (!repository) throw new RepositoryMissingAtProviderError("bitbucket", this.repoPath);
    const defaultBranch = repository.mainbranch?.name ?? "";
    // Files are read at the branch's commit: a branch name with a slash in it
    // cannot be told apart from a directory in a source path.
    const branch = defaultBranch
      ? await this.json<{ target?: { hash?: string } }>(
          `${this.repo}/refs/branches/${branchPath(defaultBranch)}`,
          signal,
        )
      : null;
    const commit = branch?.target?.hash ?? "";
    const listing = commit
      ? await this.json<{ values?: BitbucketSourceEntry[] }>(
          `${this.repo}/src/${commit}/?pagelen=${BITBUCKET_ROOT_PAGE_SIZE}`,
          signal,
        )
      : null;
    const entries = Array.isArray(listing?.values) ? listing.values : [];
    const rootFiles = entries
      .filter((entry) => entry.type === "commit_file" && typeof entry.path === "string")
      .map((entry) => entry.path as string);

    const readmeName = pickRepositoryProfileReadme(rootFiles);
    const readme = readmeName ? await this.raw(readmeName, commit, signal) : null;
    const manifests: RepositoryProfileFile[] = [];
    for (const name of rootFiles.filter(isRepositoryProfileManifest).slice(0, REPOSITORY_PROFILE_MAX_MANIFESTS)) {
      manifests.push({ path: name, content: (await this.raw(name, commit, signal)) ?? "" });
    }
    const ciDefinitions: RepositoryProfileFile[] = [];
    for (const name of BITBUCKET_CI_FILES.filter((candidate) => rootFiles.includes(candidate)).slice(
      0,
      REPOSITORY_PROFILE_MAX_CI_FILES,
    )) {
      ciDefinitions.push({ path: name, content: (await this.raw(name, commit, signal)) ?? "" });
    }

    return boundRepositoryProfileBundle({
      provider: "bitbucket",
      repoPath: this.repoPath,
      defaultBranch,
      description: repository.description ?? "",
      readme: readme ?? "",
      manifests,
      lockfiles: rootFiles.filter(isRepositoryProfileLockfile),
      ciDefinitions,
      // Bitbucket records one language per repository, set by its owner.
      languages: repository.language ? [repository.language] : [],
      truncated:
        entries.length >= BITBUCKET_ROOT_PAGE_SIZE
          ? [
              {
                what: `root tree, first ${BITBUCKET_ROOT_PAGE_SIZE} entries`,
                originalLength: null,
                keptLength: entries.length,
              },
            ]
          : [],
    });
  }

  private async request(path: string, signal: AbortSignal, accept?: string): Promise<Response | null> {
    const response = await this.client.send(path, { signal, ...(accept ? { headers: { Accept: accept } } : {}) });
    // A path the repository does not have is the normal answer for a missing
    // README; anything else fails the bundle, because a 401 read as "no
    // README" would describe a repository nobody could read.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Bitbucket profile read failed for ${path}: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  private async json<T>(path: string, signal: AbortSignal): Promise<T | null> {
    const response = await this.request(path, signal);
    return response ? ((await response.json()) as T) : null;
  }

  private async raw(filePath: string, commit: string, signal: AbortSignal): Promise<string | null> {
    const response = await this.request(
      `${this.repo}/src/${commit}/${filePath.split("/").map(encodeURIComponent).join("/")}`,
      signal,
      "*/*",
    );
    return response ? await response.text() : null;
  }
}

/** A profile source for one Bitbucket repository, `workspace/repo`. */
export function createBitbucketProfileSource(
  client: BitbucketClient,
  repoPath: string,
): RepositoryProfileSource {
  return new BitbucketProfileSource(client, repoPath);
}
