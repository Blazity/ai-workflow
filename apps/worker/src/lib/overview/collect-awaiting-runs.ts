import type { Run } from "@shared/contracts";
import type {
  IssueTrackerAdapter,
  TicketComment,
} from "../../adapters/issue-tracker/types.js";
import { NEEDS_CLARIFICATION_LABEL } from "../labels.js";

export interface CollectAwaitingRunsOptions {
  issueTracker: IssueTrackerAdapter;
  projectKey: string;
  /** Status name clarification tickets are parked in (env.COLUMN_BACKLOG). */
  backlogColumn: string;
  jiraBaseUrl: string;
  model: string;
  now: Date;
}

/**
 * Builds the "Input needed" rows for the Overview from the issue tracker.
 *
 * The workflow doesn't durably pause for clarifications — it posts the question
 * as a ticket comment, labels the ticket and moves it to the backlog column,
 * then ends. So awaiting state lives in the tracker, not the run store. We find
 * it by scanning backlog tickets carrying the clarification label and keeping
 * those whose latest comment is still the bot's (i.e. no human reply yet).
 *
 * Degrades to `[]` when the tracker can't identify the bot or can't search
 * (e.g. non-Jira adapters), so the panel simply shows "No clarifications".
 */
export async function collectAwaitingRuns(
  opts: CollectAwaitingRunsOptions,
): Promise<Run[]> {
  const { issueTracker, projectKey, backlogColumn, jiraBaseUrl, model, now } =
    opts;

  if (!issueTracker.getCurrentUserAccountId) return [];

  let botAccountId: string;
  try {
    botAccountId = await issueTracker.getCurrentUserAccountId();
  } catch {
    return [];
  }

  const jql =
    `project = "${projectKey}" AND status = "${backlogColumn}" ` +
    `AND labels = "${NEEDS_CLARIFICATION_LABEL}" ORDER BY updated DESC`;

  let keys: string[];
  try {
    keys = await issueTracker.searchTickets(jql);
  } catch {
    return [];
  }

  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  const rows = await Promise.all(
    keys.map(async (key): Promise<Run | null> => {
      try {
        const ticket = await issueTracker.fetchTicket(key);
        const latest = latestComment(ticket.comments);
        // A human has replied since the question → not awaiting any more.
        if (!latest || latest.accountId !== botAccountId) return null;

        const askedAtMin = Math.max(
          0,
          Math.round((now.getTime() - new Date(latest.createdAt).getTime()) / 60000),
        );

        return {
          id: `awaiting:${key}`,
          workflow: "wf_agent",
          workflowName: "Agent",
          status: "awaiting",
          ticket: key,
          actor: "ai-bot",
          model,
          startedAtMin: askedAtMin,
          duration: null,
          tokens: null,
          cost: null,
          spans: null,
          evalScore: null,
          guardrailHits: null,
          ticketTitle: ticket.title || key,
          prNumber: null,
          ticketUrl: `${tenantOrigin}/browse/${key}`,
          prUrl: null,
          question: latest.body,
          askedAtMin,
        };
      } catch {
        // Skip tickets we can't read; one bad row shouldn't blank the panel.
        return null;
      }
    }),
  );

  return rows.filter((r): r is Run => r !== null);
}

function latestComment(comments: TicketComment[]): TicketComment | null {
  if (comments.length === 0) return null;
  return comments.reduce((latest, c) =>
    new Date(c.createdAt).getTime() >= new Date(latest.createdAt).getTime()
      ? c
      : latest,
  );
}
