import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import {
  workflowPrReviewPublicationComments,
  workflowPrReviewPublications,
  workflowRunExternalChecks,
  workflowRuns,
} from "../schema.js";
import type { GateStatusRef } from "../schema/runs.js";

export type PrExternalResourcesDb = Db;
export type ExternalPrCheck = typeof workflowRunExternalChecks.$inferSelect;
export type PrReviewPublication = typeof workflowPrReviewPublications.$inferSelect;

export async function findPrCheckForAttempt(
  db: Db,
  input: { runId: string; nodeId: string; attempt: number; activationScope: string },
): Promise<ExternalPrCheck | undefined> {
  const rows = await db
    .select()
    .from(workflowRunExternalChecks)
    .where(and(
      eq(workflowRunExternalChecks.runId, input.runId),
      eq(workflowRunExternalChecks.nodeId, input.nodeId),
      eq(workflowRunExternalChecks.attempt, input.attempt),
      eq(workflowRunExternalChecks.activationScope, input.activationScope),
    ))
    .limit(1);
  return rows[0];
}

async function findPrCheckById(
  db: Db,
  id: string,
): Promise<ExternalPrCheck | undefined> {
  const rows = await db.select().from(workflowRunExternalChecks)
    .where(eq(workflowRunExternalChecks.id, id)).limit(1);
  return rows[0];
}

export async function insertPrCheck(
  db: Db,
  input: {
    id: string; runId: string; nodeId: string; attempt: number; activationScope: string;
    subjectKey: string; provider: string; repository: string; prNumber: number;
    headSha: string; name: string;
  },
): Promise<void> {
  await db.insert(workflowRunExternalChecks).values({ ...input, providerReference: null, state: "creating" });
}

export async function markPrCheckPending(
  db: Db,
  input: { id: string; providerReference: GateStatusRef; headSha?: string },
): Promise<void> {
  await db.update(workflowRunExternalChecks).set({
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
    providerReference: input.providerReference,
    state: "pending",
    updatedAt: new Date(),
  }).where(eq(workflowRunExternalChecks.id, input.id));
}

export async function markPrCheckCreationFailed(
  db: Db,
  input: { id: string; error: string },
): Promise<void> {
  await db.update(workflowRunExternalChecks).set({ closureIntent: "cancelled", lastError: input.error, updatedAt: new Date() })
    .where(eq(workflowRunExternalChecks.id, input.id));
}

export async function markPrCheckClosing(
  db: Db,
  input: { id: string; intent: string },
): Promise<void> {
  await db.update(workflowRunExternalChecks).set({ state: "closing", closureIntent: input.intent, updatedAt: new Date() })
    .where(eq(workflowRunExternalChecks.id, input.id));
}

export async function completePrCheck(
  db: Db,
  input: { id: string; conclusion: string; closureIntent?: string },
): Promise<void> {
  await db.update(workflowRunExternalChecks).set({
    ...(input.closureIntent === undefined ? {} : { closureIntent: input.closureIntent }),
    state: "completed", conclusion: input.conclusion, completedAt: new Date(), updatedAt: new Date(), lastError: null,
  })
    .where(eq(workflowRunExternalChecks.id, input.id));
}

export async function markReconciledPrCheckPending(
  db: Db,
  input: { id: string; providerReference: GateStatusRef; intent: string },
): Promise<void> {
  await db.update(workflowRunExternalChecks).set({
    providerReference: input.providerReference,
    state: "closing",
    closureIntent: input.intent,
    updatedAt: new Date(),
  }).where(eq(workflowRunExternalChecks.id, input.id));
}

export async function markPrCheckRetry(
  db: Db,
  input: { id: string; retryCount: number; error: string },
): Promise<void> {
  await db.update(workflowRunExternalChecks).set({ retryCount: input.retryCount, lastError: input.error, updatedAt: new Date() })
    .where(eq(workflowRunExternalChecks.id, input.id));
}

export async function listOpenPrChecks(
  db: Db,
  input: { runId: string; checkIds?: string[] },
): Promise<ExternalPrCheck[]> {
  const filters = [
    eq(workflowRunExternalChecks.runId, input.runId),
    inArray(workflowRunExternalChecks.state, ["pending", "closing"]),
  ];
  if (input.checkIds) filters.push(inArray(workflowRunExternalChecks.id, input.checkIds));
  return db.select().from(workflowRunExternalChecks).where(and(...filters));
}

async function listReconcilePrChecks(
  db: Db,
  limit: number,
): Promise<ExternalPrCheck[]> {
  return db.select().from(workflowRunExternalChecks)
    .where(inArray(workflowRunExternalChecks.state, ["creating", "pending", "closing"]))
    .orderBy(asc(workflowRunExternalChecks.updatedAt)).limit(limit);
}

async function listRunStatuses(
  db: Db,
  runIds: string[],
): Promise<Array<{ runId: string; status: string | null }>> {
  if (runIds.length === 0) return [];
  return db.select({ runId: workflowRuns.runId, status: workflowRuns.status })
    .from(workflowRuns).where(inArray(workflowRuns.runId, runIds));
}

export async function listPrReviewPublicationsForRound(
  db: Db,
  input: { provider: string; repository: string; prNumber: number; headSha: string },
): Promise<PrReviewPublication[]> {
  return db.select().from(workflowPrReviewPublications).where(and(
    eq(workflowPrReviewPublications.provider, input.provider),
    eq(workflowPrReviewPublications.repository, input.repository),
    eq(workflowPrReviewPublications.prNumber, input.prNumber),
    eq(workflowPrReviewPublications.headSha, input.headSha),
  )).orderBy(asc(workflowPrReviewPublications.createdAt));
}

export async function insertPrReviewPublication(
  db: Db,
  input: {
    id: string; runId: string; nodeId: string; attempt: number; activationScope: string;
    provider: string; repository: string; prNumber: number; headSha: string; contentHash: string;
    decision: string; summary: string; inlineCommentCount: number; summaryFallbackCount: number;
    commentContentHashes: string[];
  },
): Promise<void> {
  if (input.commentContentHashes.length === 0) {
    await db.insert(workflowPrReviewPublications).values({
      id: input.id, runId: input.runId, nodeId: input.nodeId, attempt: input.attempt,
      activationScope: input.activationScope, provider: input.provider, repository: input.repository,
      prNumber: input.prNumber, headSha: input.headSha, contentHash: input.contentHash,
      decision: input.decision, summary: input.summary, inlineCommentCount: input.inlineCommentCount,
      summaryFallbackCount: input.summaryFallbackCount,
    });
    return;
  }
  const hashes = sql.join(input.commentContentHashes.map((hash) => sql`${hash}`), sql`, `);
  await db.execute(sql`
    WITH publication AS (
      INSERT INTO ${workflowPrReviewPublications} (
        id, run_id, node_id, attempt, activation_scope, provider, repository, pr_number,
        head_sha, content_hash, decision, summary, inline_comment_count, summary_fallback_count
      ) VALUES (
        ${input.id}, ${input.runId}, ${input.nodeId}, ${input.attempt}, ${input.activationScope},
        ${input.provider}, ${input.repository}, ${input.prNumber}, ${input.headSha},
        ${input.contentHash}, ${input.decision}, ${input.summary}, ${input.inlineCommentCount},
        ${input.summaryFallbackCount}
      ) RETURNING id
    )
    INSERT INTO ${workflowPrReviewPublicationComments} (publication_id, content_hash)
    SELECT publication.id, hashes.content_hash
    FROM publication CROSS JOIN unnest(ARRAY[${hashes}]::text[]) AS hashes(content_hash)
  `);
}

export async function markPrReviewPublicationFailed(
  db: Db,
  input: { id: string; diagnosticId: string },
): Promise<void> {
  await db.update(workflowPrReviewPublications).set({
    lastError: "Provider review publication failed.", diagnosticId: input.diagnosticId, updatedAt: new Date(),
  }).where(eq(workflowPrReviewPublications.id, input.id));
}

export async function markPrReviewPublicationPublished(
  db: Db,
  input: { id: string; providerReference: string; commentProviderReferences: Array<{ contentHash: string; providerReference: string }> },
): Promise<void> {
  const references = JSON.stringify(input.commentProviderReferences.map((reference) => ({
    content_hash: reference.contentHash,
    provider_reference: reference.providerReference,
  })));
  await db.execute(sql`
    WITH publication AS (
      UPDATE ${workflowPrReviewPublications}
      SET state = 'published', provider_reference = ${input.providerReference}, published_at = now(),
          updated_at = now(), last_error = NULL
      WHERE id = ${input.id}
      RETURNING id
    )
    UPDATE ${workflowPrReviewPublicationComments} comments
    SET state = 'published', published_at = now(),
        provider_reference = COALESCE(
          (SELECT refs.provider_reference
           FROM jsonb_to_recordset(${references}::jsonb) AS refs(content_hash text, provider_reference text)
           WHERE refs.content_hash = comments.content_hash),
          comments.provider_reference
        )
    FROM publication
    WHERE comments.publication_id = publication.id
  `);
}

export function createPrExternalResourcesRepository(db: Db) {
  return {
    findPrCheckForAttempt: (input: Parameters<typeof findPrCheckForAttempt>[1]) =>
      findPrCheckForAttempt(db, input),
    findPrCheckById: (id: string) => findPrCheckById(db, id),
    insertPrCheck: (input: Parameters<typeof insertPrCheck>[1]) =>
      insertPrCheck(db, input),
    markPrCheckPending: (input: Parameters<typeof markPrCheckPending>[1]) =>
      markPrCheckPending(db, input),
    markPrCheckCreationFailed: (
      input: Parameters<typeof markPrCheckCreationFailed>[1],
    ) => markPrCheckCreationFailed(db, input),
    markPrCheckClosing: (input: Parameters<typeof markPrCheckClosing>[1]) =>
      markPrCheckClosing(db, input),
    completePrCheck: (input: Parameters<typeof completePrCheck>[1]) =>
      completePrCheck(db, input),
    markReconciledPrCheckPending: (
      input: Parameters<typeof markReconciledPrCheckPending>[1],
    ) => markReconciledPrCheckPending(db, input),
    markPrCheckRetry: (input: Parameters<typeof markPrCheckRetry>[1]) =>
      markPrCheckRetry(db, input),
    listOpenPrChecks: (input: Parameters<typeof listOpenPrChecks>[1]) =>
      listOpenPrChecks(db, input),
    listReconcilePrChecks: (limit: number) => listReconcilePrChecks(db, limit),
    listRunStatuses: (runIds: string[]) => listRunStatuses(db, runIds),
    listPrReviewPublicationsForRound: (
      input: Parameters<typeof listPrReviewPublicationsForRound>[1],
    ) => listPrReviewPublicationsForRound(db, input),
    insertPrReviewPublication: (
      input: Parameters<typeof insertPrReviewPublication>[1],
    ) => insertPrReviewPublication(db, input),
    markPrReviewPublicationFailed: (
      input: Parameters<typeof markPrReviewPublicationFailed>[1],
    ) => markPrReviewPublicationFailed(db, input),
    markPrReviewPublicationPublished: (
      input: Parameters<typeof markPrReviewPublicationPublished>[1],
    ) => markPrReviewPublicationPublished(db, input),
  };
}

export type PrExternalResourcesRepository = ReturnType<
  typeof createPrExternalResourcesRepository
>;

export function createConnectedPrExternalResourcesRepository(): PrExternalResourcesRepository {
  return createPrExternalResourcesRepository(getDb());
}
