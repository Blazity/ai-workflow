import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Plan-approval queue: one row per plan a human must approve before the
 * implementation run continues. A send_plan_approval block inserts a pending
 * row and ends its run; the dashboard lists pending rows and approves/rejects
 * them, and an approval dispatches a fresh trigger_plan_approved run.
 *
 * The partial unique index keeps at most one pending row per ticket:
 * createApprovalRequest supersedes any existing pending row in the same
 * transaction before inserting, so a re-run of the same ticket can never leave
 * two live approvals competing for one implementation.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    ticketKey: text("ticket_key").notNull(),
    definitionId: integer("definition_id").notNull(),
    /**
     * Head version of the definition at the moment the plan was filed. Pins the
     * approval to the exact graph a human reviewed, so approving later runs that
     * version even if the definition's head has since advanced. Nullable only for
     * rows written before this column existed (backfilled to the head version).
     */
    definitionVersion: integer("definition_version"),
    /** Run that produced the plan (the send_plan_approval block's run). */
    runId: text("run_id").notNull(),
    plan: jsonb("plan").$type<{ markdown: string }>().notNull(),
    assumptions: jsonb("assumptions").$type<string[]>(),
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestedBy: text("requested_by").notNull().default("workflow"),
    decidedById: text("decided_by_id"),
    decidedByLabel: text("decided_by_label"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Run started when the plan was approved (the trigger_plan_approved run). */
    dispatchedRunId: text("dispatched_run_id"),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status),
    index("approval_requests_ticket_key_idx").on(t.ticketKey),
    uniqueIndex("approval_requests_pending_ticket_idx")
      .on(t.ticketKey)
      .where(sql`${t.status} = 'pending'`),
  ],
);
