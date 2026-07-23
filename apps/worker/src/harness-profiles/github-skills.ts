import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  HarnessSkillArtifact,
  HarnessSkillArtifactFile,
  HarnessSkillDiscoveryResponse,
  HarnessSkillImportRequest,
} from "@shared/contracts";
import { HARNESS_SKILL_IMPORT_LIMITS } from "@shared/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
} from "../db/schema.js";
import { buildOctokit, type GitHubAppAuth } from "../lib/github-auth.js";
import {
  HarnessSkillArtifactIntegrityError,
  hashHarnessSkillArtifact,
  parseHarnessSkillMetadata,
  verifyHarnessSkillArtifact,
} from "./skill-artifact.js";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export interface GitHubSkillTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitHubSkillRepository {
  getDefaultBranch(input: {
    owner: string;
    repository: string;
  }): Promise<string>;
  resolveCommit(input: {
    owner: string;
    repository: string;
    ref: string;
  }): Promise<{ commitSha: string; treeSha: string }>;
  getTree(input: {
    owner: string;
    repository: string;
    treeSha: string;
  }): Promise<{ entries: GitHubSkillTreeEntry[]; truncated: boolean }>;
  getBlob(input: {
    owner: string;
    repository: string;
    sha: string;
  }): Promise<Buffer>;
}

export interface ParsedGitHubSkillLocator {
  owner: string;
  repository: string;
  ref: string | null;
  path: string;
}

export class HarnessSkillImportError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function createGitHubSkillRepository(
  auth: GitHubAppAuth,
): GitHubSkillRepository {
  const octokit = buildOctokit(auth);
  return {
    async getDefaultBranch(input) {
      const response = await octokit.repos.get({
        owner: input.owner,
        repo: input.repository,
      });
      if (!response.data.default_branch) {
        throw new HarnessSkillImportError(
          422,
          "GitHub repository has no default branch",
        );
      }
      return response.data.default_branch;
    },
    async resolveCommit(input) {
      const response = await octokit.repos.getCommit({
        owner: input.owner,
        repo: input.repository,
        ref: input.ref,
      });
      const treeSha = response.data.commit.tree.sha;
      if (!COMMIT_SHA_PATTERN.test(response.data.sha) || !treeSha) {
        throw new HarnessSkillImportError(
          422,
          "GitHub returned an invalid commit",
        );
      }
      return { commitSha: response.data.sha, treeSha };
    },
    async getTree(input) {
      const response = await octokit.git.getTree({
        owner: input.owner,
        repo: input.repository,
        tree_sha: input.treeSha,
        recursive: "true",
      });
      const entries: GitHubSkillTreeEntry[] = [];
      for (const entry of response.data.tree) {
        if (
          !entry.path ||
          !entry.mode ||
          !entry.type ||
          !entry.sha ||
          !["blob", "tree", "commit"].includes(entry.type)
        ) {
          throw new HarnessSkillImportError(
            422,
            "GitHub repository tree contains an unsupported entry",
          );
        }
        entries.push({
          path: entry.path,
          mode: entry.mode,
          type: entry.type as GitHubSkillTreeEntry["type"],
          sha: entry.sha,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        });
      }
      return {
        entries,
        truncated: response.data.truncated === true,
      };
    },
    async getBlob(input) {
      const response = await octokit.git.getBlob({
        owner: input.owner,
        repo: input.repository,
        file_sha: input.sha,
      });
      if (response.data.encoding !== "base64") {
        throw new HarnessSkillImportError(
          422,
          "GitHub returned a blob with an unsupported encoding",
        );
      }
      return Buffer.from(response.data.content.replaceAll("\n", ""), "base64");
    },
  };
}

export function parseGitHubSkillLocator(
  raw: string,
): ParsedGitHubSkillLocator {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) {
    throw new HarnessSkillImportError(400, "Invalid GitHub skill source");
  }
  let segments: string[];
  let ref: string | null = null;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HarnessSkillImportError(400, "Invalid GitHub skill URL");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new HarnessSkillImportError(400, "Invalid GitHub skill URL");
    }
    segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodePathSegment);
    if (segments[2] === "tree") {
      if (!segments[3]) {
        throw new HarnessSkillImportError(400, "GitHub tree URL is incomplete");
      }
      ref = segments[3];
      segments = [segments[0]!, segments[1]!, ...segments.slice(4)];
    }
  } else {
    if (
      raw.startsWith("/") ||
      raw.includes("\\") ||
      raw.includes("\0") ||
      raw.includes("?") ||
      raw.includes("#")
    ) {
      throw new HarnessSkillImportError(400, "Invalid GitHub skill source");
    }
    segments = raw.split("/").map(decodePathSegment);
  }

  if (segments.length < 2) {
    throw new HarnessSkillImportError(
      400,
      "GitHub skill source must include owner and repository",
    );
  }
  const owner = validateRepositorySegment(segments[0]!, "owner");
  const repository = validateRepositorySegment(
    segments[1]!.replace(/\.git$/i, ""),
    "repository",
  );
  const path = normalizeRepositoryPath(segments.slice(2).join("/"), true);
  return { owner, repository, ref, path };
}

export async function discoverGitHubSkills(input: {
  repository: GitHubSkillRepository;
  source: string;
}): Promise<HarnessSkillDiscoveryResponse> {
  const locator = parseGitHubSkillLocator(input.source);
  const ref =
    locator.ref ??
    (await readProvider(() =>
      input.repository.getDefaultBranch({
        owner: locator.owner,
        repository: locator.repository,
      }),
    ));
  const resolved = await readProvider(() =>
    input.repository.resolveCommit({
      owner: locator.owner,
      repository: locator.repository,
      ref,
    }),
  );
  const tree = await readProvider(() =>
    input.repository.getTree({
      owner: locator.owner,
      repository: locator.repository,
      treeSha: resolved.treeSha,
    }),
  );
  if (tree.truncated) {
    throw new HarnessSkillImportError(
      422,
      "GitHub repository tree is too large to discover safely",
    );
  }
  validateTreeEntries(tree.entries);
  const candidates = tree.entries
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode === "100644" &&
        posix.basename(entry.path) === "SKILL.md" &&
        pathWithin(locator.path, entry.path),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  if (candidates.length > HARNESS_SKILL_IMPORT_LIMITS.maxFiles) {
    throw new HarnessSkillImportError(
      422,
      `GitHub repository contains more than ${HARNESS_SKILL_IMPORT_LIMITS.maxFiles} skill candidates`,
    );
  }

  const skills: HarnessSkillDiscoveryResponse["skills"] = [];
  for (const candidate of candidates) {
    const content = await readProvider(() =>
      input.repository.getBlob({
        owner: locator.owner,
        repository: locator.repository,
        sha: candidate.sha,
      }),
    );
    try {
      assertFileSize(content.byteLength);
      const metadata = parseSkillMetadata(content);
      skills.push({
        name: metadata.name,
        path: posix.dirname(candidate.path) === "."
          ? ""
          : posix.dirname(candidate.path),
        description: metadata.description,
      });
    } catch (error) {
      // Discovery returns only valid skills. Import revalidates the selected
      // snapshot and rejects malformed content instead of silently skipping it.
      if (!(error instanceof HarnessSkillImportError)) throw error;
    }
  }
  return {
    source: {
      owner: locator.owner,
      repository: locator.repository,
      commitSha: resolved.commitSha,
    },
    skills,
  };
}

export async function importGitHubSkills(
  db: Db,
  input: {
    repository: GitHubSkillRepository;
    organizationId: string;
    actorId: string;
    request: HarnessSkillImportRequest;
  },
): Promise<HarnessSkillArtifact[]> {
  const source = validateExactSource(input.request.source);
  const selectedPaths = normalizeSelectedPaths(input.request.paths);
  const resolved = await readProvider(() =>
    input.repository.resolveCommit({
      owner: source.owner,
      repository: source.repository,
      ref: source.commitSha,
    }),
  );
  if (resolved.commitSha.toLowerCase() !== source.commitSha.toLowerCase()) {
    throw new HarnessSkillImportError(
      409,
      "GitHub commit changed between discovery and import",
    );
  }
  const tree = await readProvider(() =>
    input.repository.getTree({
      owner: source.owner,
      repository: source.repository,
      treeSha: resolved.treeSha,
    }),
  );
  if (tree.truncated) {
    throw new HarnessSkillImportError(
      422,
      "GitHub repository tree is too large to import safely",
    );
  }
  validateTreeEntries(tree.entries);

  const artifacts: HarnessSkillArtifact[] = [];
  const names = new Set<string>();
  for (const selectedPath of selectedPaths) {
    const artifact = await buildArtifact({
      repository: input.repository,
      source: { ...source, path: selectedPath },
      entries: tree.entries,
    });
    if (names.has(artifact.name)) {
      throw new HarnessSkillImportError(
        400,
        `Selected skills contain duplicate name "${artifact.name}"`,
      );
    }
    names.add(artifact.name);
    artifacts.push(
      await persistArtifact(db, {
        organizationId: input.organizationId,
        actorId: input.actorId,
        artifact,
      }),
    );
  }
  return artifacts;
}

export async function refreshGitHubSkillArtifact(
  db: Db,
  input: {
    repository: GitHubSkillRepository;
    organizationId: string;
    actorId: string;
    artifactHash: string;
  },
): Promise<HarnessSkillArtifact> {
  const [existing] = await db
    .select()
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        eq(harnessSkillArtifacts.artifactHash, input.artifactHash),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new HarnessSkillImportError(404, "Skill artifact not found");
  }
  const defaultBranch = await readProvider(() =>
    input.repository.getDefaultBranch({
      owner: existing.sourceOwner,
      repository: existing.sourceRepository,
    }),
  );
  const resolved = await readProvider(() =>
    input.repository.resolveCommit({
      owner: existing.sourceOwner,
      repository: existing.sourceRepository,
      ref: defaultBranch,
    }),
  );
  const [artifact] = await importGitHubSkills(db, {
    repository: input.repository,
    organizationId: input.organizationId,
    actorId: input.actorId,
    request: {
      source: {
        owner: existing.sourceOwner,
        repository: existing.sourceRepository,
        commitSha: resolved.commitSha,
      },
      paths: [existing.sourcePath],
    },
  });
  return artifact!;
}

interface BuiltArtifact {
  artifactHash: string;
  name: string;
  description: string;
  source: HarnessSkillArtifact["source"];
  files: Array<HarnessSkillArtifactFile & { contentBase64: string }>;
}

async function buildArtifact(input: {
  repository: GitHubSkillRepository;
  source: HarnessSkillArtifact["source"];
  entries: GitHubSkillTreeEntry[];
}): Promise<BuiltArtifact> {
  const selected = input.entries.filter((entry) =>
    pathWithin(input.source.path, entry.path),
  );
  const skillFilePath = input.source.path
    ? `${input.source.path}/SKILL.md`
    : "SKILL.md";
  const skillFile = selected.find((entry) => entry.path === skillFilePath);
  if (
    !skillFile ||
    skillFile.type !== "blob" ||
    skillFile.mode !== "100644"
  ) {
    throw new HarnessSkillImportError(
      400,
      `Selected path "${input.source.path}" is not a valid skill`,
    );
  }
  const nonTrees = selected.filter((entry) => entry.type !== "tree");
  for (const entry of nonTrees) {
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new HarnessSkillImportError(
        400,
        `Skill "${input.source.path}" contains a submodule`,
      );
    }
    if (entry.mode === "120000") {
      throw new HarnessSkillImportError(
        400,
        `Skill "${input.source.path}" contains a symlink`,
      );
    }
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    ) {
      throw new HarnessSkillImportError(
        400,
        `Skill "${input.source.path}" contains an unsupported file`,
      );
    }
  }
  if (nonTrees.length > HARNESS_SKILL_IMPORT_LIMITS.maxFiles) {
    throw new HarnessSkillImportError(
      413,
      `Skill exceeds ${HARNESS_SKILL_IMPORT_LIMITS.maxFiles} files`,
    );
  }
  const knownTotal = nonTrees.reduce((total, entry) => {
    if (
      entry.size !== undefined &&
      entry.size > HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes
    ) {
      throw new HarnessSkillImportError(413, `File "${entry.path}" is too large`);
    }
    return total + (entry.size ?? 0);
  }, 0);
  if (knownTotal > HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes) {
    throw new HarnessSkillImportError(413, "Skill exceeds the 5 MiB size limit");
  }

  let totalBytes = 0;
  const files: BuiltArtifact["files"] = [];
  for (const entry of nonTrees.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const content = await readProvider(() =>
      input.repository.getBlob({
        owner: input.source.owner,
        repository: input.source.repository,
        sha: entry.sha,
      }),
    );
    assertFileSize(content.byteLength, entry.path);
    if (entry.size !== undefined && content.byteLength !== entry.size) {
      throw new HarnessSkillImportError(
        422,
        `GitHub blob size changed for "${entry.path}"`,
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes) {
      throw new HarnessSkillImportError(413, "Skill exceeds the 5 MiB size limit");
    }
    const relativePath = input.source.path
      ? entry.path.slice(input.source.path.length + 1)
      : entry.path;
    normalizeRepositoryPath(relativePath, false);
    files.push({
      path: relativePath,
      mode: entry.mode === "100755" ? 0o755 : 0o644,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    });
  }
  const skillDocument = files.find((file) => file.path === "SKILL.md");
  const metadata = parseSkillMetadata(
    Buffer.from(skillDocument!.contentBase64, "base64"),
  );
  const artifact = {
    source: input.source,
    name: metadata.name,
    description: metadata.description,
    files,
  };
  return {
    ...artifact,
    artifactHash: hashHarnessSkillArtifact(artifact),
  };
}

async function persistArtifact(
  db: Db,
  input: {
    organizationId: string;
    actorId: string;
    artifact: BuiltArtifact;
  },
): Promise<HarnessSkillArtifact> {
  verifyHarnessSkillArtifact({
    artifactHash: input.artifact.artifactHash,
    name: input.artifact.name,
    description: input.artifact.description,
    source: input.artifact.source,
    files: input.artifact.files,
  });
  const fileRows = input.artifact.files.map(
    (file) =>
      sql`(
        ${file.path}::text,
        ${file.mode}::integer,
        ${file.sizeBytes}::integer,
        ${file.sha256}::text,
        ${file.contentBase64}::text
      )`,
  );
  await db.execute(sql`
    WITH inserted_artifact AS (
      INSERT INTO harness_skill_artifacts (
        organization_id,
        artifact_hash,
        name,
        description,
        source_owner,
        source_repository,
        source_path,
        source_commit_sha,
        created_by_id
      )
      VALUES (
        ${input.organizationId},
        ${input.artifact.artifactHash},
        ${input.artifact.name},
        ${input.artifact.description},
        ${input.artifact.source.owner},
        ${input.artifact.source.repository},
        ${input.artifact.source.path},
        ${input.artifact.source.commitSha},
        ${input.actorId}
      )
      ON CONFLICT (organization_id, artifact_hash) DO NOTHING
      RETURNING id
    ), stored_artifact AS (
      SELECT id FROM inserted_artifact
      UNION ALL
      SELECT id
      FROM harness_skill_artifacts
      WHERE organization_id = ${input.organizationId}
        AND artifact_hash = ${input.artifact.artifactHash}
      LIMIT 1
    )
    INSERT INTO harness_skill_artifact_files (
      artifact_id,
      path,
      mode,
      size_bytes,
      sha256,
      content_base64
    )
    SELECT
      stored_artifact.id,
      imported_file.path,
      imported_file.mode,
      imported_file.size_bytes,
      imported_file.sha256,
      imported_file.content_base64
    FROM stored_artifact
    CROSS JOIN (
      VALUES ${sql.join(fileRows, sql`, `)}
    ) AS imported_file(path, mode, size_bytes, sha256, content_base64)
    ON CONFLICT (artifact_id, path) DO NOTHING
  `);
  const [stored] = await db
    .select()
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        eq(
          harnessSkillArtifacts.artifactHash,
          input.artifact.artifactHash,
        ),
      ),
    )
    .limit(1);
  if (!stored) {
    throw new HarnessSkillImportError(409, "Could not persist skill artifact");
  }
  const storedFiles = await db
    .select()
    .from(harnessSkillArtifactFiles)
    .where(eq(harnessSkillArtifactFiles.artifactId, stored.id));
  const source = {
    owner: stored.sourceOwner,
    repository: stored.sourceRepository,
    path: stored.sourcePath,
    commitSha: stored.sourceCommitSha,
  };
  try {
    verifyHarnessSkillArtifact({
      artifactHash: stored.artifactHash,
      name: stored.name,
      description: stored.description,
      source,
      files: storedFiles,
    });
  } catch (error) {
    if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
    throw new HarnessSkillImportError(
      409,
      "Stored skill artifact failed integrity verification",
    );
  }
  return {
    artifactHash: stored.artifactHash,
    organizationId: stored.organizationId,
    name: stored.name,
    description: stored.description,
    source,
    files: storedFiles
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        mode: file.mode,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      })),
    createdAt: stored.createdAt.toISOString(),
    createdById: stored.createdById,
  };
}

function validateExactSource(
  source: HarnessSkillImportRequest["source"],
): HarnessSkillImportRequest["source"] {
  return {
    owner: validateRepositorySegment(source.owner, "owner"),
    repository: validateRepositorySegment(source.repository, "repository"),
    commitSha: validateCommitSha(source.commitSha),
  };
}

function normalizeSelectedPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) {
    throw new HarnessSkillImportError(
      400,
      "Select between one and 100 skills",
    );
  }
  const normalized = paths.map((path) => normalizeRepositoryPath(path, true));
  if (new Set(normalized).size !== normalized.length) {
    throw new HarnessSkillImportError(400, "Selected skill path is duplicated");
  }
  return normalized;
}

function validateTreeEntries(entries: GitHubSkillTreeEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = normalizeRepositoryPath(entry.path, false);
    if (paths.has(path)) {
      throw new HarnessSkillImportError(
        422,
        "GitHub repository tree contains duplicate paths",
      );
    }
    paths.add(path);
    if (!COMMIT_SHA_PATTERN.test(entry.sha)) {
      throw new HarnessSkillImportError(
        422,
        "GitHub repository tree contains an invalid object SHA",
      );
    }
  }
}

function normalizeRepositoryPath(path: string, allowEmpty: boolean): string {
  if (
    typeof path !== "string" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    (!allowEmpty && path.length === 0) ||
    posix.normalize(path || ".") !== (path || ".") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new HarnessSkillImportError(400, "Repository path is unsafe");
  }
  return path.replace(/\/+$/, "");
}

function pathWithin(root: string, path: string): boolean {
  return root.length === 0 || path === root || path.startsWith(`${root}/`);
}

function validateRepositorySegment(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new HarnessSkillImportError(400, `Invalid GitHub ${label}`);
  }
  return value;
}

function validateCommitSha(value: string): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new HarnessSkillImportError(400, "Invalid GitHub commit SHA");
  }
  return value.toLowerCase();
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HarnessSkillImportError(400, "Invalid GitHub skill source");
  }
}

function assertFileSize(size: number, path = "SKILL.md"): void {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes
  ) {
    throw new HarnessSkillImportError(413, `File "${path}" is too large`);
  }
}

function parseSkillMetadata(content: Buffer): {
  name: string;
  description: string;
} {
  try {
    return parseHarnessSkillMetadata(content);
  } catch (error) {
    if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
    throw new HarnessSkillImportError(400, error.message.replace(/\.$/, ""));
  }
}

async function readProvider<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HarnessSkillImportError) throw error;
    throw new HarnessSkillImportError(
      422,
      "GitHub repository could not be read with the organization installation",
    );
  }
}
