import {
  hydrateResourceIO,
  observabilityRevivers,
  parseWorkflowName,
} from "workflow/observability";
import type { Run, RunStatus } from "@shared/contracts";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import { RUN_LABEL_PREFIX, runLabel } from "../labels.js";

/**
 * The slice of the Workflow DevKit's `world.runs` API we depend on. The real
 * object is `getWorld().runs`; this narrow interface keeps the collector
 * testable with a fake.
 */
export interface RunsLister {
  list(params?: {
    resolveData?: "none" | "all";
    pagination?: { limit?: number; cursor?: string };
  }): Promise<{ data: WorkflowRunRecord[] }>;
}

/** Subset of a `WorkflowRun` record (from `world.runs.list`) that we read. */
export interface WorkflowRunRecord {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  workflowName: string;
  input?: unknown;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export const STATUS_MAP: Record<WorkflowRunRecord["status"], RunStatus> = {
  completed: "success",
  failed: "failed",
  running: "running",
  pending: "running",
  cancelled: "blocked",
};

const WORKFLOW_MAP: Record<string, { id: string; name: string }> = {
  agentWorkflow: { id: "wf_agent", name: "Agent" },
  postPrGateWorkflow: { id: "wf_post_pr_gate", name: "Post-PR gate" },
};

export function mapWorkflow(workflowName: string): { id: string; name: string } {
  let fn = workflowName;
  try {
    fn = parseWorkflowName(workflowName)?.functionName ?? workflowName;
  } catch {
    // Unparseable name — fall back to the raw value.
  }
  return WORKFLOW_MAP[fn] ?? { id: `wf_${fn}`, name: fn };
}

/**
 * Best-effort ticket key. The agent workflow's only argument is the ticket key
 * (`start(agentWorkflow, [ticketKey])`), so we hydrate the serialized input and
 * read it. Hydration decodes a single argument to the bare value and a multi-arg
 * list to an array, so we accept both. Encrypted/undecodable input yields "".
 */
function extractTicket(run: WorkflowRunRecord): string {
  try {
    const { input } = hydrateResourceIO(run, observabilityRevivers) as {
      input?: unknown;
    };
    if (typeof input === "string") return input;
    if (Array.isArray(input) && typeof input[0] === "string") return input[0];
  } catch {
    // Serialized/encrypted input we can't decode here.
  }
  return "";
}

export interface CollectRunsOptions {
  runsLister: RunsLister;
  issueTracker: IssueTrackerAdapter;
  jiraBaseUrl: string;
  /** Jira project key, used to scope the run-label lookup query. */
  projectKey: string;
  model: string;
  now: Date;
  /** Max runs to return (most recent first). */
  limit?: number;
}

export interface CollectRunsResult {
  rows: Run[];
  total: number;
  counts: {
    success: number;
    running: number;
    awaiting: number;
    failed: number;
    blocked: number;
  };
}

/**
 * Builds the recent-runs table from the Vercel Workflow run store. Per-run cost,
 * tokens, spans and eval scores are not tracked by the workflow runtime, so they
 * stay `null` (the dashboard renders `—`).
 */
export async function collectRuns(
  opts: CollectRunsOptions,
): Promise<CollectRunsResult> {
  const { runsLister, issueTracker, jiraBaseUrl, model, now } = opts;
  const limit = opts.limit ?? 50;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  // `resolveData: "none"` (not "all"): expired runs return an `error` field that
  // `@workflow/world-vercel`'s schema rejects, and one bad row throws away the
  // whole page (the runs table would render empty). Lazy mode skips that field.
  // The cost is an unresolved `input`, so `extractTicket` degrades to "" — the
  // ticket is best-effort anyway (the resolved input is encrypted here).
  const { data } = await runsLister.list({
    resolveData: "none",
    pagination: { limit },
  });

  const sorted = [...data].sort((a, b) => startTime(b) - startTime(a));

  const runLabelMap = await buildRunLabelMap(
    sorted,
    issueTracker,
    opts.projectKey,
  );

  const rows = await Promise.all(
    sorted.map(async (run): Promise<Run> => {
      const { id, name } = mapWorkflow(run.workflowName);
      const labeled = runLabelMap.get(run.runId);
      const ticket = labeled?.ticketKey ?? extractTicket(run);
      const startedAt = run.startedAt ?? run.createdAt;
      const duration =
        run.completedAt != null
          ? Math.max(
              0,
              Math.round((run.completedAt.getTime() - startedAt.getTime()) / 1000),
            )
          : null;
      const startedAtMin = Math.max(
        0,
        Math.round((now.getTime() - startedAt.getTime()) / 60000),
      );

      // Label-resolved runs already have their title from buildRunLabelMap;
      // only the extractTicket fallback path needs a per-run lookup.
      let ticketTitle = ticket;
      if (labeled) {
        ticketTitle = labeled.title;
      } else if (ticket) {
        try {
          const t = await issueTracker.fetchTicket(ticket);
          if (t.title) ticketTitle = t.title;
        } catch {
          // Best-effort lookup — fall through to the key as the title.
        }
      }

      return {
        id: run.runId,
        workflow: id,
        workflowName: name,
        status: STATUS_MAP[run.status],
        ticket,
        actor: "ai-bot",
        model,
        startedAtMin,
        duration,
        tokens: null,
        cost: null,
        spans: null,
        evalScore: null,
        guardrailHits: null,
        ticketTitle,
        prNumber: null,
        ticketUrl: ticket ? `${tenantOrigin}/browse/${ticket}` : "",
        prUrl: null,
      };
    }),
  );

  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const r of rows) counts[r.status] += 1;

  return { rows, total: rows.length, counts };
}

/**
 * Build a `runId → {ticketKey, title}` map by querying Jira for tickets that
 * carry a `run:<id>` label for any of the listed runs. This recovers the
 * ticket for runs whose encrypted workflow `input` can't be decoded here. One
 * JQL search (capped at 50 tickets by the adapter), then one fetch per matched
 * ticket to read its labels. Best-effort: any failure yields a partial/empty
 * map and the caller falls back to `extractTicket`.
 */
async function buildRunLabelMap(
  runs: WorkflowRunRecord[],
  issueTracker: IssueTrackerAdapter,
  projectKey: string,
): Promise<Map<string, { ticketKey: string; title: string }>> {
  const map = new Map<string, { ticketKey: string; title: string }>();
  if (runs.length === 0) return map;

  const labelList = runs.map((r) => `"${runLabel(r.runId)}"`).join(", ");
  const jql = `project = "${projectKey}" AND labels in (${labelList})`;

  let keys: string[];
  try {
    keys = (await issueTracker.searchTickets(jql)) ?? [];
  } catch {
    return map;
  }

  await Promise.all(
    keys.map(async (key) => {
      try {
        const t = await issueTracker.fetchTicket(key);
        for (const label of t.labels) {
          if (label.startsWith(RUN_LABEL_PREFIX)) {
            const runId = label.slice(RUN_LABEL_PREFIX.length);
            map.set(runId, { ticketKey: key, title: t.title || key });
          }
        }
      } catch {
        // Best-effort — skip tickets we can't fetch.
      }
    }),
  );

  return map;
}

function startTime(r: WorkflowRunRecord): number {
  return (r.startedAt ?? r.createdAt).getTime();
}
