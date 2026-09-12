/**
 * What a GitHub repository says about itself.
 *
 * Built on the same App-authenticated Octokit the rest of the GitHub adapter
 * uses (`buildOctokit`), so a deployment that can list its installation can
 * read a profile with no second credential and no second code path.
 *
 * Every read here is best effort by design. A repository with no README, no
 * manifests and no workflows is a perfectly ordinary repository, and the one
 * thing this must never do is turn "there is nothing to read" into a failed
 * suggestion: the provider metadata alone is a bundle, and the model is asked
 * to answer from it.
 */
import { buildOctokit, type GitHubAppAuth } from "../github-auth.js";
import {
  boundRepositoryProfileBundle,
  isRepositoryProfileLockfile,
  isRepositoryProfileManifest,
  RepositoryMissingAtProviderError,
  REPOSITORY_PROFILE_DEADLINE_MS,
  REPOSITORY_PROFILE_MAX_CI_FILES,
  REPOSITORY_PROFILE_MAX_MANIFESTS,
  type RepositoryProfileBundle,
  type RepositoryProfileFile,
  type RepositoryProfileSource,
} from "../repository-profile-source.js";

const WORKFLOWS_PATH = ".github/workflows";

/** True for the provider's "that path holds nothing", which is the normal
 *  answer for a repository without a README or without workflows. */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: number }).status === 404
  );
}

/** One Octokit answer, or null for the 404 that means "this repository has no
 *  such path". Typed loosely for the same reason the repository directory
 *  types its Octokit loosely: the response shapes differ per endpoint and the
 *  five fields read here are checked at the point of use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OctokitAnswer = { data?: any } | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function orAbsent(work: Promise<any>): Promise<OctokitAnswer> {
  try {
    return await work;
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

/** The repository every call names, plus the one deadline they all share. */
interface GitHubProfileTarget {
  owner: string;
  repo: string;
  request: { signal: AbortSignal };
}

function decode(value: unknown, encoding: unknown): string {
  if (typeof value !== "string") return "";
  if (encoding === "base64") return Buffer.from(value, "base64").toString("utf8");
  return value;
}

class GitHubProfileSource implements RepositoryProfileSource {
  constructor(
    private readonly auth: GitHubAppAuth,
    private readonly owner: string,
    private readonly repo: string,
    private readonly repoPath: string,
  ) {}

  async loadProfile(): Promise<RepositoryProfileBundle> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octokit = buildOctokit(this.auth) as any;
    // `buildOctokit` sets no timeout of its own, so without this a GitHub that
    // accepts the connection and never answers holds the invocation until the
    // platform kills it. One signal for the whole read, threaded into every
    // call below through Octokit's `request.signal`.
    const signal = AbortSignal.timeout(REPOSITORY_PROFILE_DEADLINE_MS);
    const target: GitHubProfileTarget = {
      owner: this.owner,
      repo: this.repo,
      request: { signal },
    };

    // The repository's own metadata first and ALONE, because its 404 means
    // something no other 404 here means: the repository is gone. Folded into
    // the batch below it would be swallowed as "no description", and the rest
    // of the reads would answer 404 too, so a deleted repository would come
    // back as a bundle of empty strings and be described confidently from
    // nothing.
    const repository = await octokit.repos.get(target).catch((error: unknown) => {
      if (isAbsent(error)) {
        throw new RepositoryMissingAtProviderError("github", this.repoPath);
      }
      throw error;
    });

    const [readme, languages, root] = await Promise.all([
      orAbsent(octokit.repos.getReadme(target)),
      orAbsent(octokit.repos.listLanguages(target)),
      orAbsent(octokit.repos.getContent({ ...target, path: "" })),
    ]);

    const rootEntries: Array<{ name?: string; type?: string }> = Array.isArray(root?.data)
      ? root.data
      : [];
    const rootFiles = rootEntries
      .filter((entry) => entry.type === "file" && typeof entry.name === "string")
      .map((entry) => entry.name as string);

    const manifests = await this.readManifests(octokit, target, rootFiles);
    const ciDefinitions = await this.readWorkflows(octokit, target);

    return boundRepositoryProfileBundle({
      provider: "github",
      repoPath: this.repoPath,
      defaultBranch: repository?.data?.default_branch ?? "",
      description: repository?.data?.description ?? "",
      readme: decode(readme?.data?.content, readme?.data?.encoding),
      manifests,
      lockfiles: rootFiles.filter(isRepositoryProfileLockfile),
      ciDefinitions,
      languages: Object.keys(languages?.data ?? {}),
      truncated: [],
    });
  }

  private async readManifests(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    octokit: any,
    target: GitHubProfileTarget,
    rootFiles: string[],
  ): Promise<RepositoryProfileFile[]> {
    const wanted = rootFiles
      .filter(isRepositoryProfileManifest)
      .slice(0, REPOSITORY_PROFILE_MAX_MANIFESTS);
    const files: RepositoryProfileFile[] = [];
    for (const name of wanted) {
      const response = await orAbsent(octokit.repos.getContent({ ...target, path: name }));
      const content = decode(response?.data?.content, response?.data?.encoding);
      files.push({ path: name, content });
    }
    return files;
  }

  private async readWorkflows(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    octokit: any,
    target: GitHubProfileTarget,
  ): Promise<RepositoryProfileFile[]> {
    const listing = await orAbsent(
      octokit.repos.getContent({ ...target, path: WORKFLOWS_PATH }),
    );
    const entries: Array<{ name?: string; path?: string; type?: string }> = Array.isArray(
      listing?.data,
    )
      ? listing.data
      : [];
    const wanted = entries
      .filter(
        (entry) =>
          entry.type === "file" &&
          typeof entry.path === "string" &&
          /\.ya?ml$/u.test(entry.name ?? ""),
      )
      .slice(0, REPOSITORY_PROFILE_MAX_CI_FILES);
    const files: RepositoryProfileFile[] = [];
    for (const entry of wanted) {
      const response = await orAbsent(
        octokit.repos.getContent({ ...target, path: entry.path as string }),
      );
      files.push({
        path: entry.path as string,
        content: decode(response?.data?.content, response?.data?.encoding),
      });
    }
    return files;
  }
}

/**
 * A profile source for one GitHub repository, addressed exactly the way
 * `createVCSForRepository` addresses one: `owner/repo`, refused rather than
 * guessed at when it is spelled any other way.
 */
export function createGitHubProfileSource(
  auth: GitHubAppAuth,
  repoPath: string,
): RepositoryProfileSource {
  const parts = repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repoPath for GitHub: expected exactly "owner/repo", got "${repoPath}"`,
    );
  }
  return new GitHubProfileSource(auth, parts[0], parts[1], repoPath);
}
