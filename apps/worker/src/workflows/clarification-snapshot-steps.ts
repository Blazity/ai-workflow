import type { AgentKind } from "../sandbox/agents/index.js";
import type { ResolvedHarnessRuntime } from "../sandbox/harness-runtime.js";

export const CLARIFICATION_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_STOP_POLLS = 180;
const MAX_SNAPSHOT_LIST_PAGES = 100;
const SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1_000;
const CREDENTIAL_REMAINS_EXIT_CODE = 86;
const CREDENTIAL_PATTERN_FILE_PREFIX =
  "/tmp/.aiw-clarification-credential-patterns-";

const EXACT_CREDENTIAL_SCAN_SOURCE = String.raw`
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";

const CREDENTIAL_REMAINS_EXIT_CODE = 86;
const CREDENTIAL_SCAN_FAILED_EXIT_CODE = 87;
const CREDENTIAL_FOUND = Symbol("credential-found");
const [, , patternFile, ...requestedRoots] = process.argv;

function assertNoCredential(value, credentials) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  for (const credential of credentials) {
    if (bytes.indexOf(credential) !== -1) throw CREDENTIAL_FOUND;
  }
}

async function scanFile(path, credentials, overlapBytes) {
  let overlap = Buffer.alloc(0);
  try {
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const searchable =
        overlap.length === 0 ? chunk : Buffer.concat([overlap, chunk]);
      assertNoCredential(searchable, credentials);
      overlap =
        overlapBytes === 0
          ? Buffer.alloc(0)
          : searchable.subarray(Math.max(0, searchable.length - overlapBytes));
    }
  } catch (error) {
    if (error === CREDENTIAL_FOUND) throw error;
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

async function scanPath(path, excludedPath, credentials, overlapBytes, visited) {
  const absolute = resolve(path);
  if (absolute === excludedPath || visited.has(absolute)) return;
  visited.add(absolute);
  assertNoCredential(absolute, credentials);

  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    assertNoCredential(await readlink(absolute), credentials);
    return;
  }
  if (stat.isFile()) {
    await scanFile(absolute, credentials, overlapBytes);
    return;
  }
  if (!stat.isDirectory()) return;

  let directory;
  try {
    directory = await opendir(absolute);
    for await (const entry of directory) {
      await scanPath(
        resolve(absolute, entry.name),
        excludedPath,
        credentials,
        overlapBytes,
        visited,
      );
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

try {
  const encoded = JSON.parse(await readFile(patternFile, "utf8"));
  if (!Array.isArray(encoded) || encoded.some((value) => typeof value !== "string")) {
    throw new Error("invalid credential pattern file");
  }
  const credentials = encoded
    .map((value) => Buffer.from(value, "base64"))
    .filter((value) => value.length > 0);
  const overlapBytes = Math.max(
    0,
    ...credentials.map((credential) => credential.length - 1),
  );
  const excludedPath = resolve(patternFile);
  const visited = new Set();
  for (const root of requestedRoots) {
    await scanPath(root, excludedPath, credentials, overlapBytes, visited);
  }
} catch (error) {
  process.exitCode =
    error === CREDENTIAL_FOUND
      ? CREDENTIAL_REMAINS_EXIT_CODE
      : CREDENTIAL_SCAN_FAILED_EXIT_CODE;
}
`;

export function profileRuntimeCredentialScrubScript(
  root = "/tmp/aiw-harness",
): string {
  const quotedRoot = shellQuote(root);
  return `profile_runtime_root=${quotedRoot}
if [ -d "$profile_runtime_root" ]; then
  find "$profile_runtime_root" -mindepth 2 -maxdepth 2 -type d -name home -exec rm -rf -- {} +
  find "$profile_runtime_root" -mindepth 2 -maxdepth 2 -type f -name 'credentials.sh' -delete
fi`;
}

export function clarificationSnapshotCredentialSanitizationScript(input: {
  credentialPatternFile: string;
  scanRoots?: readonly string[];
  profileRuntimeRoot?: string;
  homeDir?: string;
}): string {
  const credentialPatternFile = shellQuote(input.credentialPatternFile);
  const scanRoots = [...new Set(
    input.scanRoots ?? ["/vercel/sandbox", "/tmp", "/var/tmp"],
  )];
  const scanRootArguments = scanRoots.map(shellQuote).join(" ");
  const snapshotHome = input.homeDir
    ? shellQuote(input.homeDir)
    : '"${HOME:-/vercel/sandbox}"';
  return `set -eu
credential_pattern_file=${credentialPatternFile}
snapshot_home=${snapshotHome}
trap 'rm -f -- "$credential_pattern_file"' EXIT HUP INT TERM
find /tmp -maxdepth 1 -type f -name '.aiw-clarification-credential-patterns-*' ! -path "$credential_pattern_file" -delete
find /tmp -maxdepth 1 -type f -name 'agent-env*.sh' -delete
rm -rf "$snapshot_home/.codex" "$snapshot_home/.claude" "$snapshot_home/.config/claude" "$snapshot_home/.config/claude-code"
rm -f "$snapshot_home/.claude.json" /tmp/config.toml /tmp/arthur_config.json /tmp/arthur-tracer.py
find /tmp -maxdepth 1 -type f \\( -iname '*arthur*credential*' -o -iname '*tracer*credential*' \\) -delete
${profileRuntimeCredentialScrubScript(input.profileRuntimeRoot)}
chmod 600 "$credential_pattern_file"
node --input-type=module - "$credential_pattern_file" ${scanRootArguments} "$snapshot_home" <<'AIW_CREDENTIAL_SCAN'
${EXACT_CREDENTIAL_SCAN_SOURCE}
AIW_CREDENTIAL_SCAN
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Check common reversible representations as well as the raw secret. This is
 * intentionally finite: the checkpoint contract protects against accidental
 * copies and ordinary serialization/encoding, while the sandbox remains the
 * security boundary for deliberately transformed exfiltration.
 */
export function clarificationCredentialScanPatterns(
  credentialValues: readonly string[],
): string[] {
  const patterns = new Set<string>();
  for (const value of credentialValues) {
    if (value.length === 0) continue;
    const bytes = Buffer.from(value, "utf8");
    const base64 = bytes.toString("base64");
    patterns.add(value);
    patterns.add(base64);
    patterns.add(base64.replaceAll("+", "-").replaceAll("/", "_"));
    patterns.add(base64.replace(/=+$/, ""));
    patterns.add(
      base64
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
    );
    patterns.add(bytes.toString("hex"));
    patterns.add(bytes.toString("hex").toUpperCase());
    patterns.add(encodeURIComponent(value));
    patterns.add(JSON.stringify(value).slice(1, -1));
  }
  return [...patterns].filter((pattern) => pattern.length > 0);
}

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
    const { randomUUID } = await import("node:crypto");
    const { env } = await import("../../env.js");
    const credentialValues = [
      env.ANTHROPIC_API_KEY,
      env.CODEX_API_KEY,
      env.CODEX_CHATGPT_OAUTH_TOKEN,
      env.GENAI_ENGINE_API_KEY,
    ].filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0,
    );
    const encodedCredentialValues = clarificationCredentialScanPatterns(
      credentialValues,
    ).map((value) => Buffer.from(value, "utf8").toString("base64"));
    const credentialPatternFile =
      `${CREDENTIAL_PATTERN_FILE_PREFIX}${randomUUID()}.json`;
    try {
      await withinSnapshotDeadline(
        deadline,
        "credential scan preparation",
        (signal) =>
          sandbox.writeFiles(
            [{
              path: credentialPatternFile,
              content: Buffer.from(JSON.stringify(encodedCredentialValues)),
            }],
            { signal },
          ),
      );
    } catch {
      throw new Error("clarification credential scan could not be prepared");
    }
    let sanitization: Awaited<ReturnType<typeof sandbox.runCommand>>;
    try {
      sanitization = await withinSnapshotDeadline(
        deadline,
        "credential sanitization",
        (signal) =>
          sandbox.runCommand(
            "bash",
            [
              "--noprofile",
              "--norc",
              "-c",
              clarificationSnapshotCredentialSanitizationScript({
                credentialPatternFile,
              }),
            ],
            { signal },
          ),
      );
    } catch {
      throw new Error("clarification credential sanitization could not be verified");
    }
    if (sanitization.exitCode === CREDENTIAL_REMAINS_EXIT_CODE) {
      throw new Error(
        "clarification snapshot was blocked because credential material remained after sanitization",
      );
    }
    if (sanitization.exitCode !== 0) {
      throw new Error("clarification credential sanitization could not be verified");
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

  // Persist the provider cleanup identity before polling the source stop. If a
  // retry observes an ambiguous stop boundary, the snapshot can still be
  // deleted from the compact clarification row.
  const { getDb } = await import("../db/client.js");
  const { recordHookClarificationSnapshot } = await import(
    "../clarifications/hook-store.js"
  );
  await recordHookClarificationSnapshot(getDb(), input.clarificationId, {
    snapshotId: snapshotMetadata.snapshotId,
    sourceSandboxId: snapshotMetadata.sourceSandboxId,
    expiresAt: new Date(snapshotMetadata.expiresAt),
  });

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
  agents: Array<{
    kind: AgentKind;
    model: string;
    runtime?: ResolvedHarnessRuntime;
  }>;
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
      const adapter = createAgentAdapter(
        selected.kind,
        selected.runtime?.cliSpec,
      );
      if (selected.runtime) {
        // The restored snapshot retains only installed, content-addressed CLI
        // packages. Profile homes and credentials are rebuilt at the next
        // invocation boundary, never while the run is suspended.
        continue;
      } else {
        await adapter.configure(sandbox, {
          model: selected.model,
          anthropicApiKey: env.ANTHROPIC_API_KEY,
          codexApiKey: env.CODEX_API_KEY,
          codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
          arthur,
        });
      }
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
