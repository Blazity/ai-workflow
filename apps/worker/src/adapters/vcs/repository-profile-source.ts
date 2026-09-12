/**
 * What one repository says about itself, as the suggestion reads it.
 *
 * An interface plus its bound, with no provider in it: the GitHub and GitLab
 * implementations sit beside this file and answer the same shape, so the
 * suggestion service never branches on a provider and a third provider is a
 * new file rather than a new `if`.
 *
 * The bound is the point of the file. Everything here is fed to a model in one
 * call, and a monorepo's CI directory alone can run to hundreds of kilobytes,
 * so the bundle is cut to a size a single call can carry and it says what it
 * cut. Silent truncation would show up as a model that suddenly proposes
 * nothing for the largest repositories, which is exactly the case an admin
 * would never think to suspect.
 */
import type { VcsProvider } from "./repository-directory.js";

/** One file the bundle carries whole, or as much of it as fits. */
export interface RepositoryProfileFile {
  path: string;
  content: string;
}

/** What the bound removed, so the bundle can say so and the prompt can too. */
interface RepositoryProfileTruncation {
  /** `readme`, or `ci:<path>`, or `manifest:<path>`, or a listing cut at a page
   *  boundary such as `root tree, first 100 entries`. */
  what: string;
  /** Null when the provider never said how much there was. A listing cut at a
   *  page boundary knows what it kept and cannot know what it missed, and
   *  printing "kept 100 of 100" would say the opposite of what happened. */
  originalLength: number | null;
  keptLength: number;
}

/**
 * Everything one repository tells the suggestion about itself.
 *
 * Manifests carry their content because what a project declares is the whole
 * signal; lockfiles carry their NAME only, because a lockfile's content is
 * megabytes of hashes that says nothing the manifest beside it did not already
 * say, and its name is the one fact worth having (which package manager runs
 * here).
 */
export interface RepositoryProfileBundle {
  provider: VcsProvider;
  repoPath: string;
  defaultBranch: string;
  /** The provider's own one-line description, empty when it has none. */
  description: string;
  readme: string;
  manifests: RepositoryProfileFile[];
  lockfiles: string[];
  ciDefinitions: RepositoryProfileFile[];
  languages: string[];
  truncated: RepositoryProfileTruncation[];
}

/**
 * One repository's own account of itself, from the provider it lives on.
 *
 * Bound to a single repository at construction rather than taking one per
 * call: every implementation needs the provider's project handle to make any
 * request at all, and resolving it once is what keeps a caller from asking a
 * GitHub source about a GitLab path.
 */
export interface RepositoryProfileSource {
  loadProfile(): Promise<RepositoryProfileBundle>;
}

/**
 * About 32 KB of text for the whole bundle.
 *
 * Characters, not bytes: the count that matters is the one that reaches the
 * tokenizer, and counting UTF-8 bytes would cut a Japanese README to a third
 * of an English one for no reason a reader could see.
 */
const REPOSITORY_PROFILE_BUNDLE_MAX_LENGTH = 32 * 1024;

/** Appended to whatever the bound cut, so the model reads a file that stops
 *  rather than a file that ends. */
export const REPOSITORY_PROFILE_TRUNCATION_MARKER = "\n[truncated]";

/**
 * The provider does not have this repository any more.
 *
 * Its own type because it is the one profile-read failure that is NOT worth
 * retrying and NOT the provider's fault: a repository deleted, renamed, or
 * moved out of the installation answers 404 on its own metadata, and every
 * other read after that answers 404 too. Reported as "this repository is gone"
 * rather than as "it has no README and no manifests", which is what a
 * best-effort read of a deleted repository otherwise looks like: a bundle of
 * empty strings, a confident model answer built from nothing, and a proposal
 * an admin has no way to tell from a real one.
 *
 * Every implementation therefore reads the repository's own metadata FIRST and
 * alone, and only then reads the rest best effort.
 */
export class RepositoryMissingAtProviderError extends Error {
  constructor(
    readonly provider: VcsProvider,
    readonly repoPath: string,
  ) {
    super(`${provider} no longer exposes ${repoPath}`);
    this.name = "RepositoryMissingAtProviderError";
  }
}

/**
 * One deadline for the WHOLE profile read, per-request bounds included.
 *
 * A per-request timeout bounds one request, and a profile read is a dozen of
 * them in sequence, so a provider answering slowly but not hanging could spend
 * minutes here. That matters because the caller then spends up to 90 seconds
 * more on the model, and the platform kills the invocation at 300 seconds: the
 * two bounds have to add up to less than that with room to spare, or the
 * suggestion dies as an opaque platform error instead of the retryable failure
 * the bounds exist to produce. 60 plus 90 is 150.
 *
 * Implemented as one `AbortSignal.timeout` per `loadProfile`, threaded into
 * every request the source makes, so the deadline is the sum of the work and
 * not a bound on any single piece of it.
 */
export const REPOSITORY_PROFILE_DEADLINE_MS = 60_000;

/** Root files whose CONTENT is worth reading: each one declares what the
 *  project is and how it is built. Matched case sensitively, as every provider
 *  stores them. */
const REPOSITORY_PROFILE_MANIFEST_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "Justfile",
] as const;

/** Root files whose NAME alone is the signal. Their content is hashes. */
const REPOSITORY_PROFILE_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
] as const;

/** Root names a README may take, in the order they are preferred. */
const REPOSITORY_PROFILE_README_FILES = [
  "README.md",
  "README.rst",
  "README.txt",
  "README",
  "readme.md",
] as const;

/** How many files of each kind are fetched at all. A bound on REQUESTS, not
 *  only on the text: a repository with ninety workflow files must not turn one
 *  suggestion into ninety provider calls. */
export const REPOSITORY_PROFILE_MAX_MANIFESTS = 6;
export const REPOSITORY_PROFILE_MAX_CI_FILES = 4;

export function isRepositoryProfileManifest(name: string): boolean {
  return (REPOSITORY_PROFILE_MANIFEST_FILES as readonly string[]).includes(name);
}

export function isRepositoryProfileLockfile(name: string): boolean {
  return (REPOSITORY_PROFILE_LOCKFILES as readonly string[]).includes(name);
}

/** The README among a root listing, or null. The first match in preference
 *  order wins, so a repository carrying both `README.md` and `README` is read
 *  the way its readers read it. */
export function pickRepositoryProfileReadme(names: readonly string[]): string | null {
  for (const candidate of REPOSITORY_PROFILE_README_FILES) {
    if (names.includes(candidate)) return candidate;
  }
  return null;
}

function bundleLength(bundle: RepositoryProfileBundle): number {
  let total =
    bundle.provider.length +
    bundle.repoPath.length +
    bundle.defaultBranch.length +
    bundle.description.length +
    bundle.readme.length;
  for (const name of bundle.lockfiles) total += name.length;
  for (const language of bundle.languages) total += language.length;
  for (const file of [...bundle.manifests, ...bundle.ciDefinitions]) {
    total += file.path.length + file.content.length;
  }
  return total;
}

/**
 * Cut the bundle to the bound, README and CI first.
 *
 * The order is the order of redundancy, not of importance: a README repeats
 * itself and a CI file is mostly boilerplate around the two commands that
 * matter, while a manifest is dense and short. Manifests are cut last and, if
 * it ever comes to that, to nothing rather than dropped, because the path of a
 * manifest is itself a fact worth keeping.
 *
 * Every cut is recorded. A caller that shows the proposal beside the current
 * values can then say which repository the model answered about with half its
 * README, instead of leaving an admin to wonder why the description is thin.
 */
export function boundRepositoryProfileBundle(
  bundle: RepositoryProfileBundle,
  maxLength: number = REPOSITORY_PROFILE_BUNDLE_MAX_LENGTH,
): RepositoryProfileBundle {
  const bounded: RepositoryProfileBundle = {
    ...bundle,
    manifests: bundle.manifests.map((file) => ({ ...file })),
    ciDefinitions: bundle.ciDefinitions.map((file) => ({ ...file })),
    truncated: [...bundle.truncated],
  };
  let overflow = bundleLength(bounded) - maxLength;
  if (overflow <= 0) return bounded;

  const victims: Array<{ what: string; read: () => string; write: (value: string) => void }> = [
    { what: "readme", read: () => bounded.readme, write: (value) => (bounded.readme = value) },
    ...bounded.ciDefinitions.map((file) => ({
      what: `ci:${file.path}`,
      read: () => file.content,
      write: (value: string) => (file.content = value),
    })),
    ...bounded.manifests.map((file) => ({
      what: `manifest:${file.path}`,
      read: () => file.content,
      write: (value: string) => (file.content = value),
    })),
  ];

  for (const victim of victims) {
    if (overflow <= 0) break;
    const original = victim.read();
    if (original.length === 0) continue;
    // Cutting to nothing removes the whole string, marker included; cutting
    // part of it has to pay for the marker out of what is kept, or the bundle
    // grows on the last few characters of the budget.
    const kept =
      original.length <= overflow
        ? ""
        : original.slice(
            0,
            Math.max(
              0,
              original.length - overflow - REPOSITORY_PROFILE_TRUNCATION_MARKER.length,
            ),
          );
    const replacement = kept.length === 0 ? "" : kept + REPOSITORY_PROFILE_TRUNCATION_MARKER;
    overflow -= original.length - replacement.length;
    victim.write(replacement);
    bounded.truncated.push({
      what: victim.what,
      originalLength: original.length,
      keptLength: kept.length,
    });
  }
  return bounded;
}
