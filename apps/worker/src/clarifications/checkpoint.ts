import type { StepsRecord } from "../workflow-definition/interpreter.js";

/** Replace structured references to the stopped source, never arbitrary prose. */
export function restoreCheckpointSandboxReferences(
  steps: StepsRecord,
  sourceSandboxId: string,
  restoredSandboxId: string,
): StepsRecord {
  return restoreCheckpointValueSandboxReferences(
    steps,
    sourceSandboxId,
    restoredSandboxId,
  );
}

/** Apply the same structured sandbox-reference rewrite to versioned scheduler
 * checkpoints without replacing arbitrary prose that happens to contain an ID. */
export function restoreCheckpointValueSandboxReferences<T>(
  value: T,
  sourceSandboxId: string,
  restoredSandboxId: string,
): T {
  return rewriteSandboxReferences(
    value,
    sourceSandboxId,
    restoredSandboxId,
    null,
  ) as T;
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
