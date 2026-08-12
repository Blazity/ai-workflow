import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
  ManualDispatchBlockerCode,
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
  ManualDispatchResponse,
} from "@shared/contracts";
import { env } from "../../../env.js";
import { ManualDispatchError } from "../../manual-dispatch/errors.js";
import {
  dispatchManualWorkflow,
  preflightManualDispatch,
} from "../../manual-dispatch/service.js";
import {
  McpPublicError,
  type McpErrorCode,
  type McpToolDependencies,
} from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { registerCatalogTool } from "../tool-catalog.js";

type PreflightData = ManualDispatchPreflightResponse & { preflightDigest: string };

type DispatchData = { requestId: string; runId: string };

type PublicBlockerError = {
  code: McpErrorCode;
  retryable: boolean;
  // "Do we know the dispatch never landed", never "may the caller try again":
  // the key only goes back into circulation on proof, because a dispatch can
  // fail on the way back from a run it already started and a key handed back
  // there buys a second run on somebody's ticket.
  effectNotApplied: boolean;
  retryAfterMs?: number;
};

// A slot frees when some run finishes, which no schedule predicts, so this is
// only the shortest wait after which a retry can plausibly find anything
// different.
const AT_CAPACITY_RETRY_AFTER_MS = 60_000;

// The recovery pass runs inside /cron/poll, scheduled every minute
// (apps/worker/vercel.json), so looking for the run any sooner can only see the
// same unfinished dispatch.
const RECOVERY_POLL_AFTER_MS = 60_000;

const BLOCKER_ERRORS: Record<ManualDispatchBlockerCode, PublicBlockerError> = {
  // Not retryable: the agent has to wait for the run that already owns this
  // subject, and repeating the dispatch cannot make room for a second one.
  active_run: { code: "CONFLICT", retryable: false, effectNotApplied: true },
  // Released even though it is a conflict: the reservation was refused before
  // anything started, and freezing the key as a permanent failure would cost
  // the agent a day over a momentary lack of capacity.
  at_capacity: {
    code: "CONFLICT",
    retryable: true,
    retryAfterMs: AT_CAPACITY_RETRY_AFTER_MS,
    effectNotApplied: true,
  },
  // The version the agent consented to is gone, so the preflight has to be run
  // again; retrying this dispatch verbatim would only fail the same way.
  deployment_changed: { code: "CONFLICT", retryable: false, effectNotApplied: true },
  invalid_input: { code: "VALIDATION_FAILED", retryable: false, effectNotApplied: true },
  not_eligible: { code: "CONFLICT", retryable: false, effectNotApplied: true },
  // Raised by a plan awaiting a human, today also before any reservation is
  // taken (resolve.ts:207, reached from service.ts:103 before the durable
  // request row exists), so keeping the key is the conservative choice rather
  // than a forced one. The release threshold stays exactly the ratified
  // allowlist: widening it is what buys a second run on somebody's ticket.
  approval_pending: { code: "CONFLICT", retryable: false, effectNotApplied: false },
  // Jira or the VCS is unreachable. The ticket may already have been moved, so
  // this one keeps the key: retrying it must not buy a second dispatch.
  provider_unavailable: {
    code: "DEPENDENCY_UNAVAILABLE",
    retryable: true,
    effectNotApplied: false,
  },
};

/** Domain blockers carry messages the dashboard already shows to people, so
 * they are safe to forward and are the only actionable thing the agent gets:
 * the SDK's tool-error path sends the message and drops the code. Anything that
 * is not a dispatch blocker is rethrown untouched, so the execute wrapper turns
 * it into INTERNAL_ERROR instead of leaking its text. */
function throwPublicDispatchError(error: unknown): never {
  if (error instanceof ManualDispatchError) {
    const mapped = BLOCKER_ERRORS[error.code];
    throw new McpPublicError(
      mapped.code,
      error.message,
      mapped.retryable,
      mapped.retryAfterMs,
      mapped.effectNotApplied,
    );
  }
  throw error;
}

/** The identity of a dispatch: which deployed version of which trigger runs on
 * which subject. Deliberately not the whole preflight response, because a
 * ticket's title or column can drift between preflight and dispatch and such
 * cosmetic drift must not invalidate the agent's consent, while a change of
 * deployed version must. Both tools hash the caller's own arguments, never the
 * shape the service resolved from them, so the same bytes give the same digest
 * on both sides. */
function dispatchDigest(identity: {
  definitionId: number;
  deployedVersion: number;
  triggerNodeId: string;
  input: ManualDispatchInput;
}): string {
  return `sha256:${hashCanonicalJson(identity)}`;
}

/** The durable dispatch request is named after the MCP lease rather than after
 * the idempotency key. The key is reclaimable after 24 h while a
 * manual_dispatch_requests row never expires, so a key-derived name would
 * answer a reclaimed key with yesterday's runId, without a new run and without
 * an error. Derived rather than random, because an invocation thawed after its
 * deadline has to arrive at the same name for the lease it still holds. */
function requestIdForLease(leaseId: string): string {
  const digits = hashCanonicalJson(leaseId).slice(0, 32).split("");
  // Formatted as a UUID because that is what this field is elsewhere in the
  // repo (manual-dispatch/http.ts:38 validates it as one). Version 8 is the
  // shape reserved for a value derived from application data, and the variant
  // nibble carries the RFC's 10xx bits.
  digits[12] = "8";
  digits[16] = ((Number.parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = digits.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function targetRefsFor(input: {
  definitionId: number;
  triggerNodeId: string;
  input: ManualDispatchInput;
}): string[] {
  return [
    String(input.definitionId),
    input.triggerNodeId,
    // Upper-cased the way the dispatch domain normalizes a ticket key
    // (resolve.ts:600), so searching the audit trail for a ticket is not case
    // sensitive. A pull request URL has no local canonical form, so it is
    // recorded exactly as the agent sent it.
    input.input.kind === "ticket" ? input.input.ticketKey.toUpperCase() : input.input.url,
  ];
}

export function registerWorkflowTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "workflows.dispatch_preflight",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "workflows.dispatch_preflight",
        targetRefs: targetRefsFor(input),
        operation: async (): Promise<PreflightData> => {
          let preflight: ManualDispatchPreflightResponse;
          try {
            preflight = await preflightManualDispatch({
              db: deps.db,
              adapters: deps.adapters,
              definitionId: input.definitionId,
              triggerNodeId: input.triggerNodeId,
              dispatchInput: input.input,
              maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
            });
          } catch (error) {
            throwPublicDispatchError(error);
          }
          return {
            ...preflight,
            // Hashed over this call's own arguments, with only the version taken
            // from the server. Hashing what the service resolved instead would
            // hand back a digest the agent cannot reproduce from the bytes it
            // sent: a ticket key comes back upper-cased (resolve.ts:600) and a
            // pull request URL comes back as the provider spells it
            // (resolve.ts:415), so every dispatch would fail validation forever
            // with no local way to guess the canonical form. The binding does
            // not weaken, it tightens: the version inside the digest is the one
            // the server resolved, a deployment that moves between the two calls
            // is still caught by the service as deployment_changed, and
            // preflighting "proj-1" then dispatching "PROJ-1" is now correctly
            // refused, because consent covers the exact bytes that were sent.
            preflightDigest: dispatchDigest({
              definitionId: input.definitionId,
              deployedVersion: preflight.deployedVersion,
              triggerNodeId: input.triggerNodeId,
              input: input.input,
            }),
          };
        },
      });
      // No trust override: the response carries a ticket title, a workflow name
      // and step descriptions, all of them somebody else's text.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "workflows.dispatch",
    async (input) => {
      const digest = dispatchDigest({
        definitionId: input.definitionId,
        deployedVersion: input.expectedDeployedVersion,
        triggerNodeId: input.triggerNodeId,
        input: input.input,
      });
      const envelope = await executeMcpMutation({
        deps,
        toolName: "workflows.dispatch",
        targetRefs: targetRefsFor(input),
        idempotencyKey: input.idempotencyKey,
        // The digest already is the canonical hash of this dispatch's identity,
        // which is exactly what "same key, same payload" has to compare.
        payloadHash: digest,
        operation: async (leaseId): Promise<DispatchData> => {
          if (input.preflightDigest !== digest) {
            throw new McpPublicError(
              "VALIDATION_FAILED",
              // Names the fields that have to line up, because the agent cannot
              // see which one drifted and "run the preflight again" on its own
              // is advice it can follow forever without getting anywhere.
              "preflightDigest does not match these arguments: send the digest workflows.dispatch_preflight returned for this exact definitionId, triggerNodeId and input, with expectedDeployedVersion set to the deployedVersion it reported.",
              false,
              undefined,
              // Raised before the service was reached, so the key is provably
              // unspent and the corrected dispatch may reuse it.
              true,
            );
          }
          let response: ManualDispatchResponse;
          try {
            response = await dispatchManualWorkflow({
              db: deps.db,
              adapters: deps.adapters,
              definitionId: input.definitionId,
              triggerNodeId: input.triggerNodeId,
              request: {
                requestId: requestIdForLease(leaseId),
                expectedDeployedVersion: input.expectedDeployedVersion,
                input: input.input,
              },
              // The dispatch is the agent's, and the audit row already names the
              // MCP client behind it.
              actor: {
                id: deps.actor.userId ?? deps.actor.subject,
                label: `MCP ${deps.actor.clientId}`,
              },
              maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
            });
          } catch (error) {
            throwPublicDispatchError(error);
          }
          if (response.status === "recovering") {
            // Stored as this key's outcome, and not retryable. The dispatch is
            // durably queued: its manual_dispatch_requests row is alive in one of
            // the four statuses the recovery pass picks up (manual-dispatch/
            // store.ts:234, run from /cron/poll every minute), so no work was
            // lost. Releasing the key would DELETE it and let a retry mint a
            // second dispatch row for the same subject; once the first row's run
            // has finished and freed the subject reservation, that second row
            // starts a second run on the same ticket.
            //
            // Hence the asymmetry with at_capacity, the least obvious thing in
            // this file. There the dispatch row is already dead
            // (markManualDispatchFailed stores `failed` for every code and the
            // recovery pass never picks a failed row up), so the only way
            // forward is a new requestId, which is exactly what releasing the
            // key buys. Here the row is alive, so a new requestId would
            // duplicate it.
            //
            // Not TIMEOUT, which means the deadline took the reply and the state
            // is unknown, and not CONFLICT, because nothing collided. The delay
            // stays in the message rather than in retryAfterMs: it says when to
            // look for the run, and must not read as permission to repeat a call
            // that this key can no longer serve.
            throw new McpPublicError(
              "DEPENDENCY_UNAVAILABLE",
              `Dispatch accepted and queued, but no run has started yet: the recovery pass may start one within about ${RECOVERY_POLL_AFTER_MS} ms. Look for a new run on this subject, and if none ever appears, dispatch again under a NEW idempotency key.`,
              false,
              undefined,
              false,
            );
          }
          return { requestId: response.requestId, runId: response.runId };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
