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

  async handoffBoundRun(
    subjectKey: string,
    currentOwnerToken: string,
    currentRunId: string,
    nextOwnerToken: string,
  ): Promise<boolean> {
    const held = await this.db
      .select({ subjectKey: activeRuns.subjectKey })
      .from(activeRuns)
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, currentOwnerToken),
          eq(activeRuns.runId, currentRunId),
          eq(activeRuns.state, "bound"),
        ),
      );
    if (held.length === 0) return false;

    // The predecessor has exited before an answer can be published. Clear its
    // stopped/snapshotted children first so changing owner cannot violate the
    // composite FK or accidentally transfer stale sandboxes to the successor.
    await this.db
      .delete(activeRunSandboxes)
      .where(
        and(
          eq(activeRunSandboxes.subjectKey, subjectKey),
          eq(activeRunSandboxes.ownerToken, currentOwnerToken),
        ),
      );

    const rows = await this.db
      .update(activeRuns)
      .set({
        ownerToken: nextOwnerToken,
        runId: null,
        state: "reserved",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, currentOwnerToken),
          eq(activeRuns.runId, currentRunId),
          eq(activeRuns.state, "bound"),
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

  async beginCancellation(
    subjectKey: string,
    ownerToken: string,
    runId: string | null,
  ): Promise<boolean> {
    const runIdentity = runId === null
      ? sql`${activeRuns.runId} is null`
      : eq(activeRuns.runId, runId);
    const rows = await this.db
      .update(activeRuns)
      .set({ state: "cancelling", updatedAt: sql`now()` })
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          runIdentity,
          sql`${activeRuns.state} in ('reserved', 'bound', 'cancelling')`,
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async releaseCancellation(
    subjectKey: string,
    ownerToken: string,
    runId: string | null,
  ): Promise<boolean> {
    const runIdentity = runId === null
      ? sql`${activeRuns.runId} is null`
      : eq(activeRuns.runId, runId);
    const rows = await this.db
      .delete(activeRuns)
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.state, "cancelling"),
          runIdentity,
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
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
    // Lock the owner and register its child in one statement. Cancellation's
    // state update must therefore order either before this statement (which
    // rejects the registration) or after it (so its later enumeration sees
    // the child). There is no successful registration between close and list.
    const result = await this.db.execute(sql`
      with exact_owner as materialized (
        select subject_key, owner_token
        from active_runs
        where subject_key = ${subjectKey}
          and owner_token = ${ownerToken}
          and state = 'bound'
        for update
      ), registered as (
        insert into active_run_sandboxes (subject_key, owner_token, sandbox_id)
        select subject_key, owner_token, ${sandboxId}
        from exact_owner
        on conflict do nothing
        returning sandbox_id
      )
      select count(*)::integer as owner_count from exact_owner
    `);
    const ownerCount = Number(
      ((result as { rows?: Array<{ owner_count: number | string }> }).rows ?? [])[0]
        ?.owner_count ?? 0,
    );
    if (ownerCount === 0) {
      throw new Error(`registerSandbox: owner does not hold active run for ${subjectKey}`);
    }
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

  async unregisterSandbox(
    subjectKey: string,
    ownerToken: string,
    sandboxId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .delete(activeRunSandboxes)
      .where(
        and(
          eq(activeRunSandboxes.subjectKey, subjectKey),
          eq(activeRunSandboxes.ownerToken, ownerToken),
          eq(activeRunSandboxes.sandboxId, sandboxId),
        ),
      )
      .returning({ sandboxId: activeRunSandboxes.sandboxId });
    return rows.length > 0;
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
