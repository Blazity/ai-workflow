/**
 * The reads an MCP tool performs that exist nowhere else.
 *
 * Every other operation in `tool-services.ts` forwards to a store the dashboard
 * already uses. These five do not: each is one page of a listing, written for
 * this surface with its LIMIT inside the query, so a tool cannot claim a wider
 * result than it returns. They are bound to a handle the same way, one factory
 * per query, so `createMcpToolServices` stays a list of bindings.
 */
import type { Db } from "../../db/types.js";
import type { RunStatus } from "@shared/contracts";
import {
  listMcpPromptPage,
  listMcpTicketRunPage,
  listMcpWorkflowDefinitionPage,
  readMcpDeployedDefinitionVersions,
  readMcpPromptHeadVersions,
} from "../../db/repositories/mcp.js";
const RUN_STATUSES = new Set<RunStatus>(["success", "running", "failed", "blocked", "awaiting"]);

function coerceStatus(status: string | null): RunStatus {
  return status && RUN_STATUSES.has(status as RunStatus) ? status as RunStatus : "running";
}

/** One row of a ticket's run page, with its status already coerced to the
 *  vocabulary the MCP contract publishes. */
export interface TicketRunRow {
  runId: string;
  workflowId: string | null;
  workflowName: string | null;
  status: ReturnType<typeof coerceStatus>;
  ticketKey: string | null;
  createdAt: Date | null;
  firstSeenAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  durationSec: number | null;
}

export function mapMcpTicketRunRows(
  rows: Awaited<ReturnType<typeof listMcpTicketRunPage>>,
): TicketRunRow[] {
  return rows.map((row) => ({ ...row, status: coerceStatus(row.status) }));
}

export function ticketRunPageQuery(db: Db) {
  return async (ticketKey: string, limit: number): Promise<TicketRunRow[]> =>
    mapMcpTicketRunRows(await listMcpTicketRunPage(db, ticketKey, limit));
}

export function workflowDefinitionPageQuery(db: Db) {
  return (limit: number) => listMcpWorkflowDefinitionPage(db, limit);
}

export function deployedDefinitionVersionsQuery(db: Db) {
  return (pairs: readonly { definitionId: number; version: number }[]) =>
    readMcpDeployedDefinitionVersions(db, pairs);
}

export function promptPageQuery(db: Db) {
  return (limit: number) => listMcpPromptPage(db, limit);
}

export function promptHeadVersionsQuery(db: Db) {
  return (promptIds: readonly number[]) =>
    readMcpPromptHeadVersions(db, promptIds);
}
