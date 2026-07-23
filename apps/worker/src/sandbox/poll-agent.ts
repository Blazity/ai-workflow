import { getSandboxCredentials } from "./credentials.js";
import type { CollectedPhaseArtifacts, PhaseArtifactPaths } from "./agents/types.js";
import {
  REPLAY_CAPTURE_TIMEOUT_MS,
  replayCaptureWithinTimeout,
} from "../run-observability/capture-timeout.js";
import { configuredReplaySecrets } from "../run-observability/configured-secrets.js";
import { sanitizeReplayValue } from "../run-observability/sanitizer.js";
import type { ReplaySanitizationMetadata } from "@shared/contracts";

/**
 * Generalized sentinel check — works with any sentinel file path.
 */
export async function checkPhaseDone(
  sandboxId: string,
  sentinelFile: string,
): Promise<boolean | "stopped"> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    if (sandbox.status !== "running") {
      return "stopped";
    }

    const result = await sandbox.runCommand("test", ["-f", sentinelFile]);
    return result.exitCode === 0;
  } catch {
    return "stopped";
  }
}

/**
 * Generalized output collector — reads from any stdout/stderr file paths.
 * Returns raw string. Caller is responsible for parsing.
 */
export async function collectPhaseOutput(
  sandboxId: string,
  outputFile: string,
  stderrFile: string,
): Promise<string> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [outputFile]);
  const stdout = (await stdoutResult.stdout()).trim();

  const stderrResult = await sandbox.runCommand("cat", [stderrFile]);
  const stderr = (await stderrResult.stdout()).trim();

  return stdout || stderr;
}

/**
 * Collect raw + (optional) structured phase output. Replaces collectPhaseOutput
 * in adapter-aware code paths.
 */
async function collectPhaseArtifacts(
  sandboxId: string,
  paths: Pick<PhaseArtifactPaths, "stdout" | "stderr" | "structuredOutput" | "exitCode">,
): Promise<CollectedPhaseArtifacts> {
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [paths.stdout]);
  const stdoutText = (await stdoutResult.stdout()).trim();
  const stderrResult = await sandbox.runCommand("cat", [paths.stderr]);
  const stderrText = (await stderrResult.stdout()).trim();

  let structuredOutput: string | null = null;
  if (paths.structuredOutput) {
    const result = await sandbox.runCommand("cat", [paths.structuredOutput]);
    const text = (await result.stdout()).trim();
    structuredOutput = text || null;
  }

  const exitCodeResult = await sandbox.runCommand("cat", [paths.exitCode]);
  const exitCodeText = (await exitCodeResult.stdout()).trim();
  const parsedExitCode = /^-?\d+$/.test(exitCodeText) ? Number(exitCodeText) : null;
  return {
    stdout: stdoutText,
    stderr: stderrText,
    structuredOutput,
    exitCode: parsedExitCode,
  };
}

export async function collectPhase(
  sandboxId: string,
  paths: Pick<PhaseArtifactPaths, "stdout" | "stderr" | "structuredOutput" | "exitCode">,
): Promise<CollectedPhaseArtifacts> {
  "use step";
  return collectPhaseArtifacts(sandboxId, paths);
}

export interface CollectedReplayPhaseDiagnostics
  extends CollectedPhaseArtifacts {
  diagnosticSanitization: {
    stdout: ReplaySanitizationMetadata;
    stderr: ReplaySanitizationMetadata;
  };
}

interface BoundedDiagnosticTail {
  text: string;
  sourceBytes: number | null;
  truncated: boolean;
}

function safeReplayDiagnostic(
  source: BoundedDiagnosticTail,
): {
  text: string;
  metadata: ReplaySanitizationMetadata;
} {
  const envelope = sanitizeReplayValue(source.text, {
    secrets: configuredReplaySecrets(),
    retain: "tail",
  });
  return {
    text:
      typeof envelope.value === "string"
        ? envelope.value
        : "[replay diagnostic unavailable]",
    metadata: {
      ...envelope.metadata,
      truncated: envelope.metadata.truncated || source.truncated,
      originalBytes: Math.max(
        envelope.metadata.originalBytes,
        source.sourceBytes ?? 0,
      ),
    },
  };
}

const REPLAY_DIAGNOSTIC_SOURCE_MAX_BYTES = 128 * 1024;

async function collectBoundedReplayPhaseDiagnostics(
  sandboxId: string,
  paths: Pick<
    PhaseArtifactPaths,
    "stdout" | "stderr" | "structuredOutput" | "exitCode"
  >,
): Promise<{
  stdout: BoundedDiagnosticTail;
  stderr: BoundedDiagnosticTail;
  exitCode: number | null;
}> {
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({
    sandboxId,
    ...getSandboxCredentials(),
  });
  const boundedTail = async (path: string): Promise<BoundedDiagnosticTail> => {
    const sizeResult = await sandbox.runCommand("wc", ["-c", "--", path]);
    const sizeText = (await sizeResult.stdout()).trim();
    const sizeMatch = /^(\d+)(?:\s|$)/.exec(sizeText);
    const sourceBytes = sizeMatch ? Number(sizeMatch[1]) : null;
    const tailResult = await sandbox.runCommand("tail", [
      "-c",
      String(REPLAY_DIAGNOSTIC_SOURCE_MAX_BYTES),
      "--",
      path,
    ]);
    const text = (await tailResult.stdout()).trim();
    return {
      text,
      sourceBytes,
      truncated:
        sourceBytes === null
          ? Buffer.byteLength(text, "utf8") >=
            REPLAY_DIAGNOSTIC_SOURCE_MAX_BYTES
          : sourceBytes > REPLAY_DIAGNOSTIC_SOURCE_MAX_BYTES,
    };
  };
  const [stdout, stderr, exitCodeResult] = await Promise.all([
    boundedTail(paths.stdout),
    boundedTail(paths.stderr),
    sandbox.runCommand("tail", ["-c", "32", "--", paths.exitCode]),
  ]);
  const exitCodeText = (await exitCodeResult.stdout()).trim();
  return {
    stdout,
    stderr,
    exitCode: /^-?\d+$/.test(exitCodeText) ? Number(exitCodeText) : null,
  };
}

/**
 * Timeout diagnostics must never replace the phase timeout with a stuck
 * sandbox read or persist raw provider output as a durable Workflow step
 * result. This replay-only collector sanitizes inside the step and abandons
 * diagnostic I/O after the same short bound used by other replay writes.
 */
export async function collectPhaseReplayDiagnostics(
  sandboxId: string,
  paths: Pick<PhaseArtifactPaths, "stdout" | "stderr" | "structuredOutput" | "exitCode">,
  timeoutMs = REPLAY_CAPTURE_TIMEOUT_MS,
): Promise<CollectedReplayPhaseDiagnostics> {
  "use step";
  const artifacts = await replayCaptureWithinTimeout(
    collectBoundedReplayPhaseDiagnostics(sandboxId, paths),
    timeoutMs,
  );
  const stdout = safeReplayDiagnostic(artifacts.stdout);
  const stderr = safeReplayDiagnostic(artifacts.stderr);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    structuredOutput: null,
    exitCode: artifacts.exitCode,
    diagnosticSanitization: {
      stdout: stdout.metadata,
      stderr: stderr.metadata,
    },
  };
}

/**
 * Reconnects to a sandbox and stops it.
 */
export async function teardownSandbox(sandboxId: string): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
    await sandbox.stop();
  } catch {
    // Teardown failures are non-critical (sandbox may have already stopped)
  }
}

/**
 * Tears down every provided sandbox id, de-duplicated and best-effort: one
 * failing teardown never skips the rest. Used to clean up all sandboxes a run
 * created (a prepare_workspace inside a loop makes a fresh one per iteration),
 * not just the most recent. `teardown` is injectable for tests.
 */
export async function teardownSandboxes(
  sandboxIds: Iterable<string>,
  teardown: (sandboxId: string) => Promise<void> = teardownSandbox,
): Promise<void> {
  for (const sandboxId of new Set(sandboxIds)) {
    try {
      await teardown(sandboxId);
    } catch {
      // Best-effort: keep tearing down the remaining sandboxes.
    }
  }
}
