import type { SerializableClarificationSnapshot } from "./clarification-snapshot-steps.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

export async function verifyWorkspaceManifestStep(
  sandboxId: string,
  trustedManifest: WorkspaceManifest,
): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { parseVerifiedWorkspaceManifest, WORKSPACE_MANIFEST_PATH } =
    await import("../sandbox/repo-workspace.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const buffer = await sandbox.readFileToBuffer({ path: WORKSPACE_MANIFEST_PATH });
  if (!buffer) {
    throw new Error(`clarification workspace manifest is missing in sandbox ${sandboxId}`);
  }
  parseVerifiedWorkspaceManifest(buffer.toString("utf8"), trustedManifest);
}
verifyWorkspaceManifestStep.maxRetries = 0;

export async function prepareClarificationHookStep(input: {
  ticketKey: string | null;
  subjectKey: string;
  runId: string;
  blockId: string;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers?: string[] | null;
}) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { prepareHookClarification } = await import("../clarifications/hook-store.js");
  const row = await prepareHookClarification(getDb(), input);
  return {
    id: row.id,
    hookToken: row.hookToken,
    snapshotRequestedAt: row.askedAt.toISOString(),
  };
}

export async function recordClarificationHookSnapshotStep(
  id: string,
  snapshot: SerializableClarificationSnapshot,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordHookClarificationSnapshot } = await import("../clarifications/hook-store.js");
  await recordHookClarificationSnapshot(getDb(), id, {
    snapshotId: snapshot.snapshotId,
    sourceSandboxId: snapshot.sourceSandboxId,
    expiresAt: new Date(snapshot.expiresAt),
  });
}

export async function publishClarificationHookStep(id: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { publishHookClarification } = await import("../clarifications/hook-store.js");
  await publishHookClarification(getDb(), id);
}

export async function markClarificationHookCleanupStep(
  id: string,
  result: { status: "deleted" } | { status: "failed"; error: string },
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markHookClarificationCleanup } = await import("../clarifications/hook-store.js");
  await markHookClarificationCleanup(getDb(), id, result);
}

export async function supersedeClarificationHookStep(id: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { supersedePreparingHookClarification } = await import("../clarifications/hook-store.js");
  await supersedePreparingHookClarification(getDb(), id);
}
