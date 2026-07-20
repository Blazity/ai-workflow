import { getSandboxCredentials } from "./credentials.js";
import { parseWorkspaceManifest, WORKSPACE_MANIFEST_PATH } from "./repo-workspace.js";
import {
  renderHumanDecisionsSection,
  upsertHumanDecisionsSection,
  type HumanDecision,
} from "../lib/human-decisions-memory.js";

/**
 * Deterministically upserts the "Human decisions" section into every
 * repository's blazebot/memory/<ticketKey>.md inside the sandbox, filled
 * verbatim from the dashboard Q&A. Called BEFORE the workspace push so the
 * section always lands in the PR, regardless of what the model wrote.
 *
 * Each changed memory file is committed explicitly so Finalize's clean-tree
 * invariant remains true. Errors are logged per repository; a partial write or
 * failed commit remains visible to Finalize's preflight and blocks publication.
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

  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
    if (manifestResult.exitCode !== 0) {
      log.warn({}, "human_decisions_memory_manifest_missing");
      return;
    }
    const manifest = parseWorkspaceManifest(await manifestResult.stdout());

    for (const repo of manifest.repositories) {
      // Per-repository isolation: one repo's read/mkdir/write failure must not
      // stop the section from landing in the remaining repositories.
      try {
        const memoryDir = `${repo.localPath}/blazebot/memory`;
        const memoryPath = `${memoryDir}/${ticketKey}.md`;

        const readResult = await sandbox.runCommand("cat", [memoryPath]);
        const existing = readResult.exitCode === 0 ? await readResult.stdout() : null;
        const next = upsertHumanDecisionsSection(existing, section, ticketKey);

        // writeFiles does not guarantee mkdir -p semantics.
        await sandbox.runCommand("mkdir", ["-p", memoryDir]);
        await sandbox.writeFiles([{ path: memoryPath, content: Buffer.from(next) }]);

        const relativeMemoryPath = `blazebot/memory/${ticketKey}.md`;
        const status = await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "status",
          "--porcelain=v1",
          "--",
          relativeMemoryPath,
        ]);
        if (status.exitCode !== 0) {
          throw new Error("human decisions memory status check failed");
        }
        if ((await status.stdout()).trim().length === 0) continue;

        const add = await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "add",
          "--",
          relativeMemoryPath,
        ]);
        if (add.exitCode !== 0) throw new Error("human decisions memory staging failed");

        const commit = await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "commit",
          "-m",
          `Record human decisions for ${ticketKey}`,
          "--",
          relativeMemoryPath,
        ]);
        if (commit.exitCode !== 0) throw new Error("human decisions memory commit failed");
      } catch (err) {
        log.warn(
          { repo: repo.localPath, err: err instanceof Error ? err.message : String(err) },
          "human_decisions_memory_repo_write_failed",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "human_decisions_memory_write_failed",
    );
  }
}
writeHumanDecisionsMemory.maxRetries = 0;
