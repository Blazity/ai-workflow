import type { AgentKind } from "./agents/index.js";
import type { AgentProtocolResult } from "./agents/types.js";
import type {
  ResolvedHarnessRuntime,
  ResolvedRuntimeCredentials,
} from "./harness-runtime.js";
import {
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_ROOT_DIR,
  isValidWorkspaceLocalPath,
  type WorkspaceManifest,
  workspaceManifestSchema,
} from "./repo-workspace.js";
import { fingerprintWorkspaceState } from "../workflows/workspace-gate-fingerprint.js";

const PRIMARY_REPOSITORY_EXCLUDES_PATH = "/tmp/aiw-review-primary-git-excludes";
const PRIMARY_REPOSITORY_EXCLUDES =
  "/aiw-repos.json\n/repos/\n/ai-workflow/memory/\n/blazebot/memory/\n/.codex\n/.claude\n";
const DIRTY_STATUS_ENTRY_LIMIT = 5;
const DIRTY_STATUS_CHARACTER_LIMIT = 500;

function summarizeDirtyStatus(statusText: string): string {
  return statusText
    .split(/\r?\n/u)
    .slice(0, DIRTY_STATUS_ENTRY_LIMIT)
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/gu, " ").trim())
    .filter(Boolean)
    .join("; ")
    .slice(0, DIRTY_STATUS_CHARACTER_LIMIT);
}

export interface DisposableReviewRepository {
  repoPath: string;
  localPath: string;
  headSha: string;
}

export type DisposableReviewWorkspaceProvisionResult =
  | {
      ok: true;
      sandboxId: string;
      sourceFingerprint: string;
      repositories: DisposableReviewRepository[];
    }
  | {
      ok: false;
      failure: Extract<AgentProtocolResult<unknown>, { ok: false }>;
    };

export interface ProvisionDisposableReviewWorkspaceInput {
  sourceSandboxId: string;
  workspaceManifest: WorkspaceManifest;
  subjectKey: string;
  ownerToken: string;
  agentKind: AgentKind;
  model: string;
  arthurTaskId: string | null;
  runtime?: ResolvedHarnessRuntime;
  /**
   * Ticket identifier whose session memory document the reviewer should see. The
   * document is no longer part of the repository, so the bundles this workspace
   * is assembled from cannot carry it; the step copies it from the source
   * workspace instead.
   */
  memoryTaskId?: string | null;
}

interface ExportedRepository extends DisposableReviewRepository {
  bundlePath: string;
  bundle: Buffer;
}

/**
 * Create one exact, disposable review copy of the shared code workspace.
 *
 * Source repositories are only read. The copy is assembled from local Git
 * bundles, so it never receives provider remotes or VCS credentials. Repository
 * trees are sealed after the review provider is configured.
 */
export async function provisionDisposableReviewWorkspaceStep(
  input: ProvisionDisposableReviewWorkspaceInput,
): Promise<DisposableReviewWorkspaceProvisionResult> {
  "use step";
  const { randomUUID } = await import("node:crypto");
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const { createAgentAdapter } = await import("./agents/index.js");
  const { isAgentRuntimeError } = await import("./agents/protocol.js");
  const { getSandboxCredentials } = await import("./credentials.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { stopSandboxAndConfirm } = await import("./stop-ticket-sandboxes.js");
  const { isRunControlError } = await import("../workflows/run-control-error.js");

  const manifest = validateTrustedManifest(input.workspaceManifest);
  const source = await Sandbox.get({
    sandboxId: input.sourceSandboxId,
    ...getSandboxCredentials(),
  });
  const sourceManifest = await source.readFileToBuffer({
    path: WORKSPACE_MANIFEST_PATH,
  });
  if (!sourceManifest) {
    throw new Error("review source workspace manifest is unavailable");
  }
  const { parseVerifiedWorkspaceManifest } = await import("./repo-workspace.js");
  parseVerifiedWorkspaceManifest(sourceManifest.toString("utf8"), manifest);

  const exported: ExportedRepository[] = [];
  for (const [index, repo] of manifest.repositories.entries()) {
    const status = await source.runCommand("git", [
      "--no-optional-locks",
      "-C",
      repo.localPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const statusText = status.exitCode === 0 ? (await status.stdout()).trim() : "";
    if (status.exitCode !== 0) {
      throw new Error(
        `review source ${repo.provider}:${repo.repoPath} could not be inspected: ${await commandError(status)}`,
      );
    }
    if (statusText) {
      const statusSummary = summarizeDirtyStatus(statusText);
      throw new Error(
        `review source ${repo.provider}:${repo.repoPath} has uncommitted changes: ${statusSummary}`,
      );
    }

    const head = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "rev-parse",
      "HEAD",
    ]);
    if (head.exitCode !== 0) {
      throw new Error(
        `review source ${repo.provider}:${repo.repoPath} head is unavailable: ${await commandError(head)}`,
      );
    }
    const headSha = (await head.stdout()).trim();
    if (!headSha) {
      throw new Error(`review source ${repo.provider}:${repo.repoPath} has an empty head`);
    }

    const sourceBundlePath = `/tmp/aiw-review-source-${randomUUID()}.bundle`;
    try {
      const bundle = await source.runCommand("git", [
        "-C",
        repo.localPath,
        "bundle",
        "create",
        sourceBundlePath,
        "HEAD",
      ]);
      if (bundle.exitCode !== 0) {
        throw new Error(
          `review source ${repo.provider}:${repo.repoPath} could not be exported: ${await commandError(bundle)}`,
        );
      }
      const bytes = await source.readFileToBuffer({ path: sourceBundlePath });
      if (!bytes) {
        throw new Error(
          `review source ${repo.provider}:${repo.repoPath} bundle is unavailable`,
        );
      }
      exported.push({
        repoPath: repo.repoPath,
        localPath: repo.localPath,
        headSha,
        bundlePath: `/tmp/aiw-review-${index}-${randomUUID()}.bundle`,
        bundle: bytes,
      });
    } finally {
      await source.runCommand("rm", ["-f", sourceBundlePath]).catch(() => undefined);
    }
  }

  // The live source workspace, not the store: mid-run it holds everything the
  // implementation agent has written so far, while the store is only refreshed
  // when the run tears down. Best effort, a missing document never blocks a
  // review. A task id may never walk out of the memory directory.
  const validMemoryTaskId =
    input.memoryTaskId && !input.memoryTaskId.split("/").includes("..")
      ? input.memoryTaskId
      : null;
  const memoryDocPath = validMemoryTaskId
    ? `ai-workflow/memory/${validMemoryTaskId}.md`
    : null;
  // Read the new path first, then the legacy path an older run may have written
  // under, so a mid-run review still sees the document either way.
  const legacyMemoryDocPath = validMemoryTaskId
    ? `blazebot/memory/${validMemoryTaskId}.md`
    : null;
  const memoryDocument = memoryDocPath
    ? (await readCappedMemoryDocument(
        source,
        `${WORKSPACE_ROOT_DIR}/${memoryDocPath}`,
      ).catch(() => null)) ??
      (legacyMemoryDocPath
        ? await readCappedMemoryDocument(
            source,
            `${WORKSPACE_ROOT_DIR}/${legacyMemoryDocPath}`,
          ).catch(() => null)
        : null)
    : null;

  const sandbox = await Sandbox.create({
    ...getSandboxCredentials(),
    runtime: "node24",
    timeout: env.JOB_TIMEOUT_MS,
  });
  const { runRegistry } = createAdapters();

  try {
    // Register before the first setup command so cancellation/reconciliation can
    // clean up a sandbox even if ownership changes during provisioning.
    await runRegistry.registerSandbox(
      input.subjectKey,
      input.ownerToken,
      sandbox.sandboxId,
    );

    await sandbox.writeFiles(
      exported.map((repo) => ({
        path: repo.bundlePath,
        content: repo.bundle,
      })),
    );

    for (const repo of exported) {
      await requireCommand(
        await sandbox.runCommand("mkdir", ["-p", repo.localPath]),
        `review checkout directory could not be created for ${repo.repoPath}`,
      );
      await requireCommand(
        await sandbox.runCommand("git", ["init", "--quiet", repo.localPath]),
        `review checkout could not be initialized for ${repo.repoPath}`,
      );
      await requireCommand(
        await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "fetch",
          "--quiet",
          repo.bundlePath,
          "HEAD",
        ]),
        `review bundle could not be imported for ${repo.repoPath}`,
      );
      const importedHead = await requireCommand(
        await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "rev-parse",
          "FETCH_HEAD",
        ]),
        `review bundle head could not be read for ${repo.repoPath}`,
      );
      const importedSha = (await importedHead.stdout()).trim();
      if (importedSha !== repo.headSha) {
        throw new Error(
          `review bundle head mismatch for ${repo.repoPath}: expected ${repo.headSha}, got ${importedSha || "unreadable"}`,
        );
      }
      await requireCommand(
        await sandbox.runCommand("git", [
          "-C",
          repo.localPath,
          "checkout",
          "--quiet",
          "--detach",
          "FETCH_HEAD",
        ]),
        `review checkout could not be materialized for ${repo.repoPath}`,
      );
      const remotes = await requireCommand(
        await sandbox.runCommand("git", ["-C", repo.localPath, "remote"]),
        `review checkout remotes could not be inspected for ${repo.repoPath}`,
      );
      if ((await remotes.stdout()).trim()) {
        throw new Error(`review checkout unexpectedly has a remote for ${repo.repoPath}`);
      }
      await sandbox.runCommand("rm", ["-f", repo.bundlePath]);
    }

    await sandbox.writeFiles([
      {
        path: WORKSPACE_MANIFEST_PATH,
        content: Buffer.from(JSON.stringify(manifest, null, 2)),
      },
      {
        path: PRIMARY_REPOSITORY_EXCLUDES_PATH,
        content: Buffer.from(PRIMARY_REPOSITORY_EXCLUDES),
      },
    ]);
    await requireCommand(
      await sandbox.runCommand("git", [
        "-C",
        WORKSPACE_ROOT_DIR,
        "config",
        "--local",
        "core.excludesFile",
        PRIMARY_REPOSITORY_EXCLUDES_PATH,
      ]),
      "review primary repository excludes could not be configured",
    );

    // After the excludes are in place, so the restored document stays invisible
    // to the cleanliness checks, and before the trees are sealed read-only. A
    // path the checkout already carries is a repository-tracked legacy copy:
    // leave it alone, overwriting it would be a tracked modification. Memory is
    // an optimization, so a failed restore costs the reviewer context and never
    // the review itself.
    if (memoryDocPath && memoryDocument) {
      try {
        const absolutePath = `${WORKSPACE_ROOT_DIR}/${memoryDocPath}`;
        const present = await sandbox.runCommand("test", ["-e", absolutePath]);
        if (present.exitCode !== 0) {
          await requireCommand(
            await sandbox.runCommand("mkdir", [
              "-p",
              absolutePath.slice(0, absolutePath.lastIndexOf("/")),
            ]),
            "review memory directory could not be created",
          );
          await sandbox.writeFiles([{ path: absolutePath, content: memoryDocument }]);
        }
      } catch (error) {
        const { logger } = await import("../lib/logger.js");
        logger.warn(
          {
            sandboxId: sandbox.sandboxId,
            docPath: memoryDocPath,
            err: error instanceof Error ? error.message : String(error),
          },
          "review_memory_restore_failed",
        );
      }
    }

    const arthur =
      env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && input.arthurTaskId
        ? {
            apiKey: env.GENAI_ENGINE_API_KEY,
            taskId: input.arthurTaskId,
            endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
          }
        : undefined;
    const adapter = createAgentAdapter(
      input.agentKind,
      input.runtime?.cliSpec,
    );
    if (!input.runtime) {
      const runtimeCredentials: ResolvedRuntimeCredentials = {
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        codexApiKey: env.CODEX_API_KEY,
        codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
      };
      await adapter.install(sandbox);
      await adapter.configure(sandbox, {
        ...runtimeCredentials,
        model: input.model,
        arthur,
      });
      // A review must never be prompted to commit. The filesystem policy below
      // is the enforcement boundary, while the detached bundle checkouts have
      // no remote or provider credential with which to publish.
      await adapter.setCommitGuard(sandbox, false, undefined);
    }

    await requireCommand(
      await sandbox.runCommand("bash", [
        "-c",
        [
          'rm -rf "$HOME/.config/gh" "$HOME/.config/glab"',
          "git config --global --unset-all credential.helper >/dev/null 2>&1 || true",
          "git config --global credential.helper ''",
        ].join("\n"),
      ]),
      "review VCS credentials could not be scrubbed",
    );

    // Agent CLIs may keep per-cwd scratch state. For untracked conventional
    // paths, point that state outside the repository before sealing it. Never
    // reopen a repository directory: a project may legitimately track
    // `.codex` or `.claude`.
    await requireCommand(
      await sandbox.runCommand("mkdir", [
        "-p",
        "/tmp/aiw-review-codex-cwd",
        "/tmp/aiw-review-claude-cwd",
      ]),
      "review agent scratch directories could not be created",
    );
    for (const scratch of [
      { name: ".codex", target: "/tmp/aiw-review-codex-cwd" },
      { name: ".claude", target: "/tmp/aiw-review-claude-cwd" },
    ]) {
      const tracked = await requireCommand(
        await sandbox.runCommand("git", [
          "-C",
          WORKSPACE_ROOT_DIR,
          "ls-files",
          "--",
          scratch.name,
        ]),
        `review ${scratch.name} ownership could not be inspected`,
      );
      if ((await tracked.stdout()).trim()) continue;
      await sandbox.runCommand("rm", [
        "-rf",
        `${WORKSPACE_ROOT_DIR}/${scratch.name}`,
      ]);
      await requireCommand(
        await sandbox.runCommand("ln", [
          "-s",
          scratch.target,
          `${WORKSPACE_ROOT_DIR}/${scratch.name}`,
        ]),
        `review ${scratch.name} scratch link could not be created`,
      );
    }
    for (const repo of exported) {
      const status = await requireCommand(
        await sandbox.runCommand("git", [
          "--no-optional-locks",
          "-C",
          repo.localPath,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        `review checkout cleanliness could not be inspected for ${repo.repoPath}`,
      );
      if ((await status.stdout()).trim()) {
        throw new Error(
          `review checkout is not clean after setup for ${repo.repoPath}`,
        );
      }
    }
    for (const repo of [...exported].reverse()) {
      await requireCommand(
        await sandbox.runCommand("chmod", ["-R", "a-w", repo.localPath]),
        `review checkout could not be sealed for ${repo.repoPath}`,
      );
    }

    return {
      ok: true,
      sandboxId: sandbox.sandboxId,
      sourceFingerprint: fingerprintWorkspaceState(
        manifest,
        exported.map((repo) => repo.headSha),
      ),
      repositories: exported.map(({ repoPath, localPath, headSha }) => ({
        repoPath,
        localPath,
        headSha,
      })),
    };
  } catch (error) {
    const agentRuntimeError = isAgentRuntimeError(error);
    try {
      await stopSandboxAndConfirm(sandbox);
    } catch (cleanupError) {
      if (!isRunControlError(error) && !agentRuntimeError) throw cleanupError;
    }
    if (typeof runRegistry.unregisterSandbox === "function") {
      await runRegistry
        .unregisterSandbox(input.subjectKey, input.ownerToken, sandbox.sandboxId)
        .catch(() => false);
    }
    if (agentRuntimeError) {
      return {
        ok: false,
        failure: {
          ok: false,
          category: error.category,
          message: error.safeMessage,
          diagnostic: error.diagnostic,
        },
      };
    }
    throw error;
  }
}

provisionDisposableReviewWorkspaceStep.maxRetries = 0;

export type DisposableReviewWorkspaceVerification =
  | { ok: true }
  | { ok: false; error: string };

/** Re-check the immutable inputs after the review provider exits. */
export async function verifyDisposableReviewWorkspaceStep(
  sandboxId: string,
  workspaceManifest: WorkspaceManifest,
  expectedRepositories: DisposableReviewRepository[],
): Promise<DisposableReviewWorkspaceVerification> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("./credentials.js");
  const { parseVerifiedWorkspaceManifest } = await import("./repo-workspace.js");

  try {
    const manifest = validateTrustedManifest(workspaceManifest);
    if (expectedRepositories.length !== manifest.repositories.length) {
      return { ok: false, error: "review workspace repository count changed" };
    }
    const sandbox = await Sandbox.get({
      sandboxId,
      ...getSandboxCredentials(),
    });
    const rawManifest = await sandbox.readFileToBuffer({
      path: WORKSPACE_MANIFEST_PATH,
    });
    if (!rawManifest) {
      return { ok: false, error: "review workspace manifest is unavailable" };
    }
    parseVerifiedWorkspaceManifest(rawManifest.toString("utf8"), manifest);

    for (const [index, repo] of manifest.repositories.entries()) {
      const expected = expectedRepositories[index];
      if (
        !expected ||
        expected.repoPath !== repo.repoPath ||
        expected.localPath !== repo.localPath
      ) {
        return { ok: false, error: "review workspace repository identity changed" };
      }
      const head = await sandbox.runCommand("git", [
        "-C",
        repo.localPath,
        "rev-parse",
        "HEAD",
      ]);
      const headSha = head.exitCode === 0 ? (await head.stdout()).trim() : "";
      if (headSha !== expected.headSha) {
        return { ok: false, error: `review workspace head changed for ${repo.repoPath}` };
      }
      const status = await sandbox.runCommand("git", [
        "-C",
        repo.localPath,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const statusText = status.exitCode === 0 ? (await status.stdout()).trim() : "";
      if (status.exitCode !== 0 || statusText) {
        return {
          ok: false,
          error: `review workspace content changed for ${repo.repoPath}`,
        };
      }
      const remotes = await sandbox.runCommand("git", ["-C", repo.localPath, "remote"]);
      if (remotes.exitCode !== 0 || (await remotes.stdout()).trim()) {
        return {
          ok: false,
          error: `review workspace gained a remote for ${repo.repoPath}`,
        };
      }
      const readOnly = await sandbox.runCommand("test", [
        "!",
        "-w",
        repo.localPath,
      ]);
      if (readOnly.exitCode !== 0) {
        return {
          ok: false,
          error: `review workspace is writable for ${repo.repoPath}`,
        };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "review workspace integrity could not be verified" };
  }
}
verifyDisposableReviewWorkspaceStep.maxRetries = 0;

/**
 * Streams the document with the store's own size cap, so an agent-written file of
 * any size can never be pulled into worker memory whole. An oversized document is
 * truncated for the reviewer, possibly mid-character on the last byte.
 */
async function readCappedMemoryDocument(
  sandbox: {
    readFile(input: { path: string }): Promise<NodeJS.ReadableStream | null>;
  },
  path: string,
): Promise<Buffer | null> {
  const { MAX_MEMORY_DOCUMENT_BYTES } = await import("../memory/store.js");
  const stream = await sandbox.readFile({ path });
  if (stream === null) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size >= MAX_MEMORY_DOCUMENT_BYTES) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      break;
    }
  }
  return Buffer.concat(chunks, size).subarray(0, MAX_MEMORY_DOCUMENT_BYTES);
}

function validateTrustedManifest(input: WorkspaceManifest): WorkspaceManifest {
  const manifest = workspaceManifestSchema.parse(input);
  if (manifest.repositories.length === 0) {
    throw new Error("review workspace has no repositories");
  }
  const paths = new Set<string>();
  for (const repo of manifest.repositories) {
    if (!isValidWorkspaceLocalPath(repo)) {
      throw new Error(`review workspace path is invalid for ${repo.repoPath}`);
    }
    if (paths.has(repo.localPath)) {
      throw new Error(`review workspace path is duplicated for ${repo.repoPath}`);
    }
    paths.add(repo.localPath);
  }
  return manifest;
}

type SandboxCommandResult = {
  exitCode: number;
  stdout(): Promise<string>;
  stderr?(): Promise<string>;
};

async function requireCommand(
  result: SandboxCommandResult,
  context: string,
): Promise<SandboxCommandResult> {
  if (result.exitCode !== 0) {
    throw new Error(`${context}: ${await commandError(result)}`);
  }
  return result;
}

async function commandError(result: SandboxCommandResult): Promise<string> {
  const stdout = (await result.stdout()).trim();
  const stderr = ((await result.stderr?.()) ?? "").trim();
  return stderr || stdout || "command failed";
}
