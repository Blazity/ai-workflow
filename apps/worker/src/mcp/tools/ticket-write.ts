import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";
import { scrubForPublication } from "../../lib/publication-scrub.js";
import { ticketSubjectKey } from "../../lib/subject-key.js";
import { moveTicket } from "../../lib/ticket-transition.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { registerCatalogTool } from "../tool-catalog.js";

/**
 * The ticket write side: comment, transition, create.
 *
 * These are the first tools on this surface whose effect lands in a system this
 * deployment does not own, which shapes all three of them:
 *
 * - No provider offers an idempotency key, so each tool asks the tracker itself
 *   whether the effect is already there before writing. A replayed mutation must not
 *   leave a duplicate comment or a duplicate ticket in a customer's Jira.
 * - The transition refuses while a run owns the ticket. An operator acting through MCP
 *   holds no run's owner token and cannot honestly pass the owner fence, so instead of
 *   borrowing one out of active_runs (which would be impersonating that run) it stays
 *   out of a working run's way and says so.
 * - Prose written by a model goes out through scrubForPublication, the same output-side
 *   control every other customer-visible artifact goes through.
 */

type CommentData = {
  ticketKey: string;
  /** Deep link to the comment when the tracker exposes one; null when it does not, or
   *  when the comment was already there and this call wrote nothing. */
  commentUrl: string | null;
  /** True when an identical comment was already on the ticket, so nothing was written. */
  alreadyPosted: boolean;
  /** True when the publication scrub changed the body on its way out, so the caller
   *  knows the ticket does not read exactly like what it sent. */
  scrubbed: boolean;
};

type TransitionData = {
  ticketKey: string;
  statusBefore: string;
  /** As observed after the move. Null when the confirming read failed: the move itself
   *  succeeded, so this is reported as unknown rather than guessed from the target. */
  statusAfter: string | null;
  alreadyAtTarget: boolean;
};

type CreateData = {
  ticketKey: string;
  url: string | null;
  /** Where the project's own workflow put the new ticket. Null when the confirming read
   *  failed; the ticket exists either way. */
  status: string | null;
  /** True when a previous attempt under this idempotency key already created it. */
  alreadyCreated: boolean;
};

/** Raised before the effect could land, so the idempotency key returns to circulation. */
function refused(
  code: McpPublicError["code"],
  message: string,
  retryable = false,
): McpPublicError {
  return new McpPublicError(code, message, retryable, undefined, true);
}

/** The one adapter failure with a public meaning. Everything else is left to
 *  executeMcpMutation's INTERNAL_ERROR, so no provider message crosses the boundary. */
function notFoundOrRethrow(error: unknown, ticketKey: string): never {
  if (error instanceof IssueTrackerNotFoundError) {
    throw refused("NOT_FOUND", `Ticket ${ticketKey} not found`);
  }
  throw error;
}

/** The status a ticket sits at, read after a write that already succeeded. Never
 *  allowed to turn a completed mutation into an error, hence the null. */
async function observedStatus(
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket">,
  ticketKey: string,
): Promise<string | null> {
  try {
    return (await issueTracker.fetchTicket(ticketKey)).trackerStatus;
  } catch {
    return null;
  }
}

/**
 * Turn a failed move into something an agent can act on. A target that does not resolve
 * from where the ticket currently sits is by far the most likely cause, because status
 * names are per project and not guessable, so that case is answered with the names that
 * DO resolve instead of a generic failure. Anything else is rethrown untouched and
 * becomes INTERNAL_ERROR, which also keeps the key sealed for a move that may have
 * landed.
 */
async function explainMoveFailure(
  issueTracker: IssueTrackerAdapter,
  ticketKey: string,
  target: IssueTrackerMoveTarget,
  error: unknown,
): Promise<never> {
  if (error instanceof IssueTrackerNotFoundError) {
    throw refused("NOT_FOUND", `Ticket ${ticketKey} not found`);
  }
  if (!issueTracker.resolveMoveTargetStatus) throw error;
  let resolved: { id: string; name: string } | null;
  try {
    resolved = await issueTracker.resolveMoveTargetStatus(ticketKey, target);
  } catch {
    // The diagnosis itself failed, so nothing more truthful can be said than the
    // original failure.
    throw error;
  }
  if (resolved !== null) throw error;
  const named = typeof target === "string" ? target : target.name;
  const available = await issueTracker
    .listStatuses?.()
    .then((statuses) => statuses.map((status) => status.name))
    .catch(() => null);
  const suffix =
    available && available.length > 0
      ? ` Statuses configured for this project: ${available.join(", ")}.`
      : "";
  throw refused(
    "VALIDATION_FAILED",
    `No transition to "${named}" is available for ${ticketKey} from where it currently sits, so nothing was moved.${suffix}`,
  );
}

export function registerTicketWriteTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(
    server,
    "tickets.comment",
    async (input) => {
      const ticketKey = input.ticketKey.trim().toUpperCase();
      const envelope = await executeMcpMutation({
        deps,
        toolName: "tickets.comment",
        targetRefs: [ticketKey],
        idempotencyKey: input.idempotencyKey,
        // The body travels as a digest: targetRefs are kept verbatim for a year, and
        // the comment itself is already durable in the tracker.
        payloadHash: `sha256:${hashCanonicalJson({ ticketKey, body: input.body })}`,
        operation: async (): Promise<CommentData> => {
          const issueTracker = deps.adapters.issueTracker;
          const body = scrubForPublication(input.body);
          let ticket;
          try {
            ticket = await issueTracker.fetchTicket(ticketKey);
          } catch (error) {
            notFoundOrRethrow(error, ticketKey);
          }

          // A tracker has no idempotency key, so a lost reply would otherwise leave a
          // duplicate comment in a customer's ticket. Same shape as the welcome-comment
          // check in lib/dashboard-links.ts: read what is there and skip the write.
          const botAccountId = await issueTracker
            .getCurrentUserAccountId?.()
            .catch(() => null);
          const alreadyPosted = ticket.comments.some(
            (comment) =>
              comment.body.trim() === body.trim() &&
              // Author-scoped when the tracker tells us who the bot is. When it does
              // not, an identical body is still treated as already posted: a second
              // copy of the same prose is noise on a ticket people read, whoever wrote
              // the first one.
              (!botAccountId || comment.accountId === botAccountId),
          );
          if (alreadyPosted) {
            return {
              ticketKey: ticket.identifier,
              commentUrl: null,
              alreadyPosted: true,
              scrubbed: body !== input.body,
            };
          }

          const commentUrl = await issueTracker.postComment(ticket.identifier, body);
          return {
            ticketKey: ticket.identifier,
            commentUrl,
            alreadyPosted: false,
            scrubbed: body !== input.body,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "tickets.transition",
    async (input) => {
      const ticketKey = input.ticketKey.trim().toUpperCase();
      const envelope = await executeMcpMutation({
        deps,
        toolName: "tickets.transition",
        targetRefs: [ticketKey],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({ ticketKey, target: input.target })}`,
        operation: async (): Promise<TransitionData> => {
          const issueTracker = deps.adapters.issueTracker;
          const subjectKey = ticketSubjectKey("jira", ticketKey);
          // undefined means the registry read itself failed, which is NOT the same as
          // "nobody owns it": moving a ticket out from under a live run cancels it, so
          // an unknown answer has to stop the write rather than be read as a free pass.
          const claim = await deps.adapters.runRegistry
            .get(subjectKey)
            .catch(() => undefined);
          if (claim === undefined) {
            throw refused(
              "DEPENDENCY_UNAVAILABLE",
              "Could not check whether a run is working on this ticket, so nothing was moved. Retry.",
              true,
            );
          }
          if (claim) {
            throw refused(
              "CONFLICT",
              `Run ${claim.runId ?? "(starting up)"} is working on ${ticketKey} (${claim.state}), and moving the ticket now would abort it. Stop that run with runs.cancel first if that is what you want, or wait for it to finish.`,
            );
          }

          let moved: { statusBefore: string; alreadyAtTarget: boolean };
          try {
            moved = await moveTicket({
              issueTracker,
              ticketKey,
              target: input.target as IssueTrackerMoveTarget,
            });
          } catch (error) {
            // `throw await` rather than a bare call: the helper always throws, and this
            // is what tells the compiler the assignment below is unreachable from here.
            throw await explainMoveFailure(
              issueTracker,
              ticketKey,
              input.target as IssueTrackerMoveTarget,
              error,
            );
          }

          return {
            ticketKey,
            statusBefore: moved.statusBefore,
            statusAfter: moved.alreadyAtTarget
              ? moved.statusBefore
              : await observedStatus(issueTracker, ticketKey),
            alreadyAtTarget: moved.alreadyAtTarget,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "tickets.create",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "tickets.create",
        // No ticket key exists yet, so the summary is what identifies this call in the
        // audit trail. It is the caller's own words, not somebody else's ticket content.
        targetRefs: [input.summary.slice(0, 120)],
        idempotencyKey: input.idempotencyKey,
        payloadHash: `sha256:${hashCanonicalJson({
          summary: input.summary,
          description: input.description ?? null,
          issueType: input.issueType ?? null,
          labels: input.labels ?? null,
        })}`,
        operation: async (): Promise<CreateData> => {
          const issueTracker = deps.adapters.issueTracker;
          if (!issueTracker.createTicket) {
            throw refused(
              "VALIDATION_FAILED",
              "The configured issue tracker cannot create tickets, so this tool is unavailable on this deployment.",
            );
          }

          // Idempotency the tracker can actually enforce: a marker label written WITH the
          // ticket, searched for before writing. A structural label keeps the mark out
          // of the prose a customer reads, and doing it in one create is what makes a
          // crash between the two impossible. Without this, one lost reply leaves a
          // duplicate ticket that a later transition would start a second run on.
          const marker = `mcp-${hashCanonicalJson({ key: input.idempotencyKey }).slice(0, 12)}`;
          const existing = await issueTracker
            .searchTickets(`labels = "${marker}"`)
            .catch(() => null);
          if (existing === null) {
            throw refused(
              "DEPENDENCY_UNAVAILABLE",
              "Could not check whether a previous attempt already created this ticket, so nothing was created. Retry with the same idempotencyKey.",
              true,
            );
          }
          if (existing.length > 0) {
            const ticketKey = existing[0]!;
            return {
              ticketKey,
              url: null,
              status: await observedStatus(issueTracker, ticketKey),
              alreadyCreated: true,
            };
          }

          const created = await issueTracker.createTicket({
            summary: input.summary,
            description: input.description
              ? scrubForPublication(input.description)
              : undefined,
            issueType: input.issueType,
            labels: [...(input.labels ?? []), marker],
          });

          return {
            ticketKey: created.identifier,
            url: created.url,
            status: await observedStatus(issueTracker, created.identifier),
            alreadyCreated: false,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
