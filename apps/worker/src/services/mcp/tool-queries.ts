/**
 * The reads an MCP tool performs that exist nowhere else.
 *
 * Every other operation in `tool-services.ts` forwards to a store the dashboard
 * already uses. These five do not: each is one page of a listing, written for
 * this surface with its LIMIT inside the query, so a tool cannot claim a wider
 * result than it returns. They are bound to a handle the same way, one factory
 * per query, so `createMcpToolServices` stays a list of bindings.
 */
import { and, asc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import {
  promptLibrary,
  promptLibraryVersions,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowRuns,
} from "../../db/schema.js";
import { coerceStatus } from "../../db/queries/runs-read.js";

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

export function ticketRunPageQuery(db: Db) {
  return async (ticketKey: string, limit: number): Promise<TicketRunRow[]> => {
    const rows = await db
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
      .where(eq(workflowRuns.ticketKey, ticketKey))
      .orderBy(
        sql`coalesce(${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt}) desc`,
      )
      // One extra row, unreturned, is how truncation is detected without a
      // second count query.
      .limit(limit + 1);
    return rows.map((row) => ({ ...row, status: coerceStatus(row.status) }));
  };
}

export function workflowDefinitionPageQuery(db: Db) {
  return (limit: number) =>
    db
      .select({
        id: workflowDefinitions.id,
        name: workflowDefinitions.name,
        enabled: workflowDefinitions.enabled,
        deployedVersion: workflowDefinitions.deployedVersion,
      })
      .from(workflowDefinitions)
      .where(isNull(workflowDefinitions.archivedAt))
      .orderBy(asc(workflowDefinitions.id))
      // One extra row, unreturned, is how truncation is detected without a
      // second count query.
      .limit(limit + 1);
}

export function deployedDefinitionVersionsQuery(db: Db) {
  return (pairs: readonly { definitionId: number; version: number }[]) =>
    pairs.length === 0
      ? Promise.resolve([])
      : db
          .select({
            definitionId: workflowDefinitionVersions.definitionId,
            definition: workflowDefinitionVersions.definition,
          })
          .from(workflowDefinitionVersions)
          .where(
            or(
              ...pairs.map((pair) =>
                and(
                  eq(workflowDefinitionVersions.definitionId, pair.definitionId),
                  eq(workflowDefinitionVersions.version, pair.version),
                ),
              ),
            ),
          );
}

export function promptPageQuery(db: Db) {
  return (limit: number) =>
    db
      .select({
        id: promptLibrary.id,
        slug: promptLibrary.slug,
        name: promptLibrary.name,
      })
      .from(promptLibrary)
      .where(isNull(promptLibrary.archivedAt))
      .orderBy(asc(promptLibrary.id))
      .limit(limit + 1);
}

export function promptHeadVersionsQuery(db: Db) {
  return (promptIds: readonly number[]) =>
    db
      .select({
        promptId: promptLibraryVersions.promptId,
        currentVersion: max(promptLibraryVersions.version),
      })
      .from(promptLibraryVersions)
      .where(inArray(promptLibraryVersions.promptId, [...promptIds]))
      .groupBy(promptLibraryVersions.promptId);
}
