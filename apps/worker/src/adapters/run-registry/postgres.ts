import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  activeRuns,
  failedTickets,
  threadParents,
} from "../../db/schema.js";
import type {
  FailedTicketMeta,
  RunRegistryAdapter,
  ThreadStore,
} from "./types.js";

export class PostgresRunRegistry implements RunRegistryAdapter, ThreadStore {
  constructor(private db: Db) {}

  async claim(ticketKey: string, runId: string): Promise<boolean> {
    // INSERT ... ON CONFLICT DO NOTHING is the HSETNX equivalent: exactly
    // one concurrent claimer gets a row back. created_at defaults to now(),
    // which doubles as the entry timestamp for reconcile's grace period.
    const rows = await this.db
      .insert(activeRuns)
      .values({ ticketKey, runId })
      .onConflictDoNothing({ target: activeRuns.ticketKey })
      .returning({ ticketKey: activeRuns.ticketKey });
    return rows.length > 0;
  }

  async register(ticketKey: string, runId: string): Promise<void> {
    // Refresh created_at: register() is called both on the claim → runId
    // swap and by external seeders, so it's the authoritative write point
    // for the orphan grace period. sandbox_id is intentionally untouched.
    await this.db
      .insert(activeRuns)
      .values({ ticketKey, runId })
      .onConflictDoUpdate({
        target: activeRuns.ticketKey,
        set: { runId, createdAt: sql`now()` },
      });
  }

  async getRunId(ticketKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ runId: activeRuns.runId })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return rows[0]?.runId ?? null;
  }

  async unregister(ticketKey: string): Promise<void> {
    // One row holds run, sandbox, and timestamp — deleting it fully
    // detaches the ticket. Thread parents live in their own table and
    // survive (see ThreadStore docs in types.ts).
    await this.db.delete(activeRuns).where(eq(activeRuns.ticketKey, ticketKey));
  }

  async listAll(): Promise<Array<{ ticketKey: string; runId: string }>> {
    return this.db
      .select({ ticketKey: activeRuns.ticketKey, runId: activeRuns.runId })
      .from(activeRuns);
  }

  async registerSandbox(ticketKey: string, sandboxId: string): Promise<void> {
    // Sandboxes are only registered after claim()/register(), so the row
    // exists; a bare UPDATE keeps run_id NOT NULL without an upsert dance.
    await this.db
      .update(activeRuns)
      .set({ sandboxId })
      .where(eq(activeRuns.ticketKey, ticketKey));
  }

  async getSandboxId(ticketKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ sandboxId: activeRuns.sandboxId })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return rows[0]?.sandboxId ?? null;
  }

  async getEntryCreatedAt(ticketKey: string): Promise<number | null> {
    const rows = await this.db
      .select({ createdAt: activeRuns.createdAt })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return rows[0]?.createdAt?.getTime() ?? null;
  }

  async markFailed(ticketKey: string, meta: FailedTicketMeta): Promise<void> {
    await this.db
      .insert(failedTickets)
      .values({ ticketKey, ...meta })
      .onConflictDoUpdate({
        target: failedTickets.ticketKey,
        set: { runId: meta.runId, error: meta.error, failedAt: meta.failedAt },
      });
  }

  async isTicketFailed(ticketKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ ticketKey: failedTickets.ticketKey })
      .from(failedTickets)
      .where(eq(failedTickets.ticketKey, ticketKey));
    return rows.length > 0;
  }

  async listAllFailed(): Promise<
    Array<{ ticketKey: string; meta: FailedTicketMeta }>
  > {
    const rows = await this.db.select().from(failedTickets);
    return rows.map(({ ticketKey, runId, error, failedAt }) => ({
      ticketKey,
      meta: { runId, error, failedAt },
    }));
  }

  async clearFailedMark(ticketKey: string): Promise<void> {
    await this.db
      .delete(failedTickets)
      .where(eq(failedTickets.ticketKey, ticketKey));
  }

  async getParent(ticketKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ messageId: threadParents.messageId })
      .from(threadParents)
      .where(eq(threadParents.ticketKey, ticketKey));
    return rows[0]?.messageId ?? null;
  }

  async setParent(ticketKey: string, messageId: string): Promise<void> {
    await this.db
      .insert(threadParents)
      .values({ ticketKey, messageId })
      .onConflictDoUpdate({
        target: threadParents.ticketKey,
        set: { messageId },
      });
  }

  async clearParent(ticketKey: string): Promise<void> {
    await this.db
      .delete(threadParents)
      .where(eq(threadParents.ticketKey, ticketKey));
  }
}
