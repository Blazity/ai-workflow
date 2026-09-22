/**
 * Reading a GitHub repository's files at an exact commit, which is how agent
 * skills are imported from one.
 *
 * This is the GitHub half of the `RepositorySkillSource` port and nothing else.
 * Every decision a skill import makes (which directories are containers, what a
 * valid `SKILL.md` is, how an artifact is hashed, what is persisted) stays in
 * core; what core cannot own is the four provider calls below, plus the tarball
 * this provider answers `getFiles` with.
 *
 * Moved here from `apps/worker/src/harness-profiles/github-skills.ts`, which
 * held a second Octokit client inside core.
 */
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type {
  RepositorySkillSource,
  RepositorySkillTreeEntry,
} from "@integrations/sdk";
import { extract } from "tar-stream";
import { buildOctokit, type GitHubAppCredential } from "./auth";

/**
 * A provider failure that already knows which HTTP status it deserves.
 *
 * Core maps a skill import failure to a status for the dashboard, and its own
 * error class (`HarnessSkillImportError`) is core-owned, so an integration
 * cannot throw one. Without this, every failure here would arrive in core as an
 * anonymous `Error` and collapse into one generic 422: a 50 MiB archive would
 * stop reporting 413, and "this repository has no default branch" would stop
 * being distinguishable from "GitHub refused the token".
 *
 * So the status travels on the error as a plain number, and core reads it
 * structurally rather than by importing this class, which would name a provider
 * in core again.
 */
export class SkillSourceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SkillSourceError";
  }
}

/**
 * One GitHub call, with GitHub's refusal turned into a sentence.
 *
 * Octokit rejects with a `RequestError` carrying the HTTP status, and core
 * takes any error with a 4xx `status` as one that already chose its answer, so
 * GitHub's own "Not Found" and "Resource not accessible by integration" used
 * to reach the dashboard verbatim. What a person can act on is which of two
 * things went wrong: the repository is not there for this installation, or the
 * installation may not read it. Anything else, a GitHub outage included, loses
 * its status and gets core's generic answer.
 */
async function gitHubCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SkillSourceError) throw error;
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404) {
      throw new SkillSourceError(
        "GitHub repository not found, or not part of this App installation",
        404,
      );
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      throw new SkillSourceError(
        "The GitHub App installation cannot read this repository",
        422,
      );
    }
    throw new Error("GitHub could not be reached to read this repository", { cause: error });
  }
}

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

/**
 * The whole repository snapshot GitHub hands back for one commit. Bounded
 * because the archive is buffered in memory before it is unpacked.
 */
const MAX_REPOSITORY_ARCHIVE_BYTES = 50 * 1024 * 1024;

/**
 * Mirrors `HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes` in `@shared/contracts`,
 * which an integration may not import (the boundaries gate and the conformance
 * dependency check both say so) and the SDK does not re-export. Core re-checks
 * the same bound per file after extraction, so this copy is only the guard that
 * stops one oversized member of the tarball being buffered in full first.
 */
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

/**
 * The port, backed by the App installation this deployment is connected as.
 *
 * Octokit mints and refreshes the installation token per request, so the client
 * is built once per import rather than per call.
 */
export function createGitHubSkillSource(
  credential: GitHubAppCredential,
): RepositorySkillSource {
  const octokit = buildOctokit(credential);
  return {
    async getDefaultBranch(input) {
      const response = await gitHubCall(() =>
        octokit.repos.get({
          owner: input.owner,
          repo: input.repository,
        }),
      );
      if (!response.data.default_branch) {
        throw new SkillSourceError("GitHub repository has no default branch", 422);
      }
      return response.data.default_branch;
    },
    async resolveCommit(input) {
      const response = await gitHubCall(() =>
        octokit.repos.getCommit({
          owner: input.owner,
          repo: input.repository,
          ref: input.ref,
        }),
      );
      const treeSha = response.data.commit.tree.sha;
      if (!COMMIT_SHA_PATTERN.test(response.data.sha) || !treeSha) {
        throw new SkillSourceError("GitHub returned an invalid commit", 422);
      }
      return { commitSha: response.data.sha, treeSha };
    },
    async getTree(input) {
      const response = await gitHubCall(() =>
        octokit.git.getTree({
          owner: input.owner,
          repo: input.repository,
          tree_sha: input.treeSha,
          recursive: "true",
        }),
      );
      const entries: RepositorySkillTreeEntry[] = [];
      for (const entry of response.data.tree) {
        if (
          !entry.path ||
          !entry.mode ||
          !entry.type ||
          !entry.sha ||
          !["blob", "tree", "commit"].includes(entry.type)
        ) {
          throw new SkillSourceError(
            "GitHub repository tree contains an unsupported entry",
            422,
          );
        }
        entries.push({
          path: entry.path,
          mode: entry.mode,
          type: entry.type as RepositorySkillTreeEntry["type"],
          sha: entry.sha,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        });
      }
      return {
        entries,
        truncated: response.data.truncated === true,
      };
    },
    async getFiles(input) {
      const response = await gitHubCall(() =>
        octokit.repos.downloadTarballArchive({
          owner: input.owner,
          repo: input.repository,
          ref: input.commitSha,
        }),
      );
      const archive = toArchiveBuffer(response.data);
      if (archive.byteLength > MAX_REPOSITORY_ARCHIVE_BYTES) {
        throw new SkillSourceError(
          "GitHub repository snapshot exceeds the 50 MiB download limit",
          413,
        );
      }
      return extractRepositoryFiles(archive, new Set(input.paths));
    },
  };
}

function toArchiveBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new SkillSourceError(
    "GitHub returned a repository snapshot in an unsupported format",
    422,
  );
}

/**
 * The wanted files of a `git archive` tarball, and nothing else.
 *
 * GitHub wraps the whole repository in one generated root directory, so the
 * first segment of every member is stripped and every member has to agree on
 * it: two roots mean this is not the archive we asked for. Paths are validated
 * before they are used as map keys, so a member named `../..` cannot reach a
 * caller that later joins it onto a directory.
 */
export async function extractRepositoryFiles(
  archive: Buffer,
  wantedPaths: Set<string>,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let rootDirectory: string | null = null;
  let validationError: SkillSourceError | null = null;
  const extractor = extract();

  extractor.on("entry", (header, stream, next) => {
    if (validationError) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    let repositoryPath: string;
    try {
      if (header.name.includes("\\") || header.name.includes("\0")) {
        throw new SkillSourceError(
          "GitHub repository snapshot contains an unsafe path",
          422,
        );
      }
      const segments = header.name.split("/").filter(Boolean);
      const [root, ...relativeSegments] = segments;
      if (!root) {
        throw new SkillSourceError(
          "GitHub repository snapshot is missing its root directory",
          422,
        );
      }
      if (rootDirectory === null) rootDirectory = root;
      if (rootDirectory !== root) {
        throw new SkillSourceError(
          "GitHub repository snapshot contains multiple root directories",
          422,
        );
      }
      repositoryPath = normalizeRepositoryPath(relativeSegments.join("/"));
    } catch (error) {
      validationError =
        error instanceof SkillSourceError
          ? error
          : new SkillSourceError(
              "GitHub repository snapshot contains an unsafe path",
              422,
            );
      stream.on("end", next);
      stream.resume();
      return;
    }

    if (
      repositoryPath === "" ||
      header.type !== "file" ||
      !wantedPaths.has(repositoryPath)
    ) {
      stream.on("end", next);
      stream.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (validationError) return;
      size += chunk.byteLength;
      if (size > MAX_SNAPSHOT_FILE_BYTES) {
        validationError = new SkillSourceError(
          `File "${repositoryPath}" is too large`,
          413,
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on("error", (error) => extractor.destroy(error));
    stream.on("end", () => {
      if (validationError) {
        next();
        return;
      }
      if (files.has(repositoryPath)) {
        validationError = new SkillSourceError(
          `GitHub repository snapshot contains duplicate file "${repositoryPath}"`,
          422,
        );
        next();
        return;
      }
      files.set(repositoryPath, Buffer.concat(chunks, size));
      next();
    });
  });

  try {
    await pipeline(Readable.from([archive]), createGunzip(), extractor);
  } catch (error) {
    if (error instanceof SkillSourceError) throw error;
    throw new SkillSourceError(
      "GitHub repository snapshot could not be unpacked safely",
      422,
    );
  }
  if (validationError) throw validationError;
  return files;
}

/** The same rule core applies to a repository path, before the path is a key. */
function normalizeRepositoryPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.normalize(path || ".") !== (path || ".") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new SkillSourceError("Repository path is unsafe", 400);
  }
  return path.replace(/\/+$/, "");
}
