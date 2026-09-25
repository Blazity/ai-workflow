import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { prAutofixAttempts } from "../schema.js";

type PrAutofixAttemptKey = { definitionId: string; nodeId: string; provider: string; repoPath: string; prNumber: number };

/** One pull request, one budget: the path is stored and matched cased down
 *  (`repositoryCatalogKey`'s rule, @shared/contracts), because a provider that
 *  renames `Acme/API` to `acme/api`, or a path typed by a person, still names
 *  the same pull request. Rows from before were merged by migration
 *  0073_pr_subject_key_normalize. */
function keyed<T extends PrAutofixAttemptKey>(input: T): T {
  return { ...input, repoPath: input.repoPath.toLowerCase() };
}

export async function consumePrAutofixAttempt(db: Db, input: PrAutofixAttemptKey & { now: Date }): Promise<number> {
  const rows = await db.insert(prAutofixAttempts).values({ ...keyed(input), attempts: 1, updatedAt: input.now })
    .onConflictDoUpdate({ target: [prAutofixAttempts.definitionId, prAutofixAttempts.nodeId, prAutofixAttempts.provider, prAutofixAttempts.repoPath, prAutofixAttempts.prNumber], set: { attempts: sql`${prAutofixAttempts.attempts} + 1`, updatedAt: input.now } })
    .returning({ attempts: prAutofixAttempts.attempts });
  return rows[0]?.attempts ?? 1;
}

export function consumeConnectedPrAutofixAttempt(input: Parameters<typeof consumePrAutofixAttempt>[1]) { return consumePrAutofixAttempt(getDb(), input); }

export async function refundPrAutofixAttempt(db: Db, input: PrAutofixAttemptKey): Promise<void> {
  const key = keyed(input);
  await db.update(prAutofixAttempts).set({ attempts: sql`${prAutofixAttempts.attempts} - 1` })
    .where(and(eq(prAutofixAttempts.definitionId, key.definitionId), eq(prAutofixAttempts.nodeId, key.nodeId), eq(prAutofixAttempts.provider, key.provider), eq(prAutofixAttempts.repoPath, key.repoPath), eq(prAutofixAttempts.prNumber, key.prNumber), sql`${prAutofixAttempts.attempts} > 0`));
}

export function refundConnectedPrAutofixAttempt(input: Parameters<typeof refundPrAutofixAttempt>[1]) { return refundPrAutofixAttempt(getDb(), input); }
