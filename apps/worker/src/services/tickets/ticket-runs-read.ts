/**
 * Every run this system has made for one ticket, as the ticket page reads it.
 *
 * The path segment arrives percent-encoded and client-supplied, so what counts
 * as a ticket key at all is decided here: anything longer than a key the
 * trackers issue is truncated rather than sent to the database, and a blank one
 * names no ticket, which is the empty state and not an error.
 */
import { integrationsProviding } from "@integrations/registry";
import {
  canonicalTicketKey,
  ticketSubjectKey,
  type Run,
  type RunStatus,
  type TicketRunsResponse,
} from "@shared/contracts";
import {
  connectedDashboardRunQueries,
  type DashboardRunRow,
} from "../../db/repositories/runs/dashboard-query-rows.js";
import { logger } from "../../infra/logger.js";
import { issueTrackerTicketLinks } from "../settings/index.js";
import { ticketLinkFor, type TicketLinks } from "../../engine/support/ticket-url.js";
import { resolveRunModels } from "../overview/index.js";

/** The ticket payload as the wire carries it, minus the timestamp the route stamps. */
export type TicketRunsPayload = Omit<TicketRunsResponse, "generatedAt">;

const EMPTY: TicketRunsPayload = {
  available: false,
  ticket: null,
  subjectKey: null,
  trackerId: null,
  runs: [],
  totals: {
    cost: 0,
    tokens: 0,
    runCount: 0,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  },
};

/** Longer than any key a tracker issues, so the remainder is not part of one. */
const MAX_TICKET_KEY_LENGTH = 100;
const RUN_STATUSES = new Set<RunStatus>([
  "success",
  "running",
  "failed",
  "blocked",
  "awaiting",
]);

function trackerIdFromTicketUrl(url: string | null | undefined, providerIds: readonly string[]): string | null {
  if (!url) return null;
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return null;
  }
  for (const id of providerIds) {
    if (host.includes(id.toLowerCase())) return id;
  }
  if (pathname.includes("/browse/") && providerIds.length > 0) {
    return providerIds[0] ?? null;
  }
  return null;
}

async function resolveTicketIdentity(
  ticketKey: string,
  recordedTicketUrl: string | null | undefined,
  ticketLinks: TicketLinks,
): Promise<{ subjectKey: string | null; trackerId: string | null }> {
  const providerIds = integrationsProviding("issue_tracker").map((manifest) => manifest.id);
  if (providerIds.length === 0) return { subjectKey: null, trackerId: null };

  const candidates = providerIds.map((id) => ticketSubjectKey(id, ticketKey));
  const persistedSubject = await connectedDashboardRunQueries
    .findTicketWorkScopeSubjectKey?.(candidates)
    .catch(() => null);
  if (persistedSubject) {
    const parts = persistedSubject.split(":");
    return { subjectKey: persistedSubject, trackerId: parts[1] ?? null };
  }

  const fromRecordedUrl = trackerIdFromTicketUrl(recordedTicketUrl, providerIds);
  if (fromRecordedUrl) {
    return {
      subjectKey: ticketSubjectKey(fromRecordedUrl, ticketKey),
      trackerId: fromRecordedUrl,
    };
  }

  const activeUrl = ticketLinks(ticketKey);
  const fromActiveUrl = trackerIdFromTicketUrl(activeUrl, providerIds);
  if (fromActiveUrl) {
    return {
      subjectKey: ticketSubjectKey(fromActiveUrl, ticketKey),
      trackerId: fromActiveUrl,
    };
  }

  if (providerIds.length === 1) {
    return {
      subjectKey: ticketSubjectKey(providerIds[0]!, ticketKey),
      trackerId: providerIds[0]!,
    };
  }

  return { subjectKey: null, trackerId: null };
}

function mapTicketRun(row: DashboardRunRow, now: Date, ticketLinks: TicketLinks): Run {
  const effective = row.startedAt ?? row.firstSeenAt;
  const tokens = row.tokensInput !== null || row.tokensOutput !== null
    ? (row.tokensInput ?? 0) + (row.tokensOutput ?? 0)
    : null;
  const status = row.status && RUN_STATUSES.has(row.status as RunStatus)
    ? row.status as RunStatus
    : "running";
  return {
    id: row.runId,
    workflow: row.workflowId ?? "wf_unknown",
    workflowName: row.workflowName ?? row.workflowId ?? "-",
    status,
    statusReason: row.statusReason,
    ticket: row.ticketKey ?? "",
    actor: "ai-bot",
    model: row.model,
    startedAtMin: Math.max(0, Math.round((now.getTime() - effective.getTime()) / 60_000)),
    duration: row.durationSec,
    tokens,
    cost: row.costUsd,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: row.ticketTitle ?? row.ticketKey ?? "",
    prNumber: row.prNumber,
    ticketUrl: ticketLinkFor(row.ticketUrl, row.ticketKey, ticketLinks) ?? "",
    prUrl: row.prUrl,
    prs: row.prs,
  };
}

/** The ticket key a raw path segment names, empty when it names none. */
/** The ticket key a dashboard path carries, in the spelling runs record it
 *  under (`canonicalTicketKey`), so `/tickets/awp-274` finds AWP-274's runs. */
export function ticketKeyFromPathSegment(raw: string | undefined): string {
  return raw ? canonicalTicketKey(decodeURIComponent(raw)).slice(0, MAX_TICKET_KEY_LENGTH) : "";
}

export async function listTicketRuns(ticketKey: string): Promise<TicketRunsPayload> {
  if (!ticketKey) return EMPTY;
  try {
    const now = new Date();
    const ticketLinks = await issueTrackerTicketLinks();
    const data = await connectedDashboardRunQueries.listTicketRuns(ticketKey);
    const runs = data.map((row) => mapTicketRun(row, now, ticketLinks));
    const newest = data[0];
    const effectiveKey = newest?.ticketKey ?? ticketKey;
    const ticket = newest ? {
      key: effectiveKey,
      title: newest.ticketTitle ?? effectiveKey,
      url: ticketLinkFor(newest.ticketUrl, effectiveKey, ticketLinks) ?? "",
    } : null;
    const identity = await resolveTicketIdentity(effectiveKey, newest?.ticketUrl, ticketLinks);
    const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
    let cost = 0;
    let tokens = 0;
    for (const run of runs) {
      counts[run.status] += 1;
      cost += run.cost ?? 0;
      tokens += run.tokens ?? 0;
    }
    const models = await resolveRunModels(runs.map((run) => run.id));
    return {
      available: true,
      ticket,
      subjectKey: identity.subjectKey,
      trackerId: identity.trackerId,
      runs: runs.map((run) => ({ ...run, model: models.get(run.id) ?? null })),
      totals: { cost, tokens, runCount: runs.length, counts },
    };
  } catch (err) {
    // DB unreachable: degrade to the empty state so the page renders its
    // documented N/A view instead of erroring.
    logger.warn({ err: (err as Error).message, ticketKey }, "ticket_runs_failed");
    return EMPTY;
  }
}
