import { neon } from "@neondatabase/serverless";
import { e2eEnv } from "../env.js";

/**
 * Direct DB access for e2e seeding/cleanup. Must point at the SAME Neon
 * branch as the deployment under test (vercel env pull for the matching
 * environment).
 */
const sql = neon(e2eEnv.DATABASE_URL);

export async function getRunId(ticketKey: string): Promise<string | null> {
  const rows = await sql`SELECT run_id FROM active_runs WHERE ticket_key = ${ticketKey}`;
  return (rows[0]?.run_id as string | undefined) ?? null;
}

export async function listAll(): Promise<
  Array<{ ticketKey: string; runId: string }>
> {
  const rows = await sql`SELECT ticket_key, run_id FROM active_runs`;
  return rows.map((r) => ({
    ticketKey: r.ticket_key as string,
    runId: r.run_id as string,
  }));
}

export async function setEntry(
  ticketKey: string,
  runId: string,
  opts?: { ageMs?: number },
): Promise<void> {
  // Mirror the production adapter: created_at backs reconcile's orphan
  // grace window (src/lib/reconcile.ts:ORPHAN_GRACE_MS). Callers
  // exercising the orphan-cancel path (US-15) pass `ageMs` to backdate
  // past the grace window so reconcile acts on the first tick.
  const ageMs = opts?.ageMs ?? 0;
  await sql`
    INSERT INTO active_runs (ticket_key, run_id, created_at)
    VALUES (${ticketKey}, ${runId}, now() - make_interval(secs => ${ageMs / 1000}))
    ON CONFLICT (ticket_key) DO UPDATE
      SET run_id = excluded.run_id, created_at = excluded.created_at
  `;
}

export async function cleanup(ticketKey: string): Promise<void> {
  await sql`DELETE FROM active_runs WHERE ticket_key = ${ticketKey}`.catch(
    () => {},
  );
}

export interface FailedTicketMeta {
  runId: string;
  error: string;
  failedAt: string;
}

export async function markFailed(
  ticketKey: string,
  meta: FailedTicketMeta,
): Promise<void> {
  await sql`
    INSERT INTO failed_tickets (ticket_key, run_id, error, failed_at)
    VALUES (${ticketKey}, ${meta.runId}, ${meta.error}, ${meta.failedAt})
    ON CONFLICT (ticket_key) DO UPDATE
      SET run_id = excluded.run_id, error = excluded.error, failed_at = excluded.failed_at
  `;
}

export async function isTicketFailed(ticketKey: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM failed_tickets WHERE ticket_key = ${ticketKey}`;
  return rows.length > 0;
}

export async function cleanupFailed(ticketKey: string): Promise<void> {
  await sql`DELETE FROM failed_tickets WHERE ticket_key = ${ticketKey}`.catch(
    () => {},
  );
}
