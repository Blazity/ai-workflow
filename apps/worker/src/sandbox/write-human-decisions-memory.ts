import { getSandboxCredentials } from "./credentials.js";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_ROOT_DIR,
} from "./repo-workspace.js";
import {
  renderHumanDecisionsSection,
  upsertHumanDecisionsSection,
  type HumanDecision,
} from "../lib/human-decisions-memory.js";

/**
 * Deterministically upserts the "Human decisions" section into the memory
 * document at the agent's cwd (`blazebot/memory/<ticketKey>.md`), filled verbatim
 * from the dashboard Q&A. That document is not part of any repository: the
 * platform keeps it outside the checkout and persists its content to the store at
 * the end of the run, so nothing here touches git history or the tracked tree.
 *
 * Errors are logged and swallowed; a failed write costs the reviewer this section
 * but never blocks publication.
 */
export async function writeHumanDecisionsMemory(
  sandboxId: string,
  ticketKey: string,
  clarifications: HumanDecision[],
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ sandboxId, ticketKey, step: "writeHumanDecisionsMemory" });

  if (clarifications.length === 0) return;

  const section = renderHumanDecisionsSection(clarifications);
  const docPath = `blazebot/memory/${ticketKey}.md`;
  const memoryPath = `${WORKSPACE_ROOT_DIR}/${docPath}`;

  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
    if (manifestResult.exitCode !== 0) {
      log.warn({}, "human_decisions_memory_manifest_missing");
      return;
    }
    const manifest = parseWorkspaceManifest(await manifestResult.stdout());

    // Same rule as the memory hydration step: only a repository checked out at
    // the agent's cwd can track this path, and a tracked file must never be
    // rewritten here. Git excludes cannot hide a file that is already in the
    // index, so the write would leave a tracked modification behind and the
    // cleanliness checks in write promotion and publication would reject it.
    // Old tickets with a committed document therefore keep it as-is; their human
    // decisions still reach the agent through the prompt.
    const rootRepository = manifest.repositories.find(
      (repository) => repository.localPath === WORKSPACE_ROOT_DIR,
    );
    if (rootRepository) {
      const tracked = await sandbox.runCommand("git", [
        "-C",
        WORKSPACE_ROOT_DIR,
        "ls-files",
        "--",
        docPath,
      ]);
      // Fail closed: an unanswered probe cannot rule out a tracked file.
      if (tracked.exitCode !== 0) {
        log.warn(
          { repo: rootRepository.repoPath, exitCode: tracked.exitCode },
          "human_decisions_memory_tracked_probe_failed",
        );
        return;
      }
      if ((await tracked.stdout()).trim().length > 0) {
        log.info(
          { repo: rootRepository.repoPath },
          "human_decisions_memory_skipped_tracked",
        );
        return;
      }
    }

    const readResult = await sandbox.runCommand("cat", [memoryPath]);
    const existing = readResult.exitCode === 0 ? await readResult.stdout() : null;
    const next = upsertHumanDecisionsSection(existing, section, ticketKey);

    // writeFiles does not guarantee mkdir -p semantics, and PR subject keys
    // contain slashes, so the directory to create comes from the resolved path.
    await sandbox.runCommand("mkdir", [
      "-p",
      memoryPath.slice(0, memoryPath.lastIndexOf("/")),
    ]);
    await sandbox.writeFiles([{ path: memoryPath, content: Buffer.from(next) }]);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "human_decisions_memory_write_failed",
    );
  }
}
writeHumanDecisionsMemory.maxRetries = 0;
