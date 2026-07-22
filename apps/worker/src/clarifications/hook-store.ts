import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ClarificationStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { clarificationRequests } from "../db/schema.js";

export interface HookClarificationRow {
  id: string;
  ticketKey: string | null;
  subjectKey: string;
  runId: string;
  blockId: string | null;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers: string[] | null;
  status: ClarificationStatus;
  hookToken: string;
  askedAt: Date;
  expiresAt: Date | null;
  answer: string | null;
  answeredById: string | null;
  answeredByLabel: string | null;
  answeredAt: Date | null;
  snapshotId: string | null;
  sourceSandboxId: string | null;
  snapshotExpiresAt: Date | null;
  cleanupState: string;
}

function mapHookRow(
  row: typeof clarificationRequests.$inferSelect,
): HookClarificationRow {
  if (!row.subjectKey || !row.hookToken) {
    throw new Error(`clarification ${row.id} is missing its hook identity`);
  }
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    subjectKey: row.subjectKey,
    runId: row.runId,
    blockId: row.blockId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    status: row.status as ClarificationStatus,
    hookToken: row.hookToken,
    askedAt: row.askedAt,
    expiresAt: row.expiresAt,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt,
    snapshotId: row.snapshotId,
    sourceSandboxId: row.sourceSandboxId,
    snapshotExpiresAt: row.snapshotExpiresAt,
    cleanupState: row.cleanupState,
  };
}

/** Create an unpublished row before registering its Workflow hook. */
export async function prepareHookClarification(
  db: Db,
  input: {
    ticketKey: string | null;
    subjectKey: string;
    runId: string;
    blockId: string;
    definitionId: number | null;
    definitionVersion: number | null;
    questions: string[];
    suggestedAnswers?: string[] | null;
  },
): Promise<HookClarificationRow> {
  const id = randomUUID();
  const hookToken = `clarification:${id}`;
  const [row] = await db
    .insert(clarificationRequests)
    .values({
      id,
      ticketKey: input.ticketKey,
      subjectKey: input.subjectKey,
      runId: input.runId,
      blockId: input.blockId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      questions: input.questions,
      suggestedAnswers: input.suggestedAnswers ?? null,
      status: "preparing",
      hookToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    })
    .returning();
  if (!row) throw new Error("failed to prepare clarification");
  return mapHookRow(row);
}

export async function recordHookClarificationSnapshot(
  db: Db,
  id: string,
  snapshot: { snapshotId: string; sourceSandboxId: string; expiresAt: Date },
): Promise<void> {
  const [updated] = await db
    .update(clarificationRequests)
    .set({
      snapshotId: snapshot.snapshotId,
      sourceSandboxId: snapshot.sourceSandboxId,
      snapshotExpiresAt: snapshot.expiresAt,
      cleanupState: "retained",
    })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "preparing")))
    .returning({ id: clarificationRequests.id });
  if (!updated) throw new Error(`clarification ${id} is no longer preparing`);
}

/** Make a question visible only after its hook and optional snapshot are durable. */
export async function publishHookClarification(
  db: Db,
  id: string,
): Promise<HookClarificationRow> {
  const [row] = await db
    .update(clarificationRequests)
    .set({ status: "pending", publishedAt: new Date() })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "preparing")))
    .returning();
  if (!row) throw new Error(`clarification ${id} is no longer preparing`);
  return mapHookRow(row);
}

export async function getHookClarification(
  db: Db,
  id: string,
): Promise<HookClarificationRow | null> {
  const [row] = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.id, id))
    .limit(1);
  return row?.hookToken ? mapHookRow(row) : null;
}

export async function answerHookClarification(
  db: Db,
  id: string,
  answer: string,
  actor: { id: string; label: string },
): Promise<HookClarificationRow | null> {
  const [row] = await db
    .update(clarificationRequests)
    .set({
      status: "answered",
      answer,
      answeredById: actor.id,
      answeredByLabel: actor.label,
      answeredAt: new Date(),
    })
    .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending")))
    .returning();
  return row ? mapHookRow(row) : null;
}

export async function markHookClarificationCleanup(
  db: Db,
  id: string,
  result: { status: "deleted" } | { status: "failed"; error: string },
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set(
      result.status === "deleted"
        ? { cleanupState: "deleted", cleanupError: null }
        : { cleanupState: "failed", cleanupError: result.error.slice(0, 2000) },
    )
    .where(eq(clarificationRequests.id, id));
}

export async function supersedePreparingHookClarification(
  db: Db,
  id: string,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ status: "superseded" })
    .where(
      and(
        eq(clarificationRequests.id, id),
        sql`${clarificationRequests.status} in ('preparing', 'pending')`,
      ),
    );
}
