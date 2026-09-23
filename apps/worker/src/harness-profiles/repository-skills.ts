/**
 * Importing agent skills from a repository: what is there, which of it is a
 * skill, and what gets persisted.
 *
 * Every provider call this needs is the `RepositorySkillSource` port, which an
 * integration implements; nothing here knows which provider answered. The one
 * place a provider is still named is the locator parser's `github.com` host
 * check, because the source URL is a value already stored on every imported
 * artifact and rewriting it would orphan them.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  HarnessGitHubSkillSource,
  HarnessSkillArtifact,
  HarnessSkillDiscoveryResponse,
  HarnessSkillImportRequest,
  HarnessSkillSource,
} from "@shared/contracts";
import { HARNESS_SKILL_IMPORT_LIMITS } from "@shared/contracts";
import {
  assertExpectedArtifactHash,
  HarnessSkillArtifactIntegrityError,
  hashHarnessSkillArtifact,
  isGitHubSkillSource,
  parseHarnessSkillMetadata,
  SkillValidationError,
  type SkillSource,
} from "@shared/skills";
import type {
  RepositorySkillSource,
  RepositorySkillTreeEntry,
} from "@integrations/sdk";
import type { Db } from "../db/types.js";
import { sha256Digest } from "./skill-artifact-digest.js";
import {
  persistHarnessSkillArtifactsFromRepository,
  type PersistableSkillArtifact,
} from "./skill-artifact-persistence.js";
import { HarnessSkillImportError } from "./skill-errors.js";
import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
  readHarnessSkillArtifactSource,
} from "../db/repositories/harness-profiles.js";

type HarnessProfileRepository = ReturnType<typeof createHarnessProfileRepository>;

export { HarnessSkillImportError } from "./skill-errors.js";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
// Keep repository discovery compatible with the conventional-first behavior
// of https://github.com/vercel-labs/skills while limiting the catalog to the
// harnesses AI Workflow can materialize.
const STANDARD_SKILL_CONTAINERS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
] as const;

export interface ParsedSkillLocator {
  owner: string;
  repository: string;
  ref: string | null;
  path: string;
}

/**
 * One file of a snapshot, as bytes this file can hash and base64.
 *
 * The port answers `Uint8Array` because its declaration is bundled for the
 * browser; a Node provider already hands back `Buffer`, which is one. The wrap
 * is free in that case and correct in every other, and it is done here so no
 * later caller can reach a plain `Uint8Array` and get `"1,2,3"` out of
 * `toString("base64")`.
 */
function requireSnapshotFile(
  files: Map<string, Uint8Array>,
  path: string,
): Buffer {
  const content = files.get(path);
  if (!content) {
    throw new HarnessSkillImportError(
      422,
      `GitHub repository snapshot is missing "${path}"`,
    );
  }
  return Buffer.isBuffer(content)
    ? content
    : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

export function parseSkillLocator(
  raw: string,
): ParsedSkillLocator {
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

export async function discoverRepositorySkills(input: {
  repository: RepositorySkillSource;
  source: string;
}): Promise<HarnessSkillDiscoveryResponse> {
  const locator = parseSkillLocator(input.source);
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
  const recursiveCandidates = tree.entries
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode === "100644" &&
        posix.basename(entry.path) === "SKILL.md" &&
        pathWithin(locator.path, entry.path),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const candidates =
    locator.path !== ""
      ? recursiveCandidates
      : selectConventionalSkillCandidates(recursiveCandidates);
  if (candidates.length > HARNESS_SKILL_IMPORT_LIMITS.maxFiles) {
    throw new HarnessSkillImportError(
      422,
      `GitHub repository contains more than ${HARNESS_SKILL_IMPORT_LIMITS.maxFiles} skill candidates`,
    );
  }

  const contents =
    candidates.length === 0
      ? new Map<string, Uint8Array>()
      : await readProvider(() =>
          input.repository.getFiles({
            owner: locator.owner,
            repository: locator.repository,
            commitSha: resolved.commitSha,
            paths: candidates.map((candidate) => candidate.path),
          }),
        );
  const skills: HarnessSkillDiscoveryResponse["skills"] = [];
  for (const candidate of candidates) {
    const content = requireSnapshotFile(contents, candidate.path);
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

function selectConventionalSkillCandidates(
  candidates: RepositorySkillTreeEntry[],
): RepositorySkillTreeEntry[] {
  const root = candidates.filter((candidate) => candidate.path === "SKILL.md");
  if (root.length > 0) return root;
  const conventional = candidates.filter((candidate) => {
    const directory = posix.dirname(candidate.path);
    return STANDARD_SKILL_CONTAINERS.some((container) => {
      if (!pathWithin(container, candidate.path)) return false;
      const relative = posix.relative(container, directory);
      return relative !== "" && relative.split("/").length <= 2;
    });
  });
  const preferred = [...root, ...conventional];
  if (preferred.length === 0) return candidates;
  const preferredDirectories = new Set(
    preferred.map((candidate) => posix.dirname(candidate.path)),
  );
  return preferred.filter((candidate) => {
    const directory = posix.dirname(candidate.path);
    for (const parent of preferredDirectories) {
      if (parent !== "." && parent !== directory && pathWithin(parent, directory)) {
        return false;
      }
    }
    return true;
  });
}

export async function importRepositorySkills(
  db: Db,
  input: {
    repository: RepositorySkillSource;
    organizationId: string;
    actorId: string;
    request: HarnessSkillImportRequest;
  },
): Promise<HarnessSkillArtifact[]> {
  return importRepositorySkillsFromSource(createHarnessProfileRepository(db), input);
}

async function importRepositorySkillsFromSource(
  persistence: HarnessProfileRepository,
  input: {
    repository: RepositorySkillSource;
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
  assertExactCommit(source.commitSha, resolved.commitSha);
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
  const wantedPaths = [
    ...new Set(
      tree.entries
        .filter(
          (entry) =>
            entry.type === "blob" &&
            (entry.mode === "100644" || entry.mode === "100755") &&
            selectedPaths.some((selectedPath) =>
              pathWithin(selectedPath, entry.path),
            ),
        )
        .map((entry) => entry.path),
    ),
  ];
  const contents = await readProvider(() =>
    input.repository.getFiles({
      owner: source.owner,
      repository: source.repository,
      commitSha: resolved.commitSha,
      paths: wantedPaths,
    }),
  );
  const artifacts: BuiltArtifact[] = [];
  const names = new Set<string>();
  for (const selectedPath of selectedPaths) {
    let artifact: BuiltArtifact;
    try {
      artifact = await repositorySkillSource.read(
        { ...source, path: selectedPath },
        {
          resolvedSnapshot: {
            commitSha: resolved.commitSha,
            entries: tree.entries,
            contents,
          },
        },
      );
    } catch (error) {
      if (!(error instanceof SkillValidationError)) throw error;
      throw new HarnessSkillImportError(400, error.reason.replace(/\.$/, ""));
    }
    if (names.has(artifact.name)) {
      throw new HarnessSkillImportError(
        400,
        `Selected skills contain duplicate name "${artifact.name}"`,
      );
    }
    names.add(artifact.name);
    artifacts.push(artifact);
  }
  return persistHarnessSkillArtifactsFromRepository(persistence, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifacts,
  });
}

export function importConnectedRepositorySkills(
  input: {
    repository: RepositorySkillSource;
    organizationId: string;
    actorId: string;
    request: HarnessSkillImportRequest;
  },
): Promise<HarnessSkillArtifact[]> {
  return importRepositorySkillsFromSource(
    createConnectedHarnessProfileRepository(),
    input,
  );
}

export async function refreshRepositorySkillArtifact(
  db: Db,
  input: {
    repository: RepositorySkillSource;
    organizationId: string;
    actorId: string;
    artifactHash: string;
  },
): Promise<HarnessSkillArtifact> {
  return refreshRepositorySkillArtifactFromRepository(createHarnessProfileRepository(db), input);
}

export async function refreshRepositorySkillArtifactFromRepository(
  persistence: HarnessProfileRepository,
  input: {
    repository: RepositorySkillSource;
    organizationId: string;
    actorId: string;
    artifactHash: string;
  },
): Promise<HarnessSkillArtifact> {
  const existing = await persistence.getArtifactByHash({
    organizationId: input.organizationId,
    artifactHash: input.artifactHash,
  });
  if (!existing) {
    throw new HarnessSkillImportError(404, "Skill artifact not found");
  }
  // The route hands this an artifactHash straight from the client, so the
  // integrity error has to become a status this file's error mapping knows;
  // unmapped it would surface as a 500.
  let stored: HarnessSkillSource;
  try {
    stored = readHarnessSkillArtifactSource(existing);
  } catch (error) {
    if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
    throw new HarnessSkillImportError(
      400,
      "Only a GitHub-sourced skill artifact can be refreshed",
    );
  }
  // Narrowed before the first provider call. Callers reach the right variant
  // through refreshHarnessSkillArtifact, so this guard catches a miswired
  // caller rather than an operator: a deployment skill refreshes from disk.
  if (!isGitHubSkillSource(stored)) {
    throw new HarnessSkillImportError(
      400,
      "Only a GitHub-sourced skill artifact can be refreshed from GitHub",
    );
  }
  const source = stored;
  const defaultBranch = await readProvider(() =>
    input.repository.getDefaultBranch({
      owner: source.owner,
      repository: source.repository,
    }),
  );
  const resolved = await readProvider(() =>
    input.repository.resolveCommit({
      owner: source.owner,
      repository: source.repository,
      ref: defaultBranch,
    }),
  );
  const [artifact] = await importRepositorySkillsFromSource(persistence, {
    repository: input.repository,
    organizationId: input.organizationId,
    actorId: input.actorId,
    request: {
      source: {
        owner: source.owner,
        repository: source.repository,
        commitSha: resolved.commitSha,
      },
      paths: [source.path],
    },
  });
  return artifact!;
}

interface BuiltArtifact extends PersistableSkillArtifact {
  source: HarnessGitHubSkillSource;
}

interface ResolvedSkillSnapshot {
  commitSha: string;
  entries: RepositorySkillTreeEntry[];
  contents: Map<string, Uint8Array>;
}

export type RepositorySkillReadContext =
  | {
      repository: RepositorySkillSource;
      expectedArtifactHash?: string;
    }
  | {
      resolvedSnapshot: ResolvedSkillSnapshot;
      expectedArtifactHash?: string;
    };

export const repositorySkillSource = {
  kind: "github",
  async discover(input: {
    repository: RepositorySkillSource;
    source: string;
  }) {
    const result = await discoverRepositorySkills(input);
    return result.skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      description: skill.description!,
      snapshot: { ...result.source, path: skill.path },
    }));
  },
  async read(
    snapshot: HarnessGitHubSkillSource,
    context: RepositorySkillReadContext,
  ) {
    const source = exactSkillSource(snapshot);
    const resolvedSnapshot = await resolveSkillSnapshot(source, context);
    const artifact = await buildArtifact({
      source,
      entries: resolvedSnapshot.entries,
      contents: resolvedSnapshot.contents,
    });
    assertExpectedArtifactHash(
      context.expectedArtifactHash,
      artifact.artifactHash,
    );
    return artifact;
  },
} satisfies SkillSource<
  { repository: RepositorySkillSource; source: string },
  HarnessGitHubSkillSource,
  RepositorySkillReadContext
>;

async function resolveSkillSnapshot(
  source: HarnessGitHubSkillSource,
  context: RepositorySkillReadContext,
): Promise<ResolvedSkillSnapshot> {
  if ("resolvedSnapshot" in context) {
    assertExactCommit(source.commitSha, context.resolvedSnapshot.commitSha);
    validateTreeEntries(context.resolvedSnapshot.entries);
    return context.resolvedSnapshot;
  }
  const resolved = await readProvider(() =>
    context.repository.resolveCommit({
      owner: source.owner,
      repository: source.repository,
      ref: source.commitSha,
    }),
  );
  assertExactCommit(source.commitSha, resolved.commitSha);
  const tree = await readProvider(() =>
    context.repository.getTree({
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
  const paths = tree.entries
    .filter(
      (entry) =>
        entry.type === "blob" &&
        (entry.mode === "100644" || entry.mode === "100755") &&
        pathWithin(source.path, entry.path),
    )
    .map((entry) => entry.path);
  const contents = await readProvider(() =>
    context.repository.getFiles({
      owner: source.owner,
      repository: source.repository,
      commitSha: source.commitSha,
      paths,
    }),
  );
  return { commitSha: resolved.commitSha, entries: tree.entries, contents };
}

function exactSkillSource(
  source: HarnessGitHubSkillSource,
): HarnessGitHubSkillSource {
  return {
    ...validateExactSource(source),
    path: normalizeRepositoryPath(source.path, true),
  };
}

function assertExactCommit(expected: string, resolved: string): void {
  if (resolved.toLowerCase() !== expected) {
    throw new HarnessSkillImportError(
      409,
      "GitHub commit changed between discovery and import",
    );
  }
}

async function buildArtifact(input: {
  source: HarnessGitHubSkillSource;
  entries: RepositorySkillTreeEntry[];
  contents: Map<string, Uint8Array>;
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
    const content = requireSnapshotFile(input.contents, entry.path);
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
  const metadata = parseHarnessSkillMetadata(
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
    artifactHash: hashHarnessSkillArtifact(artifact, sha256Digest),
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
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
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

function validateTreeEntries(entries: RepositorySkillTreeEntry[]): void {
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

/**
 * Every call into the skill source, and the only place a provider failure
 * becomes a status.
 *
 * An integration cannot throw `HarnessSkillImportError`, which is core's, so a
 * source that already knows what its failure means says so by putting an HTTP
 * status on the error it throws. That is read structurally rather than by
 * importing a provider's error class, which would name a provider in core
 * again. Anything else is a provider that failed for a reason we have no claim
 * about, and stays the one answer that leaks nothing back to the dashboard.
 *
 * Only a 4xx is carried. A source saying 5xx is describing its own outage, and
 * repeating that verbatim would tell the person their deployment is broken and
 * hand them a provider's message to go with it; that is exactly the case the
 * generic sentence below exists for.
 */
async function readProvider<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HarnessSkillImportError) throw error;
    const declared = declaredSkillSourceStatus(error);
    if (declared) {
      throw new HarnessSkillImportError(declared, (error as Error).message);
    }
    throw new HarnessSkillImportError(
      422,
      "GitHub repository could not be read with the organization installation",
    );
  }
}

function declaredSkillSourceStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const status = (error as { status?: unknown }).status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 499 ||
    error.message.length === 0
  ) {
    return null;
  }
  return status;
}
