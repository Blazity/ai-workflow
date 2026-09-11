import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { prAutofixAttempts } from "../schema.js";

export async function consumePrAutofixAttempt(db: Db, input: { definitionId: string; nodeId: string; provider: string; repoPath: string; prNumber: number; now: Date }): Promise<number> {
  const rows = await db.insert(prAutofixAttempts).values({ ...input, attempts: 1, updatedAt: input.now })
    .onConflictDoUpdate({ target: [prAutofixAttempts.definitionId, prAutofixAttempts.nodeId, prAutofixAttempts.provider, prAutofixAttempts.repoPath, prAutofixAttempts.prNumber], set: { attempts: sql`${prAutofixAttempts.attempts} + 1`, updatedAt: input.now } })
    .returning({ attempts: prAutofixAttempts.attempts });
  return rows[0]?.attempts ?? 1;
}

export function consumeConnectedPrAutofixAttempt(input: Parameters<typeof consumePrAutofixAttempt>[1]) { return consumePrAutofixAttempt(getDb(), input); }

export async function refundPrAutofixAttempt(db: Db, input: { definitionId: string; nodeId: string; provider: string; repoPath: string; prNumber: number }): Promise<void> {
  await db.update(prAutofixAttempts).set({ attempts: sql`${prAutofixAttempts.attempts} - 1` })
    .where(and(eq(prAutofixAttempts.definitionId, input.definitionId), eq(prAutofixAttempts.nodeId, input.nodeId), eq(prAutofixAttempts.provider, input.provider), eq(prAutofixAttempts.repoPath, input.repoPath), eq(prAutofixAttempts.prNumber, input.prNumber), sql`${prAutofixAttempts.attempts} > 0`));
}

export function refundConnectedPrAutofixAttempt(input: Parameters<typeof refundPrAutofixAttempt>[1]) { return refundPrAutofixAttempt(getDb(), input); }
