import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { GateStatusRef } from "../adapters/vcs/types.js";
import type { Db } from "../db/client.js";
import { gateCurrent, gateDedupe, gateLocks } from "../db/schema.js";

/**
 * Application-level dedupe, force-push tracking, and per-PR locking for
 * post-pr-gate runs — Postgres edition.
 *
 * Three tables (see src/db/schema.ts):
 *   gate_locks   — short-TTL mutex around the webhook critical section.
 *                  Released in `finally`; if the route process dies, the
 *                  expires_at timestamp lets the next acquirer steal it.
 *   gate_dedupe  — one row per {repo, pr, headSha}; INSERT-on-conflict is
 *                  the SET NX equivalent. Absent/expired row means "never
 *                  claimed for this SHA".
 *   gate_current — pointer to the latest run, used to cancel the previous
 *                  run on force-push.
 *
 * TTL semantics: a row past its expires_at is treated as ABSENT by every
 * read (correctness); physical deletion happens via purgeExpired() in the
 * poll cron (housekeeping). Lifetime: 14 days, matching the Redis EX.
 *
 * Each former Lua script is now a single SQL statement, so it stays atomic
 * over the sessionless neon-http driver — no transactions required.
 */

const TTL = sql`now() + interval '14 days'`;
const LOCK_TTL = sql`now() + interval '30 seconds'`;

export interface CurrentGateRun {
  runId: string;
  headSha: string;
  gateStatusRefs: GateStatusRef[];
}

function validateCheckRunIds(ids: number[]): void {
  if (!ids.every((id) => Number.isSafeInteger(id))) {
    throw new Error(`non-integer check-run ids: ${ids.join(",")}`);
  }
}

function legacyCheckRunIdsFromRefs(refs: GateStatusRef[]): number[] {
  return refs
    .filter(
      (ref): ref is Extract<GateStatusRef, { provider: "github" }> =>
        ref.provider === "github",
    )
    .map((ref) => ref.id);
}

function checkRunIdsForLegacyColumn(gateStatusRefs: GateStatusRef[]): number[] {
  const checkRunIds = legacyCheckRunIdsFromRefs(gateStatusRefs);
  validateCheckRunIds(checkRunIds);
  return checkRunIds;
}

export class GateStore {
  constructor(private db: Db) {}

  /**
   * Acquire the per-PR lock. Returns a token if acquired, null if busy.
   * Caller MUST call `releaseLock` with the same token in a `finally`.
   * Single statement: insert wins a free lock; the conflict-update with
   * setWhere steals an expired one; otherwise no row returns → busy.
   */
  async acquireLock(repo: string, pr: number): Promise<string | null> {
    const token = randomUUID();
    const rows = await this.db
      .insert(gateLocks)
      .values({ repo, pr, token, expiresAt: LOCK_TTL })
      .onConflictDoUpdate({
        target: [gateLocks.repo, gateLocks.pr],
        set: {
          token: sql`excluded.token`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${gateLocks.expiresAt} < now()`,
      })
      .returning({ token: gateLocks.token });
    return rows.length > 0 ? token : null;
  }

  /**
   * Release the per-PR lock — only if our token still owns it. A no-op if
   * the lock expired and another holder took over (token-guarded DELETE,
   * the SQL twin of the old compare-and-delete Lua script).
   */
  async releaseLock(repo: string, pr: number, token: string): Promise<void> {
    await this.db
      .delete(gateLocks)
      .where(
        and(
          eq(gateLocks.repo, repo),
          eq(gateLocks.pr, pr),
          eq(gateLocks.token, token),
        ),
      );
  }

  /**
   * Atomically claim a {repo, pr, headSha} as a unique gate run.
   * Returns the existing runId if already claimed, null if we won the race.
   * Designed to be called *inside* `acquireLock`, but the conflict guard is
   * defense-in-depth in case the lock expired mid-critical-section.
   * An expired claim is re-claimable (Redis SET NX EX semantics).
   */
  async claimRun(
    repo: string,
    pr: number,
    headSha: string,
    runId: string,
  ): Promise<string | null> {
    const rows = await this.db
      .insert(gateDedupe)
      .values({ repo, pr, headSha, runId, expiresAt: TTL })
      .onConflictDoUpdate({
        target: [gateDedupe.repo, gateDedupe.pr, gateDedupe.headSha],
        set: {
          runId: sql`excluded.run_id`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${gateDedupe.expiresAt} < now()`,
      })
      .returning({ runId: gateDedupe.runId });
    if (rows.length > 0) return null; // inserted fresh or reclaimed expired
    return this.getDedupe(repo, pr, headSha);
  }

  async getDedupe(
    repo: string,
    pr: number,
    headSha: string,
  ): Promise<string | null> {
    const rows = await this.db
      .select({ runId: gateDedupe.runId })
      .from(gateDedupe)
      .where(
        and(
          eq(gateDedupe.repo, repo),
          eq(gateDedupe.pr, pr),
          eq(gateDedupe.headSha, headSha),
          sql`${gateDedupe.expiresAt} > now()`,
        ),
      );
    return rows[0]?.runId ?? null;
  }

  async getCurrent(repo: string, pr: number): Promise<CurrentGateRun | null> {
    const rows = await this.db
      .select({
        runId: gateCurrent.runId,
        headSha: gateCurrent.headSha,
        gateStatusRefs: gateCurrent.gateStatusRefs,
      })
      .from(gateCurrent)
      .where(
        and(
          eq(gateCurrent.repo, repo),
          eq(gateCurrent.pr, pr),
          sql`${gateCurrent.expiresAt} > now()`,
        ),
      );
    return rows[0] ?? null;
  }

  async setCurrent(
    repo: string,
    pr: number,
    value: CurrentGateRun,
  ): Promise<void> {
    const checkRunIds = checkRunIdsForLegacyColumn(value.gateStatusRefs);
    await this.db
      .insert(gateCurrent)
      .values({
        repo,
        pr,
        runId: value.runId,
        headSha: value.headSha,
        checkRunIds,
        gateStatusRefs: value.gateStatusRefs,
        expiresAt: TTL,
      })
      .onConflictDoUpdate({
        target: [gateCurrent.repo, gateCurrent.pr],
        set: {
          runId: value.runId,
          headSha: value.headSha,
          checkRunIds,
          gateStatusRefs: value.gateStatusRefs,
          expiresAt: TTL,
        },
      });
  }

  /**
   * Atomically append gate status refs to the current pointer, but only if the
   * pointer's headSha still matches `expectedHeadSha`. Returns true if the
   * append happened, false if the row is missing, expired, or superseded by
   * a force-push. Single conditional UPDATE = the old SHA-guarded Lua
   * append; not touching expires_at = KEEPTTL.
   */
  async appendGateStatusRefsForSha(
    repo: string,
    pr: number,
    expectedHeadSha: string,
    refs: GateStatusRef[],
  ): Promise<boolean> {
    if (refs.length === 0) return true;
    const checkRunIds = checkRunIdsForLegacyColumn(refs);
    const refsJson = JSON.stringify(refs);
    const checkRunIdsUpdate =
      checkRunIds.length > 0
        ? {
            checkRunIds: sql`${gateCurrent.checkRunIds} || ${sql.raw(
              `'{${checkRunIds.join(",")}}'::bigint[]`,
            )}`,
          }
        : {};
    const rows = await this.db
      .update(gateCurrent)
      .set({
        gateStatusRefs: sql`${gateCurrent.gateStatusRefs} || cast(${refsJson} as jsonb)`,
        ...checkRunIdsUpdate,
      })
      .where(
        and(
          eq(gateCurrent.repo, repo),
          eq(gateCurrent.pr, pr),
          eq(gateCurrent.headSha, expectedHeadSha),
          sql`${gateCurrent.expiresAt} > now()`,
        ),
      )
      .returning({ pr: gateCurrent.pr });
    return rows.length > 0;
  }

  /**
   * Atomically set the `runId` field of the current pointer, but only if
   * the pointer's headSha still matches `expectedHeadSha`. Returns true if
   * the update happened, false if the row is missing or superseded.
   *
   * Used by the webhook to fill in the real runId AFTER `start()` returns,
   * without stomping `gateStatusRefs` that the workflow may have already
   * appended — a column-targeted UPDATE only touches run_id, so that
   * property now holds structurally.
   */
  async updateRunIdIfHeadSha(
    repo: string,
    pr: number,
    expectedHeadSha: string,
    runId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(gateCurrent)
      .set({ runId })
      .where(
        and(
          eq(gateCurrent.repo, repo),
          eq(gateCurrent.pr, pr),
          eq(gateCurrent.headSha, expectedHeadSha),
          sql`${gateCurrent.expiresAt} > now()`,
        ),
      )
      .returning({ pr: gateCurrent.pr });
    return rows.length > 0;
  }

  async clearCurrent(repo: string, pr: number): Promise<void> {
    await this.db
      .delete(gateCurrent)
      .where(and(eq(gateCurrent.repo, repo), eq(gateCurrent.pr, pr)));
  }

  /**
   * Physically delete expired rows. Reads already treat them as absent;
   * this is housekeeping so tables don't grow forever. Called from the
   * poll cron (src/routes/cron/poll.get.ts), best-effort.
   */
  async purgeExpired(): Promise<void> {
    await this.db.delete(gateLocks).where(sql`${gateLocks.expiresAt} < now()`);
    await this.db
      .delete(gateDedupe)
      .where(sql`${gateDedupe.expiresAt} < now()`);
    await this.db
      .delete(gateCurrent)
      .where(sql`${gateCurrent.expiresAt} < now()`);
  }
}
