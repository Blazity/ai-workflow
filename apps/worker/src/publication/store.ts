import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { VcsProvider } from "../adapters/vcs/repository-directory.js";
import type { Db } from "../db/client.js";
import {
  publicationAttemptRepositories,
  publicationAttempts,
} from "../db/schema.js";

export type PublicationAttemptStatus =
  | "preflighting"
  | "pushing"
  | "finalized"
  | "creating_prs"
  | "published"
  | "failed";

export interface PublicationRepositoryRecord {
  provider: VcsProvider;
  repoPath: string;
  branchName: string;
  defaultBranch: string;
  changed: boolean;
  expectedHead: string | null;
  targetHead: string | null;
  pushedHead: string | null;
  pr: { id: number; url: string; isNew: boolean } | null;
  failure: string | null;
}

export interface PublicationAttemptRecord {
  id: string;
  runId: string;
  blockId: string;
  status: PublicationAttemptStatus;
  failure: string | null;
  repositories: PublicationRepositoryRecord[];
}

export async function createOrGetPublicationAttempt(
  db: Db,
  input: {
    runId: string;
    blockId: string;
    repositories: Array<{
      provider: VcsProvider;
      repoPath: string;
      branchName: string;
      defaultBranch: string;
    }>;
  },
): Promise<{ attempt: PublicationAttemptRecord; created: boolean }> {
  const id = randomUUID();
  const repositoryInput = input.repositories.length
    ? sql`VALUES ${sql.join(
        input.repositories.map(
          (repository) =>
            sql`(${repository.provider}, ${repository.repoPath}, ${repository.branchName}, ${repository.defaultBranch})`,
        ),
        sql`, `,
      )}`
    : sql`SELECT NULL::text, NULL::text, NULL::text, NULL::text WHERE false`;

  // neon-http deliberately has no interactive transaction API. A single
  // data-modifying CTE keeps parent + child initialization statement-atomic in
  // PostgreSQL while remaining supported by both Neon and PGlite.
  const initialized = await db.execute(sql`
    WITH inserted_attempt AS (
      INSERT INTO publication_attempts (id, run_id, block_id)
      VALUES (${id}, ${input.runId}, ${input.blockId})
      ON CONFLICT (run_id, block_id) DO NOTHING
      RETURNING id
    ), selected_attempt AS (
      SELECT id, true AS created FROM inserted_attempt
      UNION ALL
      SELECT id, false AS created
      FROM publication_attempts
      WHERE run_id = ${input.runId}
        AND block_id = ${input.blockId}
        AND NOT EXISTS (SELECT 1 FROM inserted_attempt)
      LIMIT 1
    ), repository_input (provider, repo_path, branch_name, default_branch) AS (
      ${repositoryInput}
    ), inserted_repositories AS (
      INSERT INTO publication_attempt_repositories
        (attempt_id, provider, repo_path, branch_name, default_branch)
      SELECT a.id, r.provider, r.repo_path, r.branch_name, r.default_branch
      FROM selected_attempt a
      CROSS JOIN repository_input r
      ON CONFLICT (attempt_id, provider, repo_path) DO NOTHING
      RETURNING attempt_id
    ), write_barrier AS (
      SELECT count(*) AS count FROM inserted_repositories
    )
    SELECT a.id, a.created
    FROM selected_attempt a
    CROSS JOIN write_barrier
  `);
  const selected = rawRows<{ id: string; created: boolean }>(initialized)[0];
  const created = selected?.created ?? false;
  const attempt = selected
    ? await getPublicationAttempt(db, selected.id)
    : await getPublicationAttemptForRunBlock(db, input.runId, input.blockId);
  if (!attempt) throw new Error("publication attempt was not persisted");
  return { attempt, created };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export async function getPublicationAttempt(
  db: Db,
  attemptId: string,
): Promise<PublicationAttemptRecord | null> {
  const attempts = await db
    .select()
    .from(publicationAttempts)
    .where(eq(publicationAttempts.id, attemptId))
    .limit(1);
  if (!attempts[0]) return null;
  return mapAttempt(
    attempts[0],
    await db
      .select()
      .from(publicationAttemptRepositories)
      .where(eq(publicationAttemptRepositories.attemptId, attemptId))
      .orderBy(
        asc(publicationAttemptRepositories.provider),
        asc(publicationAttemptRepositories.repoPath),
      ),
  );
}

async function getPublicationAttemptForRunBlock(
  db: Db,
  runId: string,
  blockId: string,
): Promise<PublicationAttemptRecord | null> {
  const attempts = await db
    .select()
    .from(publicationAttempts)
    .where(
      and(
        eq(publicationAttempts.runId, runId),
        eq(publicationAttempts.blockId, blockId),
      ),
    )
    .limit(1);
  return attempts[0] ? getPublicationAttempt(db, attempts[0].id) : null;
}

export async function recordPublicationRepositoryPreflight(
  db: Db,
  input: {
    attemptId: string;
    provider: VcsProvider;
    repoPath: string;
    changed: boolean;
    expectedHead?: string | null;
    targetHead?: string | null;
    failure?: string | null;
  },
): Promise<void> {
  await db
    .update(publicationAttemptRepositories)
    .set({
      changed: input.changed,
      expectedHead: input.expectedHead ?? null,
      targetHead: input.targetHead ?? null,
      ...(input.failure !== undefined ? { failure: input.failure } : {}),
      updatedAt: sql`now()`,
    })
    .where(repositoryWhere(input));
}

export async function recordPublicationRepositoryPush(
  db: Db,
  input: {
    attemptId: string;
    provider: VcsProvider;
    repoPath: string;
    pushedHead: string;
  },
): Promise<void> {
  await db
    .update(publicationAttemptRepositories)
    .set({ pushedHead: input.pushedHead, failure: null, updatedAt: sql`now()` })
    .where(repositoryWhere(input));
}

export async function recordPublicationPullRequest(
  db: Db,
  input: {
    attemptId: string;
    provider: VcsProvider;
    repoPath: string;
    pr: { id: number; url: string; isNew: boolean };
  },
): Promise<void> {
  await db
    .update(publicationAttemptRepositories)
    .set({
      prId: input.pr.id,
      prUrl: input.pr.url,
      prIsNew: input.pr.isNew,
      failure: null,
      updatedAt: sql`now()`,
    })
    .where(repositoryWhere(input));
}

export async function recordPublicationRepositoryFailure(
  db: Db,
  input: {
    attemptId: string;
    provider: VcsProvider;
    repoPath: string;
    failure: string;
  },
): Promise<void> {
  await db
    .update(publicationAttemptRepositories)
    .set({ failure: input.failure, updatedAt: sql`now()` })
    .where(repositoryWhere(input));
}

export async function markPublicationAttemptPushing(db: Db, attemptId: string): Promise<void> {
  await setAttemptStatus(db, attemptId, "preflighting", "pushing");
}

export async function markPublicationAttemptFinalized(db: Db, attemptId: string): Promise<void> {
  await setAttemptStatus(db, attemptId, "pushing", "finalized");
}

export async function markPublicationAttemptCreatingPrs(db: Db, attemptId: string): Promise<void> {
  await setAttemptStatus(db, attemptId, "finalized", "creating_prs");
}

export async function markPublicationAttemptPublished(db: Db, attemptId: string): Promise<void> {
  await setAttemptStatus(db, attemptId, "creating_prs", "published");
}

export async function failPublicationAttempt(
  db: Db,
  attemptId: string,
  failure: string,
): Promise<void> {
  await db
    .update(publicationAttempts)
    .set({ status: "failed", failure, updatedAt: sql`now()` })
    .where(
      and(
        eq(publicationAttempts.id, attemptId),
        inArray(publicationAttempts.status, [
          "preflighting",
          "pushing",
          "creating_prs",
        ]),
      ),
    );
}

async function setAttemptStatus(
  db: Db,
  attemptId: string,
  expectedStatus: PublicationAttemptStatus,
  status: PublicationAttemptStatus,
): Promise<void> {
  await db
    .update(publicationAttempts)
    .set({ status, failure: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(publicationAttempts.id, attemptId),
        eq(publicationAttempts.status, expectedStatus),
      ),
    );
}

function repositoryWhere(input: {
  attemptId: string;
  provider: VcsProvider;
  repoPath: string;
}) {
  return and(
    eq(publicationAttemptRepositories.attemptId, input.attemptId),
    eq(publicationAttemptRepositories.provider, input.provider),
    eq(publicationAttemptRepositories.repoPath, input.repoPath),
  );
}

type AttemptSelect = typeof publicationAttempts.$inferSelect;
type RepositorySelect = typeof publicationAttemptRepositories.$inferSelect;

function mapAttempt(
  attempt: AttemptSelect,
  repositories: RepositorySelect[],
): PublicationAttemptRecord {
  return {
    id: attempt.id,
    runId: attempt.runId,
    blockId: attempt.blockId,
    status: attempt.status as PublicationAttemptStatus,
    failure: attempt.failure,
    repositories: repositories.map((repo) => ({
      provider: repo.provider as VcsProvider,
      repoPath: repo.repoPath,
      branchName: repo.branchName,
      defaultBranch: repo.defaultBranch,
      changed: repo.changed,
      expectedHead: repo.expectedHead,
      targetHead: repo.targetHead,
      pushedHead: repo.pushedHead,
      pr:
        repo.prId !== null && repo.prUrl !== null && repo.prIsNew !== null
          ? { id: repo.prId, url: repo.prUrl, isNew: repo.prIsNew }
          : null,
      failure: repo.failure,
    })),
  };
}
