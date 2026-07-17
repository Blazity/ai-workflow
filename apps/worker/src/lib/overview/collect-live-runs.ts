import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import type { Run } from "@shared/contracts";

export interface CollectLiveRunsOptions {
  registry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  jiraBaseUrl: string;
  model: string;
}

/**
 * Builds the Run[] for the Overview live panels from in-flight registry state.
 *
 * Historical/aggregate fields (cost, tokens, spans, evalScore, duration) and
 * live progress fields (currentSpan, progress, etaSec) are not tracked yet —
 * returned as null or omitted. The dashboard renders `—` for null metrics.
 *
 * `status` defaults to `"running"`; a clarification-detection signal needed to
 * distinguish `"awaiting"` is a follow-up.
 */
export async function collectLiveRuns(
  opts: CollectLiveRunsOptions,
): Promise<Run[]> {
  const { registry, issueTracker, jiraBaseUrl, model } = opts;
  const entries = await registry.listAll();
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  const boundEntries = entries.filter(
    (entry): entry is typeof entry & { runId: string } =>
      entry.state === "bound" && entry.runId !== null,
  );

  return Promise.all(
    boundEntries.map(async ({ subjectKey, ticketKey, runId }): Promise<Run> => {
      let ticketTitle = ticketKey ?? subjectKey;
      if (ticketKey) {
        try {
          const ticket = await issueTracker.fetchTicket(ticketKey);
          if (ticket.title) ticketTitle = ticket.title;
        } catch {
          // Best-effort lookup — fall through to the durable subject identity.
        }
      }
      const displayKey = ticketKey ?? subjectKey;

      return {
        id: runId,
        workflow: "wf_agent",
        workflowName: "Agent",
        status: "running",
        ticket: displayKey,
        actor: "ai-bot",
        model,
        startedAtMin: 0,
        duration: null,
        tokens: null,
        cost: null,
        spans: null,
        evalScore: null,
        guardrailHits: null,
        ticketTitle,
        prNumber: null,
        ticketUrl: ticketKey ? `${tenantOrigin}/browse/${ticketKey}` : "",
        prUrl: null,
      };
    }),
  );
}
