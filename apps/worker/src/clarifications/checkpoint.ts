import type {
  ClarificationRuntimeContext,
  ClarificationSourceHead,
} from "../db/clarifications-schema.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import type { StepsRecord } from "../workflow-definition/interpreter.js";

const MAX_CHECKPOINT_STEPS_BYTES = 256 * 1024;
const MAX_CHECKPOINT_RUNTIME_BYTES = 256 * 1024;
const SECRET_KEY =
  /(?:^|[_-])(api[_-]?key|authorization|credential|oauth|password|secret|token|cookie)(?:$|[_-])/i;

/**
 * Make block outputs safe for durable storage without silently dropping values
 * that downstream bindings may need. Oversized payloads fail the park visibly;
 * replaying predecessors is never used as a fallback.
 */
export function checkpointStepsForPersistence(steps: StepsRecord): StepsRecord {
  assertNoSecretLikeKeys(steps);
  const serialized = JSON.stringify(steps);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_CHECKPOINT_STEPS_BYTES) {
    throw new Error(
      `clarification checkpoint outputs exceed ${MAX_CHECKPOINT_STEPS_BYTES} bytes; reduce block output size before retrying`,
    );
  }
  return JSON.parse(serialized) as StepsRecord;
}

/** Persist only the typed, JSON-safe continuation state and fail instead of truncating it. */
export function checkpointRuntimeContextForPersistence(
  context: ClarificationRuntimeContext,
): ClarificationRuntimeContext {
  assertNoSecretLikeKeys(context);
  const serialized = JSON.stringify(context);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_CHECKPOINT_RUNTIME_BYTES) {
    throw new Error(
      `clarification checkpoint runtime context exceeds ${MAX_CHECKPOINT_RUNTIME_BYTES} bytes; reduce clarification history or prompt context before retrying`,
    );
  }
  return JSON.parse(serialized) as ClarificationRuntimeContext;
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

function assertNoSecretLikeKeys(value: unknown, path: string[] = []): void {
  const key = path[path.length - 1] ?? "";
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (SECRET_KEY.test(normalizedKey)) {
    throw new Error(
      `clarification checkpoint cannot persist secret-like output at ${path.join(".")}; remove the sensitive value before requesting human input`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeKeys(item, [...path, String(index)]));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    assertNoSecretLikeKeys(child, [...path, childKey]);
  }
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
    (key === "sandboxId" ||
      key === "workspaceId" ||
      (key === "id" && parentKey === "workspace"))
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
