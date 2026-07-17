import type { AgentKind } from "../sandbox/agents/index.js";

export const CLARIFICATION_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_STOP_POLLS = 180;

const SCRUB_CREDENTIALS_SCRIPT = `set -eu
find /tmp -maxdepth 1 -type f -name 'agent-env*.sh' -delete
rm -rf "$HOME/.codex" "$HOME/.claude" "$HOME/.config/claude" "$HOME/.config/claude-code"
rm -f "$HOME/.claude.json" /tmp/config.toml /tmp/arthur_config.json /tmp/arthur-tracer.py
find /tmp -maxdepth 1 -type f \( -iname '*arthur*credential*' -o -iname '*tracer*credential*' \) -delete
`;

export interface SnapshotClarificationSandboxInput {
  subjectKey: string;
  ownerToken: string;
  sandboxId: string;
  /** Tests use zero; production leaves this unset. */
  pollIntervalMs?: number;
}

export interface SerializableClarificationSnapshot {
  snapshotId: string;
  sourceSandboxId: string;
  expiresAt: string;
}

/**
 * Scrub and snapshot a workspace as one replay-safe Workflow step. The SDK can
 * return from snapshot() while the source is still `snapshotting`, so the step
 * does not return checkpoint metadata until Sandbox.get reports `stopped`.
 */
export async function snapshotClarificationSandboxStep(
  input: SnapshotClarificationSandboxInput,
): Promise<SerializableClarificationSnapshot> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const credentials = getSandboxCredentials();
  const sandbox = await Sandbox.get({ sandboxId: input.sandboxId, ...credentials });

  const scrub = await sandbox.runCommand("bash", ["-lc", SCRUB_CREDENTIALS_SCRIPT]);
  if (scrub.exitCode !== 0) {
    const stderr = await scrub.stderr();
    const stdout = await scrub.stdout();
    throw new Error(
      `clarification credential scrub failed for ${input.sandboxId}: ${stderr || stdout || "command failed"}`,
    );
  }

  const snapshot = await sandbox.snapshot({ expiration: CLARIFICATION_SNAPSHOT_RETENTION_MS });
  if (snapshot.status !== "created") {
    throw new Error(
      `clarification snapshot ${snapshot.snapshotId} failed with status ${snapshot.status}`,
    );
  }
  const expiresAt = snapshot.expiresAt;
  if (!expiresAt) {
    throw new Error(`clarification snapshot ${snapshot.snapshotId} has no expiration`);
  }

  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  let stopped = false;
  for (let attempt = 0; attempt < MAX_SOURCE_STOP_POLLS; attempt += 1) {
    const source = await Sandbox.get({ sandboxId: input.sandboxId, ...credentials });
    if (source.status === "stopped") {
      stopped = true;
      break;
    }
    if (source.status === "failed" || source.status === "aborted") {
      throw new Error(
        `clarification snapshot source ${input.sandboxId} became ${source.status} before it stopped`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (!stopped) {
    throw new Error(
      `clarification snapshot source ${input.sandboxId} did not stop after snapshot ${snapshot.snapshotId}`,
    );
  }

  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  if (typeof runRegistry.unregisterSandbox === "function") {
    try {
      await runRegistry.unregisterSandbox(
        input.subjectKey,
        input.ownerToken,
        input.sandboxId,
      );
    } catch {
      // The exact-owner handoff also clears predecessor registrations. Do not
      // lose an already-created snapshot over best-effort child bookkeeping.
    }
  }

  return {
    snapshotId: snapshot.snapshotId,
    sourceSandboxId: snapshot.sourceSandboxId,
    expiresAt: expiresAt.toISOString(),
  };
}
snapshotClarificationSandboxStep.maxRetries = 0;

export interface RestoreClarificationSandboxInput {
  snapshotId: string;
  subjectKey: string;
  ownerToken: string;
  timeoutMs: number;
  agents: Array<{ kind: AgentKind; model: string }>;
  arthurTaskId: string | null;
}

/** Restore from a serializable id, register exact ownership, then inject current credentials. */
export async function restoreClarificationSandboxStep(
  input: RestoreClarificationSandboxInput,
): Promise<{ sandboxId: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const { env } = await import("../../env.js");

  let sandbox: Awaited<ReturnType<typeof Sandbox.create>>;
  try {
    sandbox = await Sandbox.create({
      ...getSandboxCredentials(),
      source: { type: "snapshot", snapshotId: input.snapshotId },
      timeout: input.timeoutMs,
    });
  } catch (error) {
    throw unavailableSnapshotError(input.snapshotId, error);
  }

  const { runRegistry } = createStepAdapters();
  try {
    await runRegistry.registerSandbox(input.subjectKey, input.ownerToken, sandbox.sandboxId);
    const arthur =
      env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && input.arthurTaskId
        ? {
            apiKey: env.GENAI_ENGINE_API_KEY,
            taskId: input.arthurTaskId,
            endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
          }
        : undefined;
    for (const selected of input.agents) {
      await createAgentAdapter(selected.kind).configure(sandbox, {
        model: selected.model,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        codexApiKey: env.CODEX_API_KEY,
        codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
        arthur,
      });
    }
    return { sandboxId: sandbox.sandboxId };
  } catch (error) {
    await sandbox.stop({ blocking: true }).catch(() => undefined);
    if (typeof runRegistry.unregisterSandbox === "function") {
      await runRegistry
        .unregisterSandbox(input.subjectKey, input.ownerToken, sandbox.sandboxId)
        .catch(() => false);
    }
    throw error;
  }
}
restoreClarificationSandboxStep.maxRetries = 0;

export async function deleteClarificationSnapshotStep(snapshotId: string): Promise<void> {
  "use step";
  const { Snapshot } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  try {
    const snapshot = await Snapshot.get({ snapshotId, ...getSandboxCredentials() });
    await snapshot.delete();
  } catch (error) {
    throw unavailableSnapshotError(snapshotId, error);
  }
}
deleteClarificationSnapshotStep.maxRetries = 0;

function unavailableSnapshotError(snapshotId: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `clarification snapshot ${snapshotId} is unavailable or expired; restart the ticket to rebuild the workspace (${detail})`,
  );
}
