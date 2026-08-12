import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq, sql } from "drizzle-orm";

import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import { coerceStatus } from "../../db/queries/runs-read.js";
import { workflowRuns } from "../../db/schema.js";
import {
  McpPublicError,
  isTerminalRunStatus,
  type McpRunSummary,
  type McpToolDependencies,
} from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { MCP_TOOL_CATALOG } from "../tool-catalog.js";

const DEFAULT_COMMENTS_LIMIT = 20;
const DEFAULT_RUNS_LIMIT = 20;

type TicketGetData = {
  ticketKey: string;
  projectKey: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  labels: string[];
  status: string;
  statusId: string | null;
  commentCount: number;
  // Full bodies only on explicit includeComments; otherwise the agent learns
  // there ARE comments without pulling their (untrusted) content by default.
  comments: Array<{ author: string; body: string; createdAt: string }> | null;
  commentsTruncated: boolean;
  // contentUrl deliberately dropped: it can be a signed/authenticated link
  // that outlives this response, and isn't fetchable without adapter creds
  // anyway. id/filename/mimeType/size is enough for the agent to know what
  // exists.
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
};

type ListRunsData = {
  runs: McpRunSummary[];
  // Page-local truncation signal, distinct from meta.truncated (byte-limit
  // driven). Lives in `data` so an agent that only reads the payload still
  // learns the page isn't the whole history.
  truncated: boolean;
};

export function registerTicketTools(server: McpServer, deps: McpToolDependencies): void {
  server.registerTool(
    "tickets.get",
    MCP_TOOL_CATALOG["tickets.get"],
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "tickets.get",
        targetRefs: [input.ticketKey],
        operation: async (): Promise<TicketGetData> => {
          let ticket;
          try {
            ticket = await deps.adapters.issueTracker.fetchTicket(input.ticketKey);
          } catch (error) {
            // Only the specific "no such ticket" case gets a public code; any
            // other adapter failure (auth, network, malformed response) falls
            // through to executeMcpRead's generic INTERNAL_ERROR so its
            // message never leaks past the public error boundary.
            if (error instanceof IssueTrackerNotFoundError) {
              throw new McpPublicError("NOT_FOUND", "Ticket not found", false);
            }
            throw error;
          }

          // fetchTicket always returns every comment (no includeComments
          // param, no pagination on the adapter side); this tool decides how
          // much of that to hand back.
          const commentsLimit = input.commentsLimit ?? DEFAULT_COMMENTS_LIMIT;
          const comments = input.includeComments
            ? ticket.comments.slice(0, commentsLimit).map((c) => ({
                author: c.author,
                body: c.body,
                createdAt: c.createdAt,
              }))
            : null;

          return {
            ticketKey: ticket.identifier,
            projectKey: ticket.projectKey ?? null,
            title: ticket.title,
            description: ticket.description,
            acceptanceCriteria: ticket.acceptanceCriteria,
            labels: ticket.labels,
            status: ticket.trackerStatus,
            statusId: ticket.trackerStatusId ?? null,
            commentCount: ticket.comments.length,
            comments,
            commentsTruncated:
              Boolean(input.includeComments) && ticket.comments.length > commentsLimit,
            attachments: ticket.attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            })),
          };
        },
      });
      // No trust override here: ticket content (title/description/comments)
      // is caller-controlled text and must stay marked external_untrusted,
      // the default sanitizeMcpData already applies.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  server.registerTool(
    "tickets.list_runs",
    MCP_TOOL_CATALOG["tickets.list_runs"],
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "tickets.list_runs",
        targetRefs: [input.ticketKey],
        operation: async (): Promise<ListRunsData> => {
          const limit = input.limit ?? DEFAULT_RUNS_LIMIT;
          // Deliberately not listRunsForTicket: it has no SQL LIMIT and rolls
          // up totals/counts across the ticket's entire run history, which
          // would make a sliced-after-the-fact page carry a runCount wider
          // than what's actually returned. Reading workflow_runs directly
          // keeps the LIMIT in the query and this tool's page honest.
          const rows = await deps.db
            .select({
              runId: workflowRuns.runId,
              workflowId: workflowRuns.workflowId,
              workflowName: workflowRuns.workflowName,
              status: workflowRuns.status,
              ticketKey: workflowRuns.ticketKey,
              createdAt: workflowRuns.createdAt,
              firstSeenAt: workflowRuns.firstSeenAt,
              startedAt: workflowRuns.startedAt,
              completedAt: workflowRuns.completedAt,
              durationSec: workflowRuns.durationSec,
            })
            .from(workflowRuns)
            .where(eq(workflowRuns.ticketKey, input.ticketKey))
            .orderBy(
              sql`coalesce(${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt}) desc`,
            )
            // One extra row, unreturned, is how truncation is detected
            // without a second count query.
            .limit(limit + 1);

          const truncated = rows.length > limit;
          const page = truncated ? rows.slice(0, limit) : rows;

          const runs: McpRunSummary[] = page.map((r) => {
            const status = coerceStatus(r.status);
            return {
              runId: r.runId,
              workflowName: r.workflowName ?? r.workflowId ?? "wf_unknown",
              status,
              terminal: isTerminalRunStatus(status),
              ticketKey: r.ticketKey,
              createdAt: (r.createdAt ?? r.firstSeenAt).toISOString(),
              startedAt: r.startedAt ? r.startedAt.toISOString() : null,
              completedAt: r.completedAt ? r.completedAt.toISOString() : null,
              durationSec: r.durationSec,
            };
          });

          return { runs, truncated };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
