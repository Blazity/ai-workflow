import { and, desc, eq, sql } from "drizzle-orm";
import type { Run } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { approvalRequests, clarificationRequests, workflowRuns } from "../../db/schema.js";

export interface CollectAwaitingRunsOptions {
  db: Db;
  jiraBaseUrl: string;
  /** Used when a run has no persisted model. */
  model: string;
  now: Date;
}

/**
 * Builds the "Input needed" rows for the Overview from the durable run store.
 *
 * Awaiting state now lives in `workflow_runs` (status "awaiting") joined with the
 * run's pending `clarification_requests` row: the dashboard is the source of truth
 * for the conversation, and Jira only holds the ticket's status. This replaces the
 * former Jira scan (collect-awaiting-runs), so the rows carry the REAL run id and
 * deep-link to a run that actually exists.
 *
 * The join is a LEFT join on purpose: an awaiting run whose pending clarification
 * is missing still lists (just without the question payload). No time window: a run
 * parked days ago must still show.
 *
 * A second LEFT join against `approval_requests` (matched on the filing run id,
 * status "pending") distinguishes the other reason a run can sit in "awaiting":
 * a plan parked for human approval. That row carries no clarification, so without
 * this join it would render like a clarification with a null question. `awaitingKind`
 * tells the dashboard which surface actually owns the next action: a clarification
 * is answered on the run trace, an approval is decided on the Approvals page.
 */
export async function collectAwaitingRuns(
  opts: CollectAwaitingRunsOptions,
): Promise<Run[]> {
  const { db, jiraBaseUrl, model, now } = opts;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  const rows = await db
    .select({
      runId: workflowRuns.runId,
      workflowId: workflowRuns.workflowId,
      workflowName: workflowRuns.workflowName,
      ticketKey: workflowRuns.ticketKey,
      ticketTitle: workflowRuns.ticketTitle,
      ticketUrl: workflowRuns.ticketUrl,
      model: workflowRuns.model,
      startedAt: workflowRuns.startedAt,
      firstSeenAt: workflowRuns.firstSeenAt,
      prNumber: workflowRuns.prNumber,
      prUrl: workflowRuns.prUrl,
      prs: workflowRuns.prs,
      questions: clarificationRequests.questions,
      suggestedAnswers: clarificationRequests.suggestedAnswers,
      askedAt: clarificationRequests.askedAt,
      approvalId: approvalRequests.id,
    })
    .from(workflowRuns)
    .leftJoin(
      clarificationRequests,
      and(
        eq(clarificationRequests.runId, workflowRuns.runId),
        eq(clarificationRequests.status, "pending"),
      ),
    )
    .leftJoin(
      approvalRequests,
      and(
        eq(approvalRequests.runId, workflowRuns.runId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .where(eq(workflowRuns.status, "awaiting"))
    .orderBy(
      desc(
        sql`coalesce(${clarificationRequests.askedAt}, ${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt})`,
      ),
    );

  return rows.map((r): Run => {
    const eff = r.startedAt ?? r.firstSeenAt;
    const run: Run = {
      id: r.runId,
      workflow: r.workflowId ?? "wf_unknown",
      workflowName: r.workflowName ?? r.workflowId ?? "—",
      status: "awaiting",
      ticket: r.ticketKey ?? "",
      actor: "ai-bot",
      model: r.model ?? model,
      startedAtMin: Math.max(0, Math.round((now.getTime() - eff.getTime()) / 60000)),
      duration: null,
      tokens: null,
      cost: null,
      spans: null,
      evalScore: null,
      guardrailHits: null,
      ticketTitle: r.ticketTitle ?? r.ticketKey ?? "",
      prNumber: r.prNumber,
      ticketUrl:
        r.ticketUrl ?? (r.ticketKey ? `${tenantOrigin}/browse/${r.ticketKey}` : ""),
      prUrl: r.prUrl,
      prs: r.prs,
    };

    if (r.askedAt) {
      run.askedAtMin = Math.max(
        0,
        Math.round((now.getTime() - r.askedAt.getTime()) / 60000),
      );
    }
    const hasQuestion = r.questions !== null && r.questions.length > 0;
    if (hasQuestion) {
      run.question = r.questions!.map((q, i) => `${i + 1}. ${q}`).join("\n");
    }
    if (r.suggestedAnswers && r.suggestedAnswers.length > 0) {
      run.suggestedAnswers = r.suggestedAnswers;
    }

    // A pending approval with no clarification is a plan parked for human
    // review, not a question: the dashboard must send it to /approvals instead
    // of the run trace's dead-end answer form. Leave `awaitingKind` unset for
    // every other row (clarification or neither) so their shape stays exactly
    // what it was before this join existed.
    if (!hasQuestion && r.approvalId) {
      run.awaitingKind = "approval";
      run.approvalId = r.approvalId;
    }

    return run;
  });
}
