import { describe, it, expect } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTestTicketStrict,
  isTicketVisibleInJql,
} from "../helpers/jira.js";
import {
  createCapacityCampaign,
  createE2ECapacityRegistry,
  withCapacityReservations,
} from "../helpers/capacity-registry.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-11: Capacity limit respected
 *
 * Pre-saturates the active-runs registry with MAX_CONCURRENT_AGENTS fresh,
 * owner-scoped reservations so every capacity slot is consumed. Then creates
 * ONE real ticket and verifies dispatch rejects it — both cron and the
 * deployed scheduled cron must see the registry as full and return
 * `at_capacity` for the new ticket.
 *
 * This replaces an older approach that created MAX+1 real tickets. That
 * was correct but wasteful: with MAX=20 it spun up 20 real workflows and
 * sandboxes just to prove the cap. Pre-saturating with dummies exercises
 * the same `isAtCapacity` code path in `src/lib/dispatch.ts` without any
 * real workflow execution.
 */
describe("US-11: Capacity limit respected", () => {
  it("rejects a new ticket when every capacity slot is consumed", async () => {
    const registry = createE2ECapacityRegistry();
    const campaign = createCapacityCampaign(e2eEnv.MAX_CONCURRENT_AGENTS);
    let ticketKey: string | null = null;
    let ticketCreationAttempted = false;
    let ticketSafeToDelete = false;

    console.log(
      `[US-11] Capacity campaign ${campaign.id} owns ${campaign.subjectKeys.length} slots`,
    );
    try {
      await withCapacityReservations({
        registry,
        campaign,
        run: async () => {
          // 1. Create a single real ticket and move it to AI.
          ticketCreationAttempted = true;
          const created = await createTestTicket({
            summary: `[E2E] Capacity overflow ${campaign.id.slice(0, 8)}`,
            description:
              `Capacity campaign ${campaign.id} saturates every slot; dispatch must reject this ticket.`,
          });
          ticketKey = created.ticketKey;
          await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

          // 2. Wait for the same JQL-backed view that cron consumes.
          await waitFor(
            async () =>
              (await isTicketVisibleInJql(ticketKey!, e2eEnv.COLUMN_AI))
                ? true
                : null,
            {
              description: `${ticketKey} visible in JQL under ${e2eEnv.COLUMN_AI}`,
              timeoutMs: 60_000,
              intervalMs: 2_000,
            },
          );

          // 3. Refresh the exact unbound reservations before every poll. If
          // any owner/state changed, refresh fails closed instead of replacing
          // it. Capacity must hold throughout every observed tick.
          const firstObservation = await waitFor(
            async () => {
              await registry.refresh(campaign);
              const res = await callCronPoll();
              expect(res.status).toBe(200);
              expect(res.body?.started).toBe(0);
              const evidence = await registry.inspectTicketDispatch(ticketKey!);
              expect(evidence.activeClaims).toBe(0);
              expect(evidence.workflowRuns).toBe(0);
              return evidence.atCapacityQueued ? { res, evidence } : null;
            },
            {
              description: `cron records exact at_capacity evidence for ${ticketKey}`,
              timeoutMs: 30_000,
              intervalMs: 3_000,
            },
          );
          console.log(
            "[US-11] cron response:",
            JSON.stringify(firstObservation.res.body),
          );

          // 4. A second independent tick must retain the exact queue evidence
          // without ever publishing an active claim or durable workflow run.
          // This cannot be satisfied by some other ticket among cron's JQL
          // results or comment-processing bound.
          await registry.refresh(campaign);
          const secondPoll = await callCronPoll();
          expect(secondPoll.status).toBe(200);
          expect(secondPoll.body?.started).toBe(0);
          expect(await registry.inspectTicketDispatch(ticketKey)).toEqual({
            atCapacityQueued: true,
            activeClaims: 0,
            workflowRuns: 0,
          });
        },
        beforeRelease: async () => {
          if (ticketCreationAttempted && !ticketKey) {
            throw new Error(
              `Capacity campaign ${campaign.id} cannot prove whether Jira created its ticket; preserving reservations`,
            );
          }
          if (!ticketKey) return;

          // Keep the capacity fence in place until Jira is durably outside AI.
          // If a capacity regression created a bound claim, this transition
          // drives the normal webhook cancel/reconcile path; it is never
          // raw-deleted by the fixture helper.
          const status = await getTicketStatus(ticketKey);
          if (status.toLowerCase() === e2eEnv.COLUMN_AI.toLowerCase()) {
            await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);
          }
          const confirmedStatus = await waitFor(
            async () => {
              const current = await getTicketStatus(ticketKey!);
              return current.toLowerCase() !== e2eEnv.COLUMN_AI.toLowerCase()
                ? current
                : null;
            },
            {
              description: `${ticketKey} confirmed outside ${e2eEnv.COLUMN_AI}`,
              timeoutMs: 60_000,
              intervalMs: 2_000,
            },
          );
          await waitFor(
            async () =>
              (await isTicketVisibleInJql(ticketKey!, confirmedStatus))
                ? true
                : null,
            {
              description: `${ticketKey} indexed under ${confirmedStatus}`,
              timeoutMs: 60_000,
              intervalMs: 2_000,
            },
          );
          await waitFor(
            async () => {
              const evidence = await registry.inspectTicketDispatch(ticketKey!);
              if (evidence.workflowRuns > 0) {
                throw new Error(
                  `${ticketKey} has ${evidence.workflowRuns} durable workflow run(s)`,
                );
              }
              return evidence.activeClaims === 0 ? evidence : null;
            },
            {
              description: `${ticketKey} has zero canonical active-run claims and workflow runs`,
              timeoutMs: 60_000,
              intervalMs: 2_000,
            },
          );
          await registry.deleteTicketCapacityEvidence(ticketKey);
          const releasedEvidence = await registry.inspectTicketDispatch(ticketKey);
          if (releasedEvidence.atCapacityQueued) {
            throw new Error(
              `${ticketKey} still has at-capacity queue evidence after exact cleanup`,
            );
          }
          ticketSafeToDelete = true;
        },
      });
    } finally {
      // A failed safety barrier intentionally leaves the ticket and capacity
      // reservations visible for investigation instead of hiding a leak.
      if (ticketKey && ticketSafeToDelete) {
        await deleteTestTicketStrict(ticketKey);
      }
    }
  });
});
