import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { configuredReplaySecrets } from "../run-observability/configured-secrets.js";
import { redactConfiguredSecretsInText } from "../run-observability/sanitizer.js";
import {
  WORKSPACE_ROOT_DIR,
  type WorkspaceManifest,
} from "../sandbox/repo-workspace.js";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.get>>;

/** Exactly the path the agent still reads and commits, relative to its cwd, so
 * the store and the working copy stay the same document. */
const MEMORY_DIR = "blazebot/memory";
const TRUNCATION_MARKER = "<!-- truncated by blazebot memory store -->";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface WorkspaceMemoryTarget {
  sandboxId: string;
  subjectKey: string;
  ticketKey: string | null;
  /** Ticket identifier for ticket runs, PR subject key for PR triggers: the
   * same value write-human-decisions-memory names the file after. */
  taskId: string;
  /**
   * Manager-authored manifest carried on EngineCtx. Never a manifest read back
   * from the sandbox (see blocks/types.ts).
   *
   * Both steps only handle the document at the agent's cwd (WORKSPACE_ROOT_DIR),
   * which is where the agent writes it. The copies write-human-decisions-memory
   * mirrors into the other write-scoped repositories are deliberately not
   * persisted; stage 3 has to account for that if it makes them authoritative.
   */
  workspaceManifest: WorkspaceManifest;
  runId: string;
}

export interface HydrateWorkspaceMemoryResult {
  source: "db" | "repo" | "none";
  /** True when the repository checked out at the agent's cwd tracks the memory
   * file. Stage 3 cannot hide a tracked file from the PR with git excludes. */
  trackedInRepo: boolean;
  /** True only when the stored document was written into the workspace. */
  written: boolean;
}

export interface PersistWorkspaceMemoryResult {
  persisted: boolean;
}

/**
 * Writes the stored memory document to the agent's cwd before any block runs, or
 * seeds the store once from the file the workspace already carries. A file the
 * root repository already tracks is never overwritten, so the checkout keeps
 * exactly the behavior it has today. Best effort: memory is an optimization,
 * never a run blocker.
 */
export async function hydrateWorkspaceMemoryStep(
  input: WorkspaceMemoryTarget,
): Promise<HydrateWorkspaceMemoryResult> {
  "use step";
  try {
    // Inside the try so an invalid task id lands in this step's own log. The
    // review workspace degrades to no document instead of throwing; both are
    // safe, and the asymmetry is deliberate: there the copy is optional, here the
    // step owns the failure report.
    const docPath = memoryDocPath(input.taskId);
    const absolutePath = `${WORKSPACE_ROOT_DIR}/${docPath}`;
    const { logger } = await import("../lib/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      subjectKey: input.subjectKey,
      docPath,
      step: "hydrateWorkspaceMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../sandbox/credentials.js");
    const { getDb } = await import("../db/client.js");
    const { MAX_MEMORY_DOCUMENT_BYTES, getMemoryDocument, upsertMemoryDocument } =
      await import("../memory/store.js");
    const sandbox = await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    });

    // Only a repository checked out at the agent's cwd can track this path. In
    // the discovery-promoted layout every repository lives under repos/<slug>,
    // so the document sits outside all of them and no git state is involved.
    const rootRepository = input.workspaceManifest.repositories.find(
      (repository) => repository.localPath === WORKSPACE_ROOT_DIR,
    );
    let trackedInRepo = false;
    if (rootRepository) {
      const tracked = await sandbox.runCommand("git", [
        "-C",
        WORKSPACE_ROOT_DIR,
        "ls-files",
        "--",
        docPath,
      ]);
      // Fail closed: an unanswered probe cannot rule out a tracked file, and
      // overwriting one would leave a tracked modification behind.
      if (tracked.exitCode !== 0) {
        log.warn(
          { repo: rootRepository.repoPath, exitCode: tracked.exitCode },
          "memory_document_tracked_probe_failed",
        );
        return { source: "none", trackedInRepo: false, written: false };
      }
      if ((await tracked.stdout()).trim().length > 0) {
        trackedInRepo = true;
        log.info({ repo: rootRepository.repoPath }, "memory_document_tracked_in_repo");
      }
    }

    const stored = await getMemoryDocument(getDb(), input.subjectKey, docPath);
    if (stored) {
      if (trackedInRepo) {
        // Overwriting a tracked file is a tracked modification, which the
        // publication and workspace-gate cleanliness checks reject unless the
        // agent commits it. The committed copy stays the one the agent reads;
        // persist still captures it at the end of the run.
        log.info(
          { repo: rootRepository?.repoPath },
          "memory_hydration_skipped_tracked",
        );
        return { source: "db", trackedInRepo, written: false };
      }
      // writeFiles does not guarantee mkdir -p semantics.
      await sandbox.runCommand("mkdir", ["-p", parentDirectory(absolutePath)]);
      await sandbox.writeFiles([
        { path: absolutePath, content: Buffer.from(stored.content) },
      ]);
      log.info({ bytes: stored.bytes }, "memory_document_hydrated_from_store");
      return { source: "db", trackedInRepo, written: true };
    }

    // One-time migration of the legacy committed file. This only reads the tree
    // and writes the store, so the workspace is left untouched either way.
    const legacy = await readLegacyMemoryFile(
      sandbox,
      absolutePath,
      input.workspaceManifest,
      docPath,
      MAX_MEMORY_DOCUMENT_BYTES,
    );
    if (!legacy || legacy.text.trim().length === 0) {
      return { source: "none", trackedInRepo, written: false };
    }
    const prepared = prepareMemoryContent(
      legacy.text,
      MAX_MEMORY_DOCUMENT_BYTES,
      legacy.truncated,
    );
    if (!prepared) {
      log.warn({}, "memory_document_redaction_failed");
      return { source: "none", trackedInRepo, written: false };
    }
    await upsertMemoryDocument(getDb(), {
      subjectKey: input.subjectKey,
      docPath,
      ticketKey: input.ticketKey,
      content: prepared.content,
      sourceRunId: input.runId,
    });
    log.info({ truncated: prepared.truncated }, "memory_document_seeded_from_repo");
    return { source: "repo", trackedInRepo, written: false };
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      {
        sandboxId: input.sandboxId,
        subjectKey: input.subjectKey,
        taskId: input.taskId,
        step: "hydrateWorkspaceMemory",
        err: errorMessage(err),
      },
      "memory_document_hydrate_failed",
    );
    return { source: "none", trackedInRepo: false, written: false };
  }
}
hydrateWorkspaceMemoryStep.maxRetries = 0;

/**
 * Copies the memory document from the agent's cwd into the store at the end of
 * the run, including failed and canceled runs. Best effort: this runs inside the
 * teardown path, which must never fail because of memory.
 */
export async function persistWorkspaceMemoryStep(
  input: WorkspaceMemoryTarget,
): Promise<PersistWorkspaceMemoryResult> {
  "use step";
  try {
    // Inside the try for the same reason as the hydration step above.
    const docPath = memoryDocPath(input.taskId);
    const absolutePath = `${WORKSPACE_ROOT_DIR}/${docPath}`;
    const { logger } = await import("../lib/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      subjectKey: input.subjectKey,
      docPath,
      runId: input.runId,
      step: "persistWorkspaceMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../sandbox/credentials.js");
    const { getDb } = await import("../db/client.js");
    const { MAX_MEMORY_DOCUMENT_BYTES, upsertMemoryDocument } = await import(
      "../memory/store.js"
    );
    const sandbox = await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    });

    const file = await readMemoryFile(sandbox, absolutePath, MAX_MEMORY_DOCUMENT_BYTES);
    if (!file || file.text.trim().length === 0) return { persisted: false };
    const prepared = prepareMemoryContent(
      file.text,
      MAX_MEMORY_DOCUMENT_BYTES,
      file.truncated,
    );
    // Fail closed: text that could not be scrubbed never reaches the database.
    if (!prepared) {
      log.warn({}, "memory_document_redaction_failed");
      return { persisted: false };
    }
    if (prepared.truncated) {
      log.warn({ maxBytes: MAX_MEMORY_DOCUMENT_BYTES }, "memory_document_truncated");
    }
    await upsertMemoryDocument(getDb(), {
      subjectKey: input.subjectKey,
      docPath,
      ticketKey: input.ticketKey,
      content: prepared.content,
      sourceRunId: input.runId,
    });
    log.info({ bytes: utf8Bytes(prepared.content) }, "memory_document_persisted");
    return { persisted: true };
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      {
        sandboxId: input.sandboxId,
        subjectKey: input.subjectKey,
        taskId: input.taskId,
        runId: input.runId,
        step: "persistWorkspaceMemory",
        err: errorMessage(err),
      },
      "memory_document_persist_failed",
    );
    return { persisted: false };
  }
}
persistWorkspaceMemoryStep.maxRetries = 0;

function memoryDocPath(taskId: string): string {
  // A task id may never walk out of the memory directory.
  if (taskId.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${MEMORY_DIR}/${taskId}.md`;
}

/** PR subject keys contain slashes, so the directory to create is derived from
 * the resolved path instead of the fixed memory dir. */
function parentDirectory(absolutePath: string): string {
  return absolutePath.slice(0, absolutePath.lastIndexOf("/"));
}

/**
 * The agent's cwd first. In the discovery-promoted layout the primary repository
 * sits under repos/<slug>, so a document an earlier run committed lives there and
 * is the only copy worth seeding from.
 */
async function readLegacyMemoryFile(
  sandbox: SandboxInstance,
  absolutePath: string,
  manifest: WorkspaceManifest,
  docPath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const atRoot = await readMemoryFile(sandbox, absolutePath, maxBytes);
  if (atRoot) return atRoot;
  const primary = manifest.repositories[0];
  if (!primary || primary.localPath === WORKSPACE_ROOT_DIR) return null;
  return readMemoryFile(sandbox, `${primary.localPath}/${docPath}`, maxBytes);
}

async function readMemoryFile(
  sandbox: SandboxInstance,
  absolutePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const stream = await sandbox.readFile({ path: absolutePath });
  if (stream === null) return null;
  return readCappedStream(stream, maxBytes);
}

/**
 * Mirrors readRepositoryInstructionStream but keeps the bytes it already read:
 * an oversized memory document is stored truncated with a marker, not dropped.
 */
async function readCappedStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > maxBytes) {
      truncated = true;
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      break;
    }
  }
  const bytes = Buffer.concat(chunks, size);
  const text = bytes.subarray(0, utf8BoundaryEnd(bytes, maxBytes)).toString("utf8");
  return { text, truncated };
}

/**
 * Order matters: Postgres text rejects NUL outright (the driver throws a raw
 * error), redaction changes the byte count, so the cap is measured last on the
 * bytes that actually get stored. Only configured secrets are rewritten, because
 * the agent reads this document back and everything else has to stay verbatim.
 */
function prepareMemoryContent(
  raw: string,
  maxBytes: number,
  sourceTruncated: boolean,
): { content: string; truncated: boolean } | null {
  let content: string;
  try {
    content = redactConfiguredSecretsInText(
      raw.replace(/\0/g, ""),
      configuredReplaySecrets(),
    );
  } catch {
    return null;
  }
  if (!sourceTruncated && utf8Bytes(content) <= maxBytes) {
    return { content, truncated: false };
  }
  const suffix = `\n${TRUNCATION_MARKER}`;
  const head = sliceUtf8Head(content, maxBytes - utf8Bytes(suffix));
  return { content: `${head}${suffix}`, truncated: true };
}

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function sliceUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = utf8Encoder.encode(value);
  return utf8Decoder.decode(encoded.subarray(0, utf8BoundaryEnd(encoded, maxBytes)));
}

/** Largest cut at or below maxBytes that does not split a character: UTF-8
 * continuation bytes are 0b10xxxxxx, so walk back off them. */
function utf8BoundaryEnd(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.byteLength <= maxBytes) return bytes.byteLength;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return end;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
