import type { WorkflowBlockType } from "@shared/contracts";
import {
  isValidWorkspaceLocalPath,
  workspaceManifestSchema,
  type WorkspaceManifest,
} from "../sandbox/repo-workspace.js";
import type { EffectivePromptRepositorySource } from "./effective-prompt.js";

const INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_REPOSITORY_INSTRUCTION_BYTES = 256 * 1024;
const AI_MEMORY_DIR = ".ai/memory";
/** No accepted name can contain a slash or "..", so no listed entry can walk
 * out of the memory directory it was listed from. */
const AI_MEMORY_NAME_PATTERN = /^[A-Za-z0-9._-]+\.md$/;
const MAX_AI_MEMORY_FILES = 10;
const MAX_AI_MEMORY_BYTES = 32 * 1024;
/** One budget for every repository's .ai/memory content in one invocation. The
 * per-file cap above bounds a single document; without this the ceiling is that
 * cap times the file cap times the manifest's repository cap. Twice the stored
 * memory budget in repo-memory-steps.ts because this corpus is hand written and
 * there is one of it per repository, where that path injects two documents per
 * repository plus the org ones. */
const MAX_AI_MEMORY_TOTAL_BYTES = 64 * 1024;
const MAX_AI_MEMORY_LISTING_CHARS = 64 * 1024;
const MAX_AI_MEMORY_LISTING_LINES = 500;
/** One directory listing, so a few seconds is generous, and every second here
 * is on the critical path before the agent starts, once per repository. */
const AI_MEMORY_LISTING_TIMEOUT_MS = 5_000;

/**
 * Reads the trusted workspace paths in repository order. Missing instruction
 * files are expected; an unreadable or oversized present file fails the
 * invocation instead of silently compiling a partial effective prompt.
 *
 * Hand-maintained notes under .ai/memory are read on the same channel but with
 * the opposite failure rule: absence is the normal case, so anything wrong with
 * them skips content and lets the invocation continue.
 */
export async function loadRepositoryInstructionSources(
  sandboxId: string,
  manifest: WorkspaceManifest,
): Promise<EffectivePromptRepositorySource[]> {
  "use step";
  const trustedManifest = validateRepositoryInstructionManifest(manifest);
  const [{ Sandbox }, { getSandboxCredentials }, { env }] = await Promise.all([
    import("@vercel/sandbox"),
    import("../sandbox/credentials.js"),
    import("../../env.js"),
  ]);
  const sandbox = await Sandbox.get({
    sandboxId,
    ...getSandboxCredentials(),
  });
  const sources: EffectivePromptRepositorySource[] = [];
  let memoryBytes = 0;
  /** Once the budget is spent nothing further is injected, rather than letting
   * whichever later document happens to be small jump the queue. */
  let memoryExhausted = false;
  let droppedMemoryDocuments = 0;
  const droppedMemoryRepositories: string[] = [];
  /** Counting a drop is separate from latching, because only one of the two
   * reasons for dropping is a statement about the budget being spent. */
  const countDroppedMemoryDocument = (repoPath: string): void => {
    droppedMemoryDocuments += 1;
    if (!droppedMemoryRepositories.includes(repoPath)) {
      droppedMemoryRepositories.push(repoPath);
    }
  };

  for (const repository of trustedManifest.repositories) {
    for (const path of INSTRUCTION_PATHS) {
      const absolutePath = `${repository.localPath}/${path}`;
      const stream = await sandbox.readFile({ path: absolutePath });
      if (stream === null) continue;
      const bytes = await readRepositoryInstructionStream(stream);
      if (bytes === null) {
        throw new Error(
          `${repository.repoPath}/${path} exceeds the repository-instruction size limit`,
        );
      }
      sources.push({
        repository: repository.repoPath,
        path,
        content: bytes.toString("utf8"),
      });
    }

    // Kill switch: with repository memory off this step does exactly what it
    // did before .ai/memory existed, no listing and no reads beyond the two
    // instruction files.
    if (!env.ENABLE_REPO_MEMORY) continue;

    const memoryPrefix = `${repository.localPath}/${AI_MEMORY_DIR}/`;
    let stdout: string;
    try {
      // One deadline over the spawn and the log fetch together: both are
      // network calls, and a hang would fail the block through a caller that
      // turns this step's throw into an execution error.
      const listed = await withMemoryListingDeadline(async (signal) => {
        // "-type f" excludes symlink entries, which are type l, so a memory
        // file can never alias a path outside the repository. find also refuses
        // to descend a symlinked start directory unless invoked with -L.
        const listing = await sandbox.runCommand(
          "find",
          [
            `${repository.localPath}/${AI_MEMORY_DIR}`,
            "-maxdepth",
            "1",
            "-type",
            "f",
            "-name",
            "*.md",
          ],
          { signal },
        );
        // A non-zero exit means the directory is absent, which is the common
        // case. It also covers find missing from the image.
        if (listing.exitCode !== 0) return null;
        return listing.stdout({ signal });
      });
      if (listed === null) continue;
      stdout = listed;
    } catch (error) {
      await warnRepositoryMemory("repository_memory_listing_failed", {
        repository: repository.repoPath,
        err: (error as Error)?.message ?? String(error),
      });
      continue;
    }

    // The listing comes from a cloned repository, so bound the parse before the
    // split and the sort, then bound the count before any read.
    const overflowed = stdout.length > MAX_AI_MEMORY_LISTING_CHARS;
    const lines = stdout.slice(0, MAX_AI_MEMORY_LISTING_CHARS).split("\n");
    // A truncated tail is not a whole entry, so never parse it as one.
    if (overflowed) lines.pop();
    if (overflowed || lines.length > MAX_AI_MEMORY_LISTING_LINES) {
      await warnRepositoryMemory("repository_memory_listing_truncated", {
        repository: repository.repoPath,
        chars: stdout.length,
        lines: lines.length,
      });
    }
    // find prints absolute paths. Requiring the exact directory prefix and then
    // re-checking the remainder against a pattern that cannot hold a slash
    // rejects nested paths and traversal.
    const accepted = lines
      .slice(0, MAX_AI_MEMORY_LISTING_LINES)
      .filter((line) => line.startsWith(memoryPrefix))
      .map((line) => line.slice(memoryPrefix.length))
      .filter((name) => AI_MEMORY_NAME_PATTERN.test(name));
    // A newline inside a file name splits one entry across two lines, and the
    // leading half can repeat a real sibling. Deduplicate so no file is read
    // twice or burns two of the slots below.
    const names = Array.from(new Set(accepted)).sort();
    if (names.length > MAX_AI_MEMORY_FILES) {
      await warnRepositoryMemory("repository_memory_files_truncated", {
        repository: repository.repoPath,
        skipped: names.length - MAX_AI_MEMORY_FILES,
      });
    }
    for (const name of names.slice(0, MAX_AI_MEMORY_FILES)) {
      // Latched: counted without being read, because the content could only be
      // discarded, and counted rather than skipped so the warning below can
      // name every repository that lost documents.
      if (memoryExhausted) {
        countDroppedMemoryDocument(repository.repoPath);
        continue;
      }
      try {
        const stream = await sandbox.readFile({ path: `${memoryPrefix}${name}` });
        if (stream === null) continue;
        const bytes = await readRepositoryInstructionStream(
          stream,
          MAX_AI_MEMORY_BYTES,
        );
        if (bytes === null) {
          await warnRepositoryMemory("repository_memory_file_oversized", {
            repository: repository.repoPath,
            name,
          });
          continue;
        }
        const content = bytes.toString("utf8");
        // Measured on the decoded document, which is what the prompt pays for,
        // and measured before it is injected: a byte that is not valid UTF-8
        // decodes to a three byte replacement character, so the read cap above
        // does not bound the injected string on its own.
        const contentBytes = Buffer.byteLength(content, "utf8");
        // A document larger than the whole budget could not fit under any
        // ordering, so skipping it is order independent and must not latch.
        // One 32 KiB file of invalid UTF-8 decodes to 96 KiB of replacement
        // characters, and latching on it would let any repository silence every
        // other repository's memory with one committed file.
        if (contentBytes > MAX_AI_MEMORY_TOTAL_BYTES) {
          countDroppedMemoryDocument(repository.repoPath);
          continue;
        }
        // Whole documents only: half a memory document still reads to the model
        // as a complete one, so one that does not fit is dropped, not cut. This
        // one could have fitted in an empty budget, so it is what spends it.
        if (memoryBytes + contentBytes > MAX_AI_MEMORY_TOTAL_BYTES) {
          memoryExhausted = true;
          countDroppedMemoryDocument(repository.repoPath);
          continue;
        }
        memoryBytes += contentBytes;
        sources.push({
          repository: repository.repoPath,
          path: `${AI_MEMORY_DIR}/${name}`,
          content,
        });
      } catch (error) {
        // Only HTTP 404 maps to a null stream, so every other transport or
        // mid-stream failure arrives here and must not fail the invocation.
        await warnRepositoryMemory("repository_memory_file_unreadable", {
          repository: repository.repoPath,
          name,
          err: (error as Error)?.message ?? String(error),
        });
      }
    }
  }
  if (droppedMemoryDocuments > 0) {
    await warnRepositoryMemory("repository_memory_injection_budget_exceeded", {
      dropped: droppedMemoryDocuments,
      repositories: droppedMemoryRepositories,
      maxBytes: MAX_AI_MEMORY_TOTAL_BYTES,
    });
  }
  return sources;
}
loadRepositoryInstructionSources.maxRetries = 0;

/** @vercel/sandbox 1.8.1 takes an AbortSignal and no timeout, and a signal only
 * bounds the work where the SDK observes it. This step has maxRetries = 0 and a
 * caller that turns a throw into a failed block, so the abort is also raced
 * against the operation: a spawn that never settles must not hang a run. A
 * timeout costs this repository its memory and nothing more, like a non-zero
 * exit, except that the catch below reports it. */
async function withMemoryListingDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AI_MEMORY_LISTING_TIMEOUT_MS,
  );
  try {
    return await Promise.race([
      execute(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new Error(
                `.ai/memory listing exceeded ${AI_MEMORY_LISTING_TIMEOUT_MS}ms`,
              ),
            ),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Every .ai/memory problem is logged and skipped rather than thrown. Reporting
 * a failure must not itself fail: two call sites sit inside catch blocks, where
 * a throw would propagate out of the step and fail the invocation this wrapper
 * exists to keep alive. The pino import stays dynamic because this module is
 * bundled into the workflow. */
async function warnRepositoryMemory(
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const { logger } = await import("../lib/logger.js");
    logger.warn(details, event);
  } catch {
    // Nothing left to report with.
  }
}

export async function readRepositoryInstructionStream(
  stream: NodeJS.ReadableStream,
  maxBytes = MAX_REPOSITORY_INSTRUCTION_BYTES,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

type RepositoryInstructionLoader = (
  sandboxId: string,
  manifest: WorkspaceManifest,
) => Promise<EffectivePromptRepositorySource[]>;

/**
 * Planning executes in an isolated agent sandbox with no checkout. Its prompt
 * still reads trusted instructions from the authoritative shared code
 * workspace. Other agent phases read from their execution workspace.
 */
export async function loadInvocationRepositoryInstructionSources(
  input: {
    nodeType: WorkflowBlockType;
    executionSandboxId: string | null;
    sharedCodeSandboxId: string | null;
    manifest: WorkspaceManifest;
  },
  load: RepositoryInstructionLoader = loadRepositoryInstructionSources,
): Promise<EffectivePromptRepositorySource[]> {
  const sourceSandboxId =
    input.nodeType === "planning_agent"
      ? input.sharedCodeSandboxId
      : input.executionSandboxId;
  if (!sourceSandboxId) return [];
  return load(sourceSandboxId, input.manifest);
}

function validateRepositoryInstructionManifest(
  input: WorkspaceManifest,
): WorkspaceManifest {
  const manifest = workspaceManifestSchema.parse(input);
  const seenPaths = new Set<string>();
  for (const repository of manifest.repositories) {
    if (!isValidWorkspaceLocalPath(repository)) {
      throw new Error(
        `Repository instruction path is invalid for ${repository.repoPath}`,
      );
    }
    if (seenPaths.has(repository.localPath)) {
      throw new Error(
        `Repository instruction path is duplicated for ${repository.repoPath}`,
      );
    }
    seenPaths.add(repository.localPath);
  }
  return manifest;
}

/** Only the two instruction files are reported. An absent .ai/memory directory
 * is normal, so listing it here would pin a permanent false negative into every
 * compiled prompt's unresolved-source list. */
export function unresolvedRepositoryInstructionSources(
  repositories?: readonly string[],
): string[] {
  const labels = repositories && repositories.length > 0
    ? repositories
    : ["prepared workspace"];
  return labels.flatMap((repository) =>
    INSTRUCTION_PATHS.map((path) => `${repository}/${path}`)
  );
}
