import type { AgentKind } from "../sandbox/agents/index.js";

export const CLARIFICATION_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_STOP_POLLS = 180;
const MAX_SNAPSHOT_LIST_PAGES = 100;
const SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1_000;

const SCRUB_CREDENTIALS_SCRIPT = `set -eu
find /tmp -maxdepth 1 -type f -name 'agent-env*.sh' -delete
rm -rf "$HOME/.codex" "$HOME/.claude" "$HOME/.config/claude" "$HOME/.config/claude-code"
rm -f "$HOME/.claude.json" /tmp/config.toml /tmp/arthur_config.json /tmp/arthur-tracer.py
find /tmp -maxdepth 1 -type f \( -iname '*arthur*credential*' -o -iname '*tracer*credential*' \) -delete
`;

export interface SnapshotClarificationSandboxInput {
  subjectKey: string;
  ownerToken: string;
  clarificationId: string;
  sandboxId: string;
  /** Persisted before snapshot creation; recovery must ignore older snapshots. */
  snapshotRequestedAt: string;
  /** Remaining active-duration budget at the snapshot boundary. */
  timeoutMs: number;
  /** Tests use zero; production leaves this unset. */
  pollIntervalMs?: number;
}

export interface SerializableClarificationSnapshot {
  snapshotId: string;
  sourceSandboxId: string;
  expiresAt: string;
}

async function withinSnapshotDeadline<T>(
  deadline: number,
  operation: string,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`clarification ${operation} exceeded the active-duration budget`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const result = await execute(controller.signal);
    if (Date.now() > deadline) {
      throw new Error(`clarification ${operation} exceeded the active-duration budget`);
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `clarification ${operation} exceeded the active-duration budget`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  const { Sandbox, Snapshot } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const credentials = getSandboxCredentials();
  if (input.timeoutMs <= 0) {
    throw new Error("clarification snapshot has no active-duration budget remaining");
  }
  const requestedAt = new Date(input.snapshotRequestedAt);
  if (!Number.isFinite(requestedAt.getTime())) {
    throw new Error("clarification snapshot attempt boundary is invalid");
  }
  // Snapshot identity is the exact source sandbox (a successful snapshot stops
  // it, so that source cannot produce an earlier successful snapshot). Apply a
  // small cross-system clock margin to the persisted worker timestamp so an API
  // clock just behind the worker cannot hide the snapshot created by a retry.
  const recoverySince = new Date(
    requestedAt.getTime() - SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS,
  );
  const deadline = Date.now() + input.timeoutMs;
  let recovered:
    | Awaited<ReturnType<typeof Snapshot.list>>["json"]["snapshots"][number]
    | undefined;
  let until: number | undefined;
  const seenCursors = new Set<number>();
  for (let page = 0; page < MAX_SNAPSHOT_LIST_PAGES; page += 1) {
    const listed = await withinSnapshotDeadline(
      deadline,
      "snapshot listing",
      (signal) => Snapshot.list({
        ...credentials,
        limit: 100,
        since: recoverySince,
        ...(until === undefined ? {} : { until }),
        signal,
      }),
    );
    recovered = listed.json.snapshots
      .filter(
        (candidate) =>
          candidate.sourceSandboxId === input.sandboxId &&
          candidate.createdAt >= recoverySince.getTime() &&
          candidate.status === "created" &&
          candidate.expiresAt !== undefined &&
          candidate.expiresAt > Date.now(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (recovered) break;

    const next = listed.json.pagination.next;
    if (next === null || next <= recoverySince.getTime()) break;
    if (seenCursors.has(next)) {
      throw new Error("clarification snapshot listing repeated pagination cursor");
    }
    seenCursors.add(next);
    until = next;
    if (page === MAX_SNAPSHOT_LIST_PAGES - 1) {
      throw new Error(
        `clarification snapshot listing exceeded ${MAX_SNAPSHOT_LIST_PAGES} pages`,
      );
    }
  }

  let snapshotMetadata: SerializableClarificationSnapshot;
  if (recovered) {
    snapshotMetadata = {
      snapshotId: recovered.id,
      sourceSandboxId: recovered.sourceSandboxId,
      expiresAt: new Date(recovered.expiresAt!).toISOString(),
    };
  } else {
    const sandbox = await withinSnapshotDeadline(
      deadline,
      "source sandbox lookup",
      (signal) => Sandbox.get({ sandboxId: input.sandboxId, ...credentials, signal }),
    );
    const scrub = await withinSnapshotDeadline(
      deadline,
      "credential scrub",
      (signal) => sandbox.runCommand(
        "bash",
        ["-lc", SCRUB_CREDENTIALS_SCRIPT],
        { signal },
      ),
    );
    if (scrub.exitCode !== 0) {
      const stderr = await scrub.stderr();
      const stdout = await scrub.stdout();
      throw new Error(
        `clarification credential scrub failed for ${input.sandboxId}: ${stderr || stdout || "command failed"}`,
      );
    }

    const snapshot = await withinSnapshotDeadline(
      deadline,
      "snapshot creation",
      (signal) => sandbox.snapshot({
        expiration: CLARIFICATION_SNAPSHOT_RETENTION_MS,
        signal,
      }),
    );
    if (snapshot.status !== "created") {
      throw new Error(
        `clarification snapshot ${snapshot.snapshotId} failed with status ${snapshot.status}`,
      );
    }
    const expiresAt = snapshot.expiresAt;
    if (!expiresAt) {
      throw new Error(`clarification snapshot ${snapshot.snapshotId} has no expiration`);
    }
    snapshotMetadata = {
      snapshotId: snapshot.snapshotId,
      sourceSandboxId: snapshot.sourceSandboxId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // The provider object exists now. Persist its cleanup identity before source
  // polling so failures after this provider boundary retain a cleanup identity.
  const { getDb } = await import("../db/client.js");
  const {
    completeClarificationCheckpoint,
    recordClarificationSnapshotMetadata,
  } = await import("../clarifications/store.js");
  const durableSnapshot = {
    snapshotId: snapshotMetadata.snapshotId,
    sourceSandboxId: snapshotMetadata.sourceSandboxId,
    expiresAt: new Date(snapshotMetadata.expiresAt),
  };
  await recordClarificationSnapshotMetadata(
    getDb(),
    input.clarificationId,
    durableSnapshot,
  );

  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  let stopped = false;
  for (
    let attempt = 0;
    attempt < MAX_SOURCE_STOP_POLLS && Date.now() <= deadline;
    attempt += 1
  ) {
    const source = await withinSnapshotDeadline(
      deadline,
      "source sandbox stop polling",
      (signal) => Sandbox.get({ sandboxId: input.sandboxId, ...credentials, signal }),
    );
    if (source.status === "stopped") {
      stopped = true;
      break;
    }
    if (source.status === "failed" || source.status === "aborted") {
      throw new Error(
        `clarification snapshot source ${input.sandboxId} became ${source.status} before it stopped`,
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)),
    );
  }
  if (!stopped) {
    throw new Error(
      `clarification snapshot source ${input.sandboxId} did not stop within the active-duration budget after snapshot ${snapshotMetadata.snapshotId}`,
    );
  }

  await completeClarificationCheckpoint(getDb(), input.clarificationId, durableSnapshot);

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

  return snapshotMetadata;
}

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
    const { stopSandboxAndConfirm } = await import(
      "../sandbox/stop-ticket-sandboxes.js"
    );
    await stopSandboxAndConfirm(sandbox);
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
    if (isSnapshotMissing(error)) return;
    throw unavailableSnapshotError(snapshotId, error);
  }
}
deleteClarificationSnapshotStep.maxRetries = 0;

function isSnapshotMissing(error: unknown): boolean {
  const candidate = error as { status?: number; statusCode?: number; message?: string };
  return (
    candidate?.status === 404 ||
    candidate?.statusCode === 404 ||
    /(?:404|not found|does not exist|expired)/i.test(candidate?.message ?? "")
  );
}

function unavailableSnapshotError(snapshotId: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `clarification snapshot ${snapshotId} is unavailable or expired; restart the ticket to rebuild the workspace (${detail})`,
  );
}
