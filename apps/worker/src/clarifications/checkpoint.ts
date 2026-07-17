import type { ClarificationSourceHead } from "../db/clarifications-schema.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import type { StepsRecord } from "../workflow-definition/interpreter.js";

const MAX_CHECKPOINT_STEPS_BYTES = 256 * 1024;
const SECRET_KEY =
  /(?:^|[_-])(api[_-]?key|authorization|credential|oauth|password|secret|token|cookie)(?:$|[_-])/i;

/**
 * Make block outputs safe for durable storage without silently dropping values
 * that downstream bindings may need. Oversized payloads fail the park visibly;
 * replaying predecessors is never used as a fallback.
 */
export function checkpointStepsForPersistence(steps: StepsRecord): StepsRecord {
  const safe = redactSecrets(steps) as StepsRecord;
  const bytes = Buffer.byteLength(JSON.stringify(safe), "utf8");
  if (bytes > MAX_CHECKPOINT_STEPS_BYTES) {
    throw new Error(
      `clarification checkpoint outputs exceed ${MAX_CHECKPOINT_STEPS_BYTES} bytes; reduce block output size before retrying`,
    );
  }
  return safe;
}

/** Replace structured references to the stopped source, never arbitrary prose. */
export function restoreCheckpointSandboxReferences(
  steps: StepsRecord,
  sourceSandboxId: string,
  restoredSandboxId: string,
): StepsRecord {
  return rewriteSandboxReferences(
    steps,
    sourceSandboxId,
    restoredSandboxId,
    null,
  ) as StepsRecord;
}

export function checkpointSourceHeads(
  manifest: WorkspaceManifest,
): ClarificationSourceHead[] {
  return manifest.repositories.map((repo) => {
    if (!repo.preAgentSha) {
      throw new Error(
        `clarification checkpoint source head is missing for ${repo.provider}:${repo.repoPath}`,
      );
    }
    return { provider: repo.provider, repoPath: repo.repoPath, sha: repo.preAgentSha };
  });
}

export function researchPlanFromCheckpoint(steps: StepsRecord): string {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const plan = outputs[index]?.output.plan;
    if (typeof plan === "string" && plan.trim()) return plan;
  }
  return "";
}

function redactSecrets(value: unknown, key = ""): unknown {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (SECRET_KEY.test(normalizedKey)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactSecrets(child, childKey);
  }
  return out;
}

function rewriteSandboxReferences(
  value: unknown,
  sourceSandboxId: string,
  restoredSandboxId: string,
  parentKey: string | null,
  key = "",
): unknown {
  if (
    value === sourceSandboxId &&
    (key === "sandboxId" || (key === "id" && parentKey === "workspace"))
  ) {
    return restoredSandboxId;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteSandboxReferences(item, sourceSandboxId, restoredSandboxId, key),
    );
  }
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = rewriteSandboxReferences(
      child,
      sourceSandboxId,
      restoredSandboxId,
      key,
      childKey,
    );
  }
  return out;
}
