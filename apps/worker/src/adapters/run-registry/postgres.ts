import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  activeRunSandboxes,
  activeRuns,
  failedTickets,
  threadParents,
} from "../../db/schema.js";
import type {
  ActiveRunEntry,
  FailedTicketMeta,
  RunRegistryAdapter,
  RunReservation,
  ThreadStore,
} from "./types.js";

export class PostgresRunRegistry implements RunRegistryAdapter, ThreadStore {
  constructor(private db: Db) {}

  async reserve(reservation: RunReservation): Promise<boolean> {
    const rows = await this.db
      .insert(activeRuns)
      .values({
        subjectKey: reservation.subjectKey,
        ticketKey: reservation.ticketKey,
        ownerToken: reservation.ownerToken,
        runKind: reservation.kind,
        state: "reserved",
      })
      .onConflictDoNothing({ target: activeRuns.subjectKey })
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async bindRun(subjectKey: string, ownerToken: string, runId: string): Promise<boolean> {
    const rows = await this.db
      .update(activeRuns)
      .set({ runId, state: "bound", updatedAt: sql`now()` })
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.state, "reserved"),
          isNull(activeRuns.runId),
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async handoff(
    subjectKey: string,
    currentOwnerToken: string,
    nextOwnerToken: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(activeRuns)
      .set({ ownerToken: nextOwnerToken, updatedAt: sql`now()` })
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, currentOwnerToken),
          eq(activeRuns.state, "reserved"),
          isNull(activeRuns.runId),
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async get(subjectKey: string): Promise<ActiveRunEntry | null> {
    const rows = await this.db
      .select()
      .from(activeRuns)
      .where(eq(activeRuns.subjectKey, subjectKey));
    const row = rows[0];
    return row ? toEntry(row) : null;
  }

  async releaseReservation(subjectKey: string, ownerToken: string): Promise<boolean> {
    const rows = await this.db
      .delete(activeRuns)
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.state, "reserved"),
          isNull(activeRuns.runId),
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async release(subjectKey: string, ownerToken: string, runId: string): Promise<boolean> {
    const rows = await this.db
      .delete(activeRuns)
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.runId, runId),
          eq(activeRuns.state, "bound"),
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async listAll(): Promise<ActiveRunEntry[]> {
    return (await this.db.select().from(activeRuns)).map(toEntry);
  }

  async registerSandbox(
    subjectKey: string,
    ownerToken: string,
    sandboxId: string,
  ): Promise<void> {
    const held = await this.db
      .select({ subjectKey: activeRuns.subjectKey })
      .from(activeRuns)
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.state, "bound"),
        ),
      );
    if (held.length === 0) {
      throw new Error(`registerSandbox: owner does not hold active run for ${subjectKey}`);
    }

    await this.db
      .insert(activeRunSandboxes)
      .values({ subjectKey, ownerToken, sandboxId })
      .onConflictDoNothing();
  }

  async listSandboxes(subjectKey: string, ownerToken: string): Promise<string[]> {
    const rows = await this.db
      .select({ sandboxId: activeRunSandboxes.sandboxId })
      .from(activeRunSandboxes)
      .where(
        and(
          eq(activeRunSandboxes.subjectKey, subjectKey),
          eq(activeRunSandboxes.ownerToken, ownerToken),
        ),
      )
      .orderBy(activeRunSandboxes.sandboxId);
    return rows.map(({ sandboxId }) => sandboxId);
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

  async listAllFailed(): Promise<Array<{ ticketKey: string; meta: FailedTicketMeta }>> {
    const rows = await this.db.select().from(failedTickets);
    return rows.map(({ ticketKey, runId, error, failedAt }) => ({
      ticketKey,
      meta: { runId, error, failedAt },
    }));
  }

  async clearFailedMark(ticketKey: string): Promise<void> {
    await this.db.delete(failedTickets).where(eq(failedTickets.ticketKey, ticketKey));
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
    await this.db.delete(threadParents).where(eq(threadParents.ticketKey, ticketKey));
  }
}

function toEntry(row: typeof activeRuns.$inferSelect): ActiveRunEntry {
  return {
    subjectKey: row.subjectKey,
    ticketKey: row.ticketKey,
    ownerToken: row.ownerToken,
    runId: row.runId,
    state: row.state as ActiveRunEntry["state"],
    kind: row.runKind as ActiveRunEntry["kind"],
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
