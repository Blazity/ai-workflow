import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { ActiveRunOwnerError } from "../../lib/run-control-errors.js";
import {
  activeRunSandboxes,
  activeRuns,
  clarificationRequests,
  failedTickets,
  threadParents,
} from "../../db/schema.js";
import {
  RESERVATION_BIND_GRACE_MS,
  type ActiveRunEntry,
  type FailedTicketMeta,
  type FailedTicketOwner,
  type RunRegistryAdapter,
  type RunReservation,
  type TicketCancellationReleaseGuard,
  type ThreadStore,
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
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, ownerToken, null),
          sql`${activeRuns.updatedAt} >= now() - (${RESERVATION_BIND_GRACE_MS} * interval '1 millisecond')`,
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async beginParking(
    subjectKey: string,
    ownerToken: string,
    runId: string,
  ): Promise<boolean> {
    // registerSandbox locks this same owner row before inserting. Whichever
    // statement wins first therefore establishes a complete boundary: every
    // earlier registration is enumerable, and every later one is rejected.
    const rows = await this.db
      .update(activeRuns)
      .set({ state: "parking", updatedAt: sql`now()` })
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.runId, runId),
          sql`${activeRuns.state} in ('bound', 'parking')`,
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async finishParking(
    subjectKey: string,
    ownerToken: string,
    runId: string,
  ): Promise<boolean> {
    // Only a terminal-confirmed caller may cross this boundary. Clear the exact
    // drained registrations and publish `parked` in one database statement so
    // handoff can never observe a predecessor with residual child ownership.
    const result = await this.db.execute(sql`
      with exact_owner as materialized (
        select subject_key, owner_token
        from active_runs
        where subject_key = ${subjectKey}
          and owner_token = ${ownerToken}
          and run_id = ${runId}
          and state = 'parking'
        for update
      ), deleted_children as (
        delete from active_run_sandboxes children
        using exact_owner owner
        where children.subject_key = owner.subject_key
          and children.owner_token = owner.owner_token
        returning children.sandbox_id
      ), deletion_barrier as materialized (
        select count(*)::integer as deleted_count from deleted_children
      ), parked as (
        update active_runs ar
        set state = 'parked', updated_at = now()
        from exact_owner owner, deletion_barrier
        where ar.subject_key = owner.subject_key
          and ar.owner_token = owner.owner_token
          and ar.run_id = ${runId}
          and ar.state = 'parking'
        returning ar.subject_key
      )
      select count(*)::integer as parked_count from parked
    `);
    const parkedCount = Number(
      ((result as { rows?: Array<{ parked_count: number | string }> }).rows ?? [])[0]
        ?.parked_count ?? 0,
    );
    return parkedCount === 1;
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
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, currentOwnerToken, null),
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
          eq(activeRuns.state, "parked"),
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, currentOwnerToken, currentRunId),
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length === 1;
  }

  async restoreParkedRun(
    subjectKey: string,
    successorOwnerToken: string,
    predecessorOwnerToken: string,
    predecessorRunId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(activeRuns)
      .set({
        ownerToken: predecessorOwnerToken,
        runId: predecessorRunId,
        state: "parked",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, successorOwnerToken),
          eq(activeRuns.state, "reserved"),
          isNull(activeRuns.runId),
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, successorOwnerToken, null),
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
    const result = await this.db.execute(sql`
      SELECT "begin_active_run_cancellation"(
        ${subjectKey},
        ${ownerToken},
        ${runId}
      ) AS began
    `);
    const began = ((result as { rows?: Array<{ began: boolean }> }).rows ?? [])[0]?.began;
    return began === true;
  }

  async releaseCancellation(
    subjectKey: string,
    ownerToken: string,
    runId: string | null,
    ticketGuard?: TicketCancellationReleaseGuard,
  ): Promise<boolean> {
    const runIdentity =
      runId === null ? sql`run_id IS NULL` : sql`run_id = ${runId}`;
    const latestFenceGuard = !ticketGuard
      ? sql`true`
      : ticketGuard.latestFenceId === null
        ? sql`NOT EXISTS (
            SELECT 1
            FROM ticket_cancellation_fences AS fence
            WHERE fence.subject_key = ${subjectKey}
              AND fence.owner_token = ${ownerToken}
              AND ${runId === null ? sql`fence.run_id IS NULL` : sql`fence.run_id = ${runId}`}
          )`
        : sql`(
            SELECT fence.id
            FROM ticket_cancellation_fences AS fence
            WHERE fence.subject_key = ${subjectKey}
              AND fence.owner_token = ${ownerToken}
              AND ${runId === null ? sql`fence.run_id IS NULL` : sql`fence.run_id = ${runId}`}
            ORDER BY fence.occurred_at DESC, fence.id DESC
            LIMIT 1
          ) = ${ticketGuard.latestFenceId}`;
    const providerDrainGuard = sql`NOT EXISTS (
          SELECT 1
          FROM ticket_transition_intents AS intent
          WHERE intent.subject_key = ${subjectKey}
            AND intent.owner_token = ${ownerToken}
            AND ${runId === null ? sql`intent.run_id IS NULL` : sql`intent.run_id = ${runId}`}
            AND intent.provider_started_at IS NOT NULL
            AND intent.provider_finished_at IS NULL
        ) AND NOT EXISTS (
          SELECT 1
          FROM ticket_label_mutation_intents AS intent
          WHERE intent.subject_key = ${subjectKey}
            AND intent.owner_token = ${ownerToken}
            AND ${runId === null ? sql`intent.run_id IS NULL` : sql`intent.run_id = ${runId}`}
            AND intent.provider_started_at IS NOT NULL
            AND intent.provider_finished_at IS NULL
        )`;
    const mutationVersionGuard = !ticketGuard
      ? sql`true`
      : sql`ticket_mutation_version = ${ticketGuard.mutationVersion}`;
    if (ticketGuard) {
      // Persist the exact reconciled mutation version before delete. This is a
      // separate durable statement on purpose: PostgreSQL must not UPDATE and
      // DELETE the same row in one data-modifying CTE. A crash between the two
      // statements is safe because every later fence/provider start changes
      // the version and makes the acknowledgement stale.
      const acknowledgement = await this.db.execute(sql`
        WITH acknowledged AS (
          UPDATE active_runs AS active
          SET
            ticket_cancellation_reconciled_version = active.ticket_mutation_version,
            updated_at = now()
          WHERE active.subject_key = ${subjectKey}
            AND active.owner_token = ${ownerToken}
            AND active.state = 'cancelling'
            AND ${runId === null ? sql`active.run_id IS NULL` : sql`active.run_id = ${runId}`}
            AND active.ticket_provider_calls_in_flight = 0
            AND active.ticket_cancellation_reconciled_version >= -1
            AND ${mutationVersionGuard}
            AND ${latestFenceGuard}
            AND ${providerDrainGuard}
          RETURNING active.subject_key
        )
        SELECT count(*)::integer AS acknowledged_count FROM acknowledged
      `);
      const acknowledgedCount = Number(
        ((acknowledgement as {
          rows?: Array<{ acknowledged_count: number | string }>;
        }).rows ?? [])[0]?.acknowledged_count ?? 0,
      );
      if (acknowledgedCount !== 1) return false;
    }

    const cancellationProtocolGuard = ticketGuard
      ? sql`ticket_cancellation_reconciled_version = ticket_mutation_version`
      : sql`ticket_key IS NULL`;
    const result = await this.db.execute(sql`
      WITH exact_owner AS MATERIALIZED (
        SELECT subject_key
        FROM active_runs
        WHERE subject_key = ${subjectKey}
          AND owner_token = ${ownerToken}
          AND state = 'cancelling'
          AND ${runIdentity}
          AND ticket_provider_calls_in_flight = 0
          AND ${mutationVersionGuard}
          AND ${cancellationProtocolGuard}
        FOR UPDATE
      ), released AS (
        DELETE FROM active_runs AS active
        USING exact_owner AS owner
        WHERE active.subject_key = owner.subject_key
          AND active.owner_token = ${ownerToken}
          AND active.state = 'cancelling'
          AND ${runId === null ? sql`active.run_id IS NULL` : sql`active.run_id = ${runId}`}
          AND ${latestFenceGuard}
          AND ${providerDrainGuard}
        RETURNING active.subject_key
      )
      SELECT count(*)::integer AS released_count FROM released
    `);
    const releasedCount = Number(
      ((result as { rows?: Array<{ released_count: number | string }> }).rows ?? [])[0]
        ?.released_count ?? 0,
    );
    return releasedCount === 1;
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
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, ownerToken, null),
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async releaseExpiredReservation(
    subjectKey: string,
    ownerToken: string,
  ): Promise<boolean> {
    const rows = await this.db
      .delete(activeRuns)
      .where(
        and(
          eq(activeRuns.subjectKey, subjectKey),
          eq(activeRuns.ownerToken, ownerToken),
          eq(activeRuns.state, "reserved"),
          isNull(activeRuns.runId),
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, ownerToken, null),
          sql`${activeRuns.updatedAt} < now() - (${RESERVATION_BIND_GRACE_MS} * interval '1 millisecond')`,
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
          eq(activeRuns.ticketProviderCallsInFlight, 0),
          noStartedTicketProviderCall(subjectKey, ownerToken, runId),
          noRetainedClarificationCheckpoint(subjectKey, ownerToken, runId),
          sql`${activeRuns.state} in ('bound', 'parking', 'parked')`,
        ),
      )
      .returning({ subjectKey: activeRuns.subjectKey });
    return rows.length > 0;
  }

  async listAll(): Promise<ActiveRunEntry[]> {
    return (await this.db.select().from(activeRuns)).map(toEntry);
  }

  async listCapacityConsumers(): Promise<ActiveRunEntry[]> {
    const rows = await this.db
      .select()
      .from(activeRuns)
      .where(
        and(
          sql`(
            ${activeRuns.state} <> 'reserved'
            or ${activeRuns.updatedAt} >= now() - (${RESERVATION_BIND_GRACE_MS} * interval '1 millisecond')
          )`,
          sql`not (
            ${activeRuns.state} = 'parked'
            and exists (
              select 1
              from ${clarificationRequests}
              where ${clarificationRequests.subjectKey} = ${activeRuns.subjectKey}
                and ${clarificationRequests.ownerToken} = ${activeRuns.ownerToken}
                and ${clarificationRequests.runId} = ${activeRuns.runId}
                and ${clarificationRequests.status} in ('pending', 'answered')
                and ${clarificationRequests.checkpointState} = 'ready'
                and ${clarificationRequests.publishedAt} is not null
                and ${clarificationRequests.expiresAt} > now()
                and (
                  (
                    ${clarificationRequests.workspaceManifest} is null
                    and ${clarificationRequests.snapshotId} is null
                  )
                  or (
                    ${clarificationRequests.workspaceManifest} is not null
                    and ${clarificationRequests.snapshotId} is not null
                    and ${clarificationRequests.sourceSandboxId} is not null
                    and ${clarificationRequests.snapshotExpiresAt} > now()
                    and ${clarificationRequests.cleanupState} = 'retained'
                  )
                )
                and (
                  ${clarificationRequests.status} = 'pending'
                  or (
                    ${clarificationRequests.successorOwnerToken} is not null
                    and ${clarificationRequests.dispatchedRunId} is null
                  )
                )
            )
          )`,
        ),
      );
    return rows.map(toEntry);
  }

  async registerSandbox(
    subjectKey: string,
    ownerToken: string,
    sandboxId: string,
    runId?: string,
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
          ${runId === undefined ? sql`` : sql`and run_id = ${runId}`}
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
      throw new ActiveRunOwnerError(
        `registerSandbox: owner does not hold active run for ${subjectKey}`,
      );
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

  async markFailed(
    ticketKey: string,
    meta: FailedTicketMeta,
    owner: FailedTicketOwner,
  ): Promise<void> {
    await this.db.execute(sql`
      SELECT "mark_failed_ticket_if_active"(
        ${ticketKey},
        ${meta.runId},
        ${meta.error},
        ${meta.failedAt},
        ${owner.subjectKey},
        ${owner.ownerToken},
        ${owner.runId}
      )
    `);
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

function noStartedTicketProviderCall(
  subjectKey: string,
  ownerToken: string,
  runId: string | null,
) {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ticket_transition_intents AS intent
    WHERE intent.subject_key = ${subjectKey}
      AND intent.owner_token = ${ownerToken}
      AND ${runId === null ? sql`intent.run_id IS NULL` : sql`intent.run_id = ${runId}`}
      AND intent.provider_started_at IS NOT NULL
      AND intent.provider_finished_at IS NULL
  ) AND NOT EXISTS (
    SELECT 1
    FROM ticket_label_mutation_intents AS intent
    WHERE intent.subject_key = ${subjectKey}
      AND intent.owner_token = ${ownerToken}
      AND ${runId === null ? sql`intent.run_id IS NULL` : sql`intent.run_id = ${runId}`}
      AND intent.provider_started_at IS NOT NULL
      AND intent.provider_finished_at IS NULL
  )`;
}

function noRetainedClarificationCheckpoint(
  subjectKey: string,
  ownerToken: string,
  runId: string,
) {
  return sql`NOT EXISTS (
    SELECT 1
    FROM clarification_requests AS checkpoint
    WHERE checkpoint.subject_key = ${subjectKey}
      AND checkpoint.owner_token = ${ownerToken}
      AND checkpoint.run_id = ${runId}
      AND (
        (checkpoint.status = 'pending' AND checkpoint.checkpoint_state = 'ready')
        OR (checkpoint.status = 'answered' AND checkpoint.checkpoint_state = 'ready')
        OR (
          checkpoint.status = 'superseded'
          AND checkpoint.checkpoint_state IN (
            'provider_parking',
            'provider_parking_active',
            'ready'
          )
          AND checkpoint.published_at IS NULL
        )
      )
  )`;
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
