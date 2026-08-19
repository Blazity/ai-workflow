import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { prAutofixAttempts } from "../db/schema.js";

/** One pull request under one trigger node. */
export interface PrAutofixCapKey {
  definitionId: string;
  nodeId: string;
  provider: string;
  repoPath: string;
  prNumber: number;
}

export interface PrAutofixCapDecision {
  max: number;
  allowed: boolean;
  /** Auto-fix dispatches counted for this pull request so far, this one included. */
  attempts: number;
}

/**
 * The single enforcement path for the auto-fix loop: count this dispatch against
 * its pull request and answer whether the fix run may start.
 *
 * The tally is a lifetime one and nothing resets it. A reset on a head the
 * workflow had not published was tried and removed, because it was unreachable
 * under scope "workflow_owned" (the published sha filters the ownership lookup,
 * so a foreign head never resolves as owned and never reaches this guard) and
 * unbounded under scope "any" (nothing is ever published there, so every head
 * looked foreign and every event started the counter over). Counting calls
 * rather than heads also covers GitLab, whose pipeline events carry no head sha
 * and whose retries would otherwise be free forever.
 *
 * Returns null for an unconfigured cap, having written NOTHING: uncapped must
 * stay indistinguishable from before the feature existed.
 *
 * max is authored as 1..10 (maxFixAttemptsPerPr in workflow-definition/schema),
 * so a non-positive max cannot arrive from a deployed graph. It refuses on the
 * spot rather than writing a row first, since spending a budget of zero is a
 * contradiction and the row would still be there for a later, valid max.
 *
 * Callers must invoke this LAST among their guards, immediately before the
 * start: a candidate refused by a duplicate, ownership or capacity guard must
 * not spend the budget, or a check that keeps re-reporting would hold the pull
 * request above its cap without a single fix ever having been attempted.
 *
 * The counter is deliberately NOT clamped at the cap. attempts === max + 1 is
 * the one call that crosses into exhaustion, which is what lets a caller notify
 * exactly once; a clamped counter would report that crossing on every later
 * call, and a counter that stopped could walk back under the cap.
 *
 * Retention: one row per pull request per node, written once and never swept.
 */
export async function enforcePrAutofixCap(
  db: Db,
  key: PrAutofixCapKey,
  max: number | undefined,
  now: Date,
): Promise<PrAutofixCapDecision | null> {
  if (max === undefined) return null;
  if (max <= 0) return { max, allowed: false, attempts: 0 };

  // One INSERT ... ON CONFLICT DO UPDATE: concurrent deliveries for a single
  // pull request serialize on the row instead of on a read-then-write, so none
  // of them can lose an increment or skip the crossing into exhaustion.
  const rows = await db
    .insert(prAutofixAttempts)
    .values({
      definitionId: key.definitionId,
      nodeId: key.nodeId,
      provider: key.provider,
      repoPath: key.repoPath,
      prNumber: key.prNumber,
      attempts: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        prAutofixAttempts.definitionId,
        prAutofixAttempts.nodeId,
        prAutofixAttempts.provider,
        prAutofixAttempts.repoPath,
        prAutofixAttempts.prNumber,
      ],
      set: {
        attempts: sql`${prAutofixAttempts.attempts} + 1`,
        updatedAt: now,
      },
    })
    .returning({ attempts: prAutofixAttempts.attempts });

  const attempts = rows[0]?.attempts ?? 1;
  return { max, allowed: attempts <= max, attempts };
}
