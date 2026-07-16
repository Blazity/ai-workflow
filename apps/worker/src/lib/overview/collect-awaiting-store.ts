import { and, desc, eq, sql } from "drizzle-orm";
import type { Run } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { clarificationRequests, workflowRuns } from "../../db/schema.js";

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
      questions: clarificationRequests.questions,
      suggestedAnswers: clarificationRequests.suggestedAnswers,
      askedAt: clarificationRequests.askedAt,
    })
    .from(workflowRuns)
    .leftJoin(
      clarificationRequests,
      and(
        eq(clarificationRequests.runId, workflowRuns.runId),
        eq(clarificationRequests.status, "pending"),
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
    };

    if (r.askedAt) {
      run.askedAtMin = Math.max(
        0,
        Math.round((now.getTime() - r.askedAt.getTime()) / 60000),
      );
    }
    if (r.questions && r.questions.length > 0) {
      run.question = r.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    }
    if (r.suggestedAnswers && r.suggestedAnswers.length > 0) {
      run.suggestedAnswers = r.suggestedAnswers;
    }

    return run;
  });
}
