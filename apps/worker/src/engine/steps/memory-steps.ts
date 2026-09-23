import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { MEMORY_NOTEBOOK_MAX_BYTES } from "@integrations/sdk";
import { fitMemoryText, utf8Bytes, utf8BoundaryEnd } from "../../memory/content.js";
import {
  WORKSPACE_ROOT_DIR,
  type WorkspaceManifest,
} from "../../sandbox/repo-workspace.js";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.get>>;

/**
 * The size of one workspace memory document, in both directions: how much of
 * the agent's file this step reads out of a sandbox, and how much of a
 * recalled notebook it writes into one. The SDK states it
 * (`MEMORY_NOTEBOOK_MAX_BYTES`) because a provider's author has to know it.
 *
 * The read happens before any provider is involved: a stream has to be capped
 * as it is consumed, and there is nothing to ask yet. The provider applies its
 * own limit to what it is given, so a provider that holds less simply stores
 * less. The write is capped whatever the provider returned.
 */
const MAX_WORKSPACE_MEMORY_BYTES = MEMORY_NOTEBOOK_MAX_BYTES;

/** Exactly the path the agent still reads and commits, relative to its cwd, so
 * the store and the working copy stay the same document. */
const MEMORY_DIR = "ai-workflow/memory";
/** The directory older runs wrote to. Still read as a fallback and still gated
 * everywhere, so a document an earlier run stored or committed is not orphaned. */
const LEGACY_MEMORY_DIR = "blazebot/memory";

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
  /**
   * Why this deployment's memory provider could not answer, or absent when it
   * did.
   *
   * ADDED IN S13, and absent on every result stored before it existed, which
   * is what a run replaying across the deploy reads. Absent means "nothing was
   * wrong with memory", which is what every such run in fact saw.
   *
   * It is here because `source: "none"` used to mean two different things that
   * a person reading a run cannot tell apart: this subject has nothing stored,
   * and this deployment's memory could not be reached at all. Now it answers
   * only the first.
   */
  unavailable?: string;
}

export interface PersistWorkspaceMemoryResult {
  persisted: boolean;
  /** As above: absent means memory answered, not that nothing went wrong. */
  unavailable?: string;
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
    const { logger } = await import("../../infra/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      subjectKey: input.subjectKey,
      docPath,
      step: "hydrateWorkspaceMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
    const { activeMemory } = await import("../support/memory-runtime.js");
    const memory = await activeMemory();
    const subject = { key: input.subjectKey, label: input.taskId };
    const scope = { kind: "notebook", name: input.taskId } as const;
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

    // What the provider knows about this piece of work, rendered. Which
    // addresses it reads (the current one, and the one an older run wrote
    // under) is the provider's own business now.
    const recalled = await memory.recall({ subject, scope });
    if (!recalled.ok) {
      // Named, not swallowed. This is the difference between "this ticket has
      // nothing stored", which is the ordinary first run, and "this deployment
      // could not reach memory", which somebody has to be able to see.
      log.warn(
        { code: recalled.code, provider: memory.id, detail: recalled.detail },
        "memory_provider_unavailable",
      );
      return {
        source: "none",
        trackedInRepo,
        written: false,
        unavailable: recalled.detail,
      };
    }
    // Whatever the provider returned, the agent's file is at most the notebook
    // limit, and a cut one says so on its last line (`fitMemoryText`, the one
    // rule for cutting memory). The limit is far above the rule's floor, so
    // the empty fallback is never reached; it exists so that nothing past the
    // limit can be written even then.
    const stored = recalled.held
      ? { content: fitMemoryText(recalled.rendering, MAX_WORKSPACE_MEMORY_BYTES)?.text ?? "" }
      : null;
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
      log.info(
        { bytes: utf8Bytes(stored.content) },
        "memory_document_hydrated_from_store",
      );
      return { source: "db", trackedInRepo, written: true };
    }

    // One-time migration of the legacy committed file. This only reads the tree
    // and hands the text to the provider, so the workspace is left untouched
    // either way.
    const legacy = await readLegacyMemoryFile(
      sandbox,
      input.workspaceManifest,
      docPath,
      legacyMemoryDocPath(input.taskId),
      MAX_WORKSPACE_MEMORY_BYTES,
    );
    if (!legacy || legacy.text.trim().length === 0) {
      return { source: "none", trackedInRepo, written: false };
    }
    const seeded = await memory.observe({
      subject,
      scope,
      runId: input.runId,
      ticketKey: input.ticketKey,
      observation: {
        kind: "document",
        text: legacy.text,
        ...(legacy.truncated ? { sourceTruncated: true as const } : {}),
      },
    });
    if (!seeded.ok) {
      // Every refusal is reported. `rejected` is the text being declined
      // (core could not scrub it of this deployment's secrets, or the
      // provider will not take it), which used to be
      // `memory_document_redaction_failed` here and now carries its own
      // sentence.
      log.warn(
        { code: seeded.code, provider: memory.id, detail: seeded.detail },
        "memory_document_seed_refused",
      );
      return {
        source: "none",
        trackedInRepo,
        written: false,
        unavailable: seeded.detail,
      };
    }
    log.info({ truncated: legacy.truncated }, "memory_document_seeded_from_repo");
    return { source: "repo", trackedInRepo, written: false };
  } catch (err) {
    const { logger } = await import("../../infra/logger.js");
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
    const { logger } = await import("../../infra/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      subjectKey: input.subjectKey,
      docPath,
      runId: input.runId,
      step: "persistWorkspaceMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
    const { activeMemory } = await import("../support/memory-runtime.js");
    const sandbox = await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    });

    // New path first; if it is absent or empty, fall back to the legacy path a
    // run started under the pre-migration prompt wrote its increment to, so that
    // increment is not lost at teardown. Whatever is found is handed to the
    // provider, never written back into the workspace.
    let file = await readMemoryFile(sandbox, absolutePath, MAX_WORKSPACE_MEMORY_BYTES);
    if (!file || file.text.trim().length === 0) {
      file = await readMemoryFile(
        sandbox,
        `${WORKSPACE_ROOT_DIR}/${legacyMemoryDocPath(input.taskId)}`,
        MAX_WORKSPACE_MEMORY_BYTES,
      );
    }
    if (!file || file.text.trim().length === 0) return { persisted: false };
    // Resolved after the read, so a deployment whose memory cannot be reached
    // does not pay a settings read for a workspace that had nothing to capture.
    const memory = await activeMemory();
    const written = await memory.observe({
      subject: { key: input.subjectKey, label: input.taskId },
      scope: { kind: "notebook", name: input.taskId },
      runId: input.runId,
      ticketKey: input.ticketKey,
      observation: {
        kind: "document",
        text: file.text,
        // The read was capped, so the provider is told this is a prefix rather
        // than left to infer it from a length that fits.
        ...(file.truncated ? { sourceTruncated: true as const } : {}),
      },
    });
    if (!written.ok) {
      // The one place a lost capture used to look exactly like a run with an
      // empty notebook. It reports the provider's own sentence, and the caller
      // logs that sentence against the run id (`memory_capture_unavailable`).
      // It does NOT reach the run row: the observation channel the hydrate and
      // seed refusals use is scoped to a block attempt and every attempt is
      // closed by the time this runs.
      log.warn(
        { code: written.code, provider: memory.id, detail: written.detail },
        "memory_provider_unavailable",
      );
      return { persisted: false, unavailable: written.detail };
    }
    log.info({ bytes: utf8Bytes(file.text) }, "memory_document_persisted");
    return { persisted: true };
  } catch (err) {
    const { logger } = await import("../../infra/logger.js");
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

/**
 * Where the document sits IN THE WORKSPACE, which is what this step writes and
 * what the agent's prompt points at.
 *
 * It is spelled here and in the built-in provider, and that is not a second
 * derivation of one thing: this one names a file in a checkout, the other names
 * an address in a store, and they only look alike because the store was built
 * to mirror the checkout. A provider that keeps memory somewhere else changes
 * its address and must not change this path.
 */
function memoryDocPath(taskId: string): string {
  // A task id may never walk out of the memory directory.
  if (taskId.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${MEMORY_DIR}/${taskId}.md`;
}

/** The workspace path an older run wrote to. Read only, for backward-compat. */
function legacyMemoryDocPath(taskId: string): string {
  // A task id may never walk out of the memory directory.
  if (taskId.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${LEGACY_MEMORY_DIR}/${taskId}.md`;
}

/** PR subject keys contain slashes, so the directory to create is derived from
 * the resolved path instead of the fixed memory dir. */
function parentDirectory(absolutePath: string): string {
  return absolutePath.slice(0, absolutePath.lastIndexOf("/"));
}

/**
 * The agent's cwd first. In the discovery-promoted layout the primary repository
 * sits under repos/<slug>, so a document an earlier run committed lives there and
 * is the only copy worth seeding from. Each location is probed at the new path
 * and then the legacy path, so a document committed under the old directory by an
 * earlier run is still seeded.
 */
async function readLegacyMemoryFile(
  sandbox: SandboxInstance,
  manifest: WorkspaceManifest,
  docPath: string,
  legacyDocPath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const candidates = [
    `${WORKSPACE_ROOT_DIR}/${docPath}`,
    `${WORKSPACE_ROOT_DIR}/${legacyDocPath}`,
  ];
  const primary = manifest.repositories[0];
  if (primary && primary.localPath !== WORKSPACE_ROOT_DIR) {
    candidates.push(`${primary.localPath}/${docPath}`, `${primary.localPath}/${legacyDocPath}`);
  }
  for (const candidate of candidates) {
    const found = await readMemoryFile(sandbox, candidate, maxBytes);
    if (found) return found;
  }
  return null;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
