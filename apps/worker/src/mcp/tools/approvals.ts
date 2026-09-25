/**
 * The Approvals screen, as tools.
 *
 * Four, for what a person does there: see which plans are waiting, open one and
 * read it, approve it, reject it. They are the MCP half of the same HTTP routes,
 * and the service cluster is the seam, never the route handler: who may decide
 * (`canApproveWorkflowPlans`), the compare-and-set that makes a decision final,
 * the claim that keeps it and its run in step, and every refusal live in
 * `services/approvals`, so this file maps outcomes to MCP codes and nothing else.
 *
 * Two things these tools deliberately do not take. No reason: a decision has no
 * column to keep one and the dashboard asks for none, and a required field whose
 * only destination is this transport's audit row would read as a record somebody
 * could later go and find. And no confirmation digest: an approval id names one
 * immutable plan (a newer plan is a new id and supersedes the old one), so the id
 * already binds the decision to the text the caller read.
 *
 * A plan is agent-authored text, and the envelope labels it as untrusted.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DashboardAuthError, type ApprovalRequest } from "@shared/contracts";
import {
  ApprovalStoreError,
  approveApproval,
  listDashboardApprovals,
  readDashboardApproval,
  rejectApproval,
  type ApprovalDecider,
} from "../../services/approvals/index.js";
import {
  McpPublicError,
  type McpActorContext,
  type McpToolDependencies,
} from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import {
  APPROVALS_PAGE_DEFAULT,
  mcpEnvelopeResult,
  registerCatalogTool,
} from "../tool-catalog.js";
import { mcpPageBounds } from "./page-budget.js";

/** Enough of a plan to tell two apart in a listing, and no more: the listing's
 *  size must not grow with what an agent wrote. */
const PLAN_EXCERPT_LENGTH = 280;

/** The smallest page of plan text a reply carries, however much else it holds. */
const PLAN_PAGE_MIN_BYTES = 1_024;

interface ApprovalHeader {
  approvalId: string;
  status: ApprovalRequest["status"];
  ticketKey: string;
  /** The run that wrote the plan and is parked on the decision. */
  filedByRunId: string;
  definitionId: number;
  definitionVersion: number | null;
  requestedAt: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The run an approval started, once it has started. */
  dispatchedRunId: string | null;
}

interface ApprovalSummary extends ApprovalHeader {
  planExcerpt: string;
  planLength: number;
  assumptionCount: number;
  repositories: Array<{ repoPath: string; access: "read" | "write" }>;
}

interface ApprovalListData {
  approvals: ApprovalSummary[];
  hasMore: boolean;
}

interface ApprovalDetailData extends ApprovalHeader {
  plan: {
    markdown: string;
    offset: number;
    length: number;
    nextOffset: number | null;
  };
  assumptions: string[] | null;
  repositories: NonNullable<ApprovalRequest["repositoryScope"]>["repositories"] | null;
}

interface ApprovalDecisionData {
  approvalId: string;
  ticketKey: string;
  status: ApprovalRequest["status"];
  decidedBy: string | null;
  decidedAt: string | null;
  filedByRunId: string;
  /** The run the approval started; null on a rejection. */
  runId: string | null;
}

function header(approval: ApprovalRequest): ApprovalHeader {
  return {
    approvalId: approval.id,
    status: approval.status,
    ticketKey: approval.ticketKey,
    filedByRunId: approval.runId,
    definitionId: approval.definitionId,
    definitionVersion: approval.definitionVersion,
    requestedAt: approval.requestedAt,
    requestedBy: approval.requestedBy,
    decidedBy: approval.decidedByLabel ?? approval.decidedById,
    decidedAt: approval.decidedAt,
    dispatchedRunId: approval.dispatchedRunId,
  };
}

function summary(approval: ApprovalRequest): ApprovalSummary {
  const markdown = approval.plan.markdown;
  return {
    ...header(approval),
    planExcerpt: Array.from(markdown).slice(0, PLAN_EXCERPT_LENGTH).join(""),
    planLength: markdown.length,
    assumptionCount: approval.assumptions?.length ?? 0,
    repositories: (approval.repositoryScope?.repositories ?? []).map((repository) => ({
      repoPath: repository.repoPath,
      access: repository.access,
    })),
  };
}

/** What one character of plan text costs inside the reply's JSON. */
function jsonCost(character: string): number {
  return Buffer.byteLength(JSON.stringify(character)) - 2;
}

/**
 * One page of the plan, starting at `offset`, holding as many whole characters
 * as fit in `budget` bytes of the reply. Walks by code point, so a page never
 * ends inside a surrogate pair, and `nextOffset` is null only when the plan is
 * done: a page is never cut short without saying so.
 */
function planPage(
  markdown: string,
  offset: number,
  budget: number,
): ApprovalDetailData["plan"] {
  let end = offset;
  let spent = 0;
  while (end < markdown.length) {
    const character = String.fromCodePoint(markdown.codePointAt(end)!);
    const cost = jsonCost(character);
    if (spent + cost > budget && end > offset) break;
    spent += cost;
    end += character.length;
  }
  return {
    markdown: markdown.slice(offset, end),
    offset,
    length: markdown.length,
    nextOffset: end < markdown.length ? end : null,
  };
}

/** Refused before anything was decided, so the idempotency key is unspent. */
function refused(
  code: McpPublicError["code"],
  message: string,
  retryable = false,
): McpPublicError {
  return new McpPublicError(code, message, retryable, undefined, true);
}

/**
 * The person behind the token, as the service's rule asks for them. The service
 * decides whether their role may decide a plan; what is refused here is only a
 * token with nobody behind it, which has no user a decision could be recorded
 * against. The policy refuses both first.
 */
function deciderOf(actor: McpActorContext): ApprovalDecider {
  if (actor.userId === null || actor.role === "service") {
    throw refused("FORBIDDEN", "Access denied");
  }
  return { userId: actor.userId, role: actor.role };
}

function notFound(approvalId: string): McpPublicError {
  return refused("NOT_FOUND", `No plan approval has the id "${approvalId}".`);
}

/** The service's own role refusal, in the words the policy refuses with. */
function publicAuthError(error: unknown): never {
  if (error instanceof DashboardAuthError && error.statusCode === 403) {
    throw refused("FORBIDDEN", "Access denied");
  }
  throw error;
}

/**
 * Why a plan cannot be decided again, from the row as it stands now: who
 * decided it and when, or that a newer plan took its place. Nothing was
 * changed by the call that asked.
 */
async function alreadyDecided(approvalId: string): Promise<McpPublicError> {
  const approval = await readDashboardApproval(approvalId);
  if (!approval) return notFound(approvalId);
  const subject = `Plan ${approvalId} for ${approval.ticketKey}`;
  if (approval.status === "superseded") {
    return refused(
      "CONFLICT",
      `${subject} was superseded by a newer plan, so it can no longer be decided; nothing was changed. approvals.list shows the plan now waiting.`,
    );
  }
  if (approval.status === "pending") {
    return refused(
      "CONFLICT",
      `${subject} was being decided by somebody else while this call ran; nothing was changed. Read it again with approvals.get.`,
    );
  }
  const by = approval.decidedByLabel ?? approval.decidedById ?? "somebody";
  const when = approval.decidedAt ? ` at ${approval.decidedAt}` : "";
  const run = approval.dispatchedRunId ? ` Its run is ${approval.dispatchedRunId}.` : "";
  return refused(
    "CONFLICT",
    `${subject} was already ${approval.status} by ${by}${when}; nothing was changed.${run}`,
  );
}

/** A plan that can never run: the service retired a pending one on the way.
 *  Not `refused()`: the row may have moved, so the key stays spent. */
async function neverRunnable(approvalId: string, what: string): Promise<McpPublicError> {
  const approval = await readDashboardApproval(approvalId);
  const ticket = approval ? ` for ${approval.ticketKey}` : "";
  return new McpPublicError(
    "CONFLICT",
    `${what}, so plan ${approvalId}${ticket} can never run and no run was started. A plan still pending was retired as rejected.`,
    false,
  );
}

function decisionData(approval: ApprovalRequest, runId: string | null): ApprovalDecisionData {
  return {
    approvalId: approval.id,
    ticketKey: approval.ticketKey,
    status: approval.status,
    decidedBy: approval.decidedByLabel ?? approval.decidedById,
    decidedAt: approval.decidedAt,
    filedByRunId: approval.runId,
    runId,
  };
}

export function registerApprovalTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(server, "approvals.list", async (input) => {
    const status = input.status ?? "pending";
    const limit = input.limit ?? APPROVALS_PAGE_DEFAULT;
    const envelope = await executeMcpRead({
      deps,
      toolName: "approvals.list",
      targetRefs: [status],
      operation: async (): Promise<ApprovalListData> => {
        const approvals = await listDashboardApprovals(status);
        return {
          approvals: approvals.slice(0, limit).map(summary),
          hasMore: approvals.length > limit,
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "approvals.get", async (input) => {
    const offset = input.planOffset ?? 0;
    const envelope = await executeMcpRead({
      deps,
      toolName: "approvals.get",
      targetRefs: [input.approvalId],
      operation: async (): Promise<ApprovalDetailData> => {
        const approval = await readDashboardApproval(input.approvalId);
        if (!approval) throw notFound(input.approvalId);
        const markdown = approval.plan.markdown;
        if (offset > markdown.length) {
          throw refused(
            "VALIDATION_FAILED",
            `planOffset ${offset} is past the end of the plan, which is ${markdown.length} characters long.`,
          );
        }
        const rest = {
          ...header(approval),
          assumptions: approval.assumptions,
          repositories: approval.repositoryScope?.repositories ?? null,
        };
        // Whatever the assumptions and the scope leave of the page budget goes to
        // the plan, so the whole reply stays one a client shows inline.
        const budget = Math.max(
          PLAN_PAGE_MIN_BYTES,
          mcpPageBounds(deps.settings).default - Buffer.byteLength(JSON.stringify(rest)),
        );
        return { ...rest, plan: planPage(markdown, offset, budget) };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "approvals.approve", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "approvals.approve",
      targetRefs: [input.approvalId],
      idempotencyKey: input.idempotencyKey,
      payloadHash: `sha256:${hashCanonicalJson({ approvalId: input.approvalId })}`,
      outcomeTargetRefs: (data) => [data.ticketKey, data.runId ?? "none"],
      operation: async (): Promise<ApprovalDecisionData> => {
        const decider = deciderOf(deps.actor);
        let outcome: Awaited<ReturnType<typeof approveApproval>>;
        try {
          // The dashboard's Approve, one service call down: the ticket check, the
          // claim, the compare-and-set and the run start are all in there.
          outcome = await approveApproval(input.approvalId, decider, deps.settings);
        } catch (error) {
          publicAuthError(error);
        }
        switch (outcome.kind) {
          case "unknown_approval":
            throw notFound(input.approvalId);
          case "already_decided":
            throw await alreadyDecided(input.approvalId);
          case "ticket_gone":
            throw await neverRunnable(input.approvalId, "Its ticket no longer exists in the tracker");
          case "definition_gone":
            throw await neverRunnable(
              input.approvalId,
              "The workflow version it was filed against no longer exists",
            );
          case "run_in_flight":
            throw refused(
              "CONFLICT",
              `Another run owns the ticket of plan ${input.approvalId}, or every agent slot is busy, so nothing was decided and the plan is still pending. Approve it again once that run has finished.`,
              true,
            );
          case "issue_tracker_unavailable":
            throw refused("DEPENDENCY_UNAVAILABLE", outcome.message, outcome.retryable);
          case "decided":
            return decisionData(outcome.approval, outcome.runId);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "approvals.reject", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "approvals.reject",
      targetRefs: [input.approvalId],
      idempotencyKey: input.idempotencyKey,
      payloadHash: `sha256:${hashCanonicalJson({ approvalId: input.approvalId })}`,
      outcomeTargetRefs: (data) => [data.ticketKey],
      operation: async (): Promise<ApprovalDecisionData> => {
        const decider = deciderOf(deps.actor);
        let outcome: Awaited<ReturnType<typeof rejectApproval>>;
        try {
          outcome = await rejectApproval(input.approvalId, decider);
        } catch (error) {
          // Somebody decided it between the service's read and its write: the
          // compare-and-set matched nothing, so nothing was written here.
          if (error instanceof ApprovalStoreError && error.statusCode === 409) {
            throw await alreadyDecided(input.approvalId);
          }
          publicAuthError(error);
        }
        switch (outcome.kind) {
          case "unknown_approval":
            throw notFound(input.approvalId);
          case "already_decided":
            throw await alreadyDecided(input.approvalId);
          case "decided":
            return decisionData(outcome.approval, null);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}
