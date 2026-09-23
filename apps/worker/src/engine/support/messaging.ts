/**
 * Messaging, as core reaches it.
 *
 * Core says what happened for a ticket and asks what people said; which
 * provider carries that is the deployment's answer, resolved here and nowhere
 * else. Nothing in this file names a provider.
 *
 * Two things stay on this side of the port, and this module is why:
 *
 * - **Which conversation a ticket owns.** It is a row in `thread_parents`,
 *   keyed by ticket, and it outlives the run that started it. The provider
 *   gets the handle and hands a new one back; it never reads our database,
 *   and a second provider needs no table of its own.
 * - **What a ticket links to.** The tracker this deployment talks to is core's
 *   fact, so core builds the link and the provider renders it.
 *
 * Resolution happens per call rather than once, because disabling an
 * integration is the kill switch an admin reaches for and a sender built at
 * process start would keep posting for as long as the process lived. A
 * notification is a handful of calls per run, so the read is cheap where it
 * happens.
 */
import type { IntegrationConnectionPin, IntegrationUnavailableReason } from "@shared/contracts";
import { recordedPinFor } from "./recorded-pins.js";
import { withKnownSecretsRedacted } from "./publication-redaction.js";

const NOTIFICATION_WITHHELD =
  "the secrets to redact this notification with could not be read, so it was not sent";
import { ticketUrlFor } from "./ticket-url.js";
import type {
  MessageRetrievalFailure,
  MessageSearchOutcome,
  MessageSearchQuery,
  MessagingDelivery,
  MessagingSender,
  MessagingTicket,
  TicketEvent,
} from "@integrations/sdk";

export { ticketUrlFor };

/** Comfortably under the 300 s a plain function is killed at. */
const MESSAGING_TIMEOUT_MS = 30_000;

/**
 * Why nothing went out, in a sentence a person reads in a block's output and
 * in the run trace. It names a capability rather than a provider, because the
 * deployment with no provider is exactly the one that cannot be told to go and
 * look at one.
 */
const NO_PROVIDER =
  "no messaging provider is connected on this deployment, so there was nowhere to send it";

/**
 * The sender core uses everywhere.
 *
 * Never throws: a notification must not be able to change a run's outcome.
 * Callers that are a block read the answer; callers that merely report ignore
 * it, and the warning in the log is the record either way.
 */
export function messagingSender(pins?: readonly IntegrationConnectionPin[]): CoreMessagingSender {
  return {
    async notifyForTicket(ticketKey: string, event: TicketEvent): Promise<MessagingDelivery> {
      const resolved = await activeMessaging(pins);
      if (!resolved.ok) {
        const { logger } = await import("../../infra/logger.js");
        logger.warn(
          { ticketKey, kind: event.kind, reason: resolved.reason },
          "messaging_notification_dropped",
        );
        return {
          delivered: false,
          reason: resolved.reason,
          ...(resolved.moved ? { moved: resolved.moved } : {}),
        };
      }
      // Redacted with every secret the deployment knows before it leaves: a
      // failure reason carries whatever an agent printed, and the environment
      // half workflow scope applied misses a key an admin stored in the
      // dashboard (`publication-redaction.ts`). A set that cannot be read sends
      // nothing, and says so, because this never throws.
      let safeEvent: TicketEvent;
      try {
        safeEvent = await withKnownSecretsRedacted(event);
      } catch (error) {
        const { logger } = await import("../../infra/logger.js");
        logger.warn(
          { ticketKey, kind: event.kind, err: error instanceof Error ? error.message : String(error) },
          "messaging_notification_withheld",
        );
        return { delivered: false, reason: NOTIFICATION_WITHHELD };
      }
      const { conversationFor } = await import("./messaging-conversation.js");
      try {
        return await resolved.adapter.notifyForTicket(
          await ticketRef(ticketKey),
          safeEvent,
          await conversationFor(ticketKey),
        );
      } catch (error) {
        // The port promises not to throw. A provider that does anyway is a bug
        // in that provider, not a reason to fail somebody's run.
        const { logger } = await import("../../infra/logger.js");
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn({ ticketKey, kind: event.kind, reason }, "messaging_notification_threw");
        return { delivered: false, reason: `${resolved.name} failed to send it: ${reason}` };
      }
    },

    async searchMessages(query: MessageSearchQuery): Promise<MessageSearchOutcome> {
      const resolved = await activeMessaging(pins);
      if (!resolved.ok) return { ok: false, reason: resolved.retrieval };
      if (!resolved.adapter.searchMessages) return { ok: false, reason: "unsupported" };
      try {
        return await resolved.adapter.searchMessages(query);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}

/**
 * What a delivery says when the provider this run pinned moved under it.
 *
 * Core's own widening of the port's answer: the port promises `delivered` and
 * a reason, and core adds the one fact only core can know, which is whether
 * the run may still use this provider at all. A block stops the run on it; a
 * notification ignores it like any other failure.
 */
export type CoreMessagingDelivery =
  | { readonly delivered: true }
  | {
      readonly delivered: false;
      readonly reason: string;
      readonly moved?: IntegrationUnavailableReason;
    };

export interface CoreMessagingSender extends MessagingSender {
  notifyForTicket(ticketKey: string, event: TicketEvent): Promise<CoreMessagingDelivery>;
}

type ResolvedMessaging =
  | {
      readonly ok: true;
      readonly name: string;
      readonly adapter: import("@integrations/sdk").MessagingAdapter;
    }
  | {
      readonly ok: false;
      /** The sentence a person reads in a block's output and in the log. */
      readonly reason: string;
      /**
       * Set only when the provider this run pinned moved under it. A caller
       * that is a block stops the run with this; a caller that merely notifies
       * ignores it, exactly as it ignores every other delivery failure.
       */
      readonly moved?: IntegrationUnavailableReason;
      /**
       * The same fact in the search port's vocabulary. A reader that only ever
       * heard "not connected" would tell somebody to connect a provider that is
       * connected, because settings we could not read look identical from here.
       */
      readonly retrieval: MessageRetrievalFailure;
    };

/**
 * The one integration serving `messaging` on this deployment, with its
 * connection resolved and its own context.
 *
 * Several usable providers with nobody chosen is a refusal by name, never a
 * silent pick of the first: a run that posted into one of two connected
 * workspaces because it happened to be first in the registry is the failure an
 * admin cannot explain afterwards. The editor refuses the same case with the
 * same shape (`integration-availability.ts`), so the palette and the run agree.
 */
async function activeMessaging(
  pins?: readonly IntegrationConnectionPin[],
): Promise<ResolvedMessaging> {
  const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");
  const resolved = await resolveUsableIntegrations({
    signal: AbortSignal.timeout(MESSAGING_TIMEOUT_MS),
    filter: (manifest) => manifest.capabilities.includes("messaging"),
  });
  // Settings we could not read are not a deployment with nothing connected.
  // Telling an admin to go and connect a provider they connected months ago
  // sends them to the wrong page for a database that was briefly away.
  if (!resolved.readable) {
    return {
      ok: false,
      reason: `this deployment's integration settings could not be read, so nothing was sent (${resolved.reason})`,
      retrieval: "unavailable",
    };
  }
  const usable = resolved.usable;
  if (usable.length === 0) return { ok: false, reason: NO_PROVIDER, retrieval: "not_connected" };
  if (usable.length > 1) {
    const names = usable.map((entry) => entry.manifest.name).join(" and ");
    return {
      ok: false,
      reason: `${names} both provide messaging on this deployment and no active provider is selected, so nothing was sent`,
      // Not "nothing is connected": two are, and an investigation that said so
      // would send somebody to connect a third.
      retrieval: "unavailable",
    };
  }
  const [only] = usable;
  if (!only) return { ok: false, reason: NO_PROVIDER, retrieval: "not_connected" };
  // A run pinned the provider it started with. Following a live change instead
  // would move where a workflow posts, mid-run, with nobody told. A provider
  // the run's pins do not name arrived after it started, which is the silent
  // switch the pin exists to prevent (`recorded-pins.ts`); a run started
  // before pins existed carries none and behaves as it always did.
  const recorded = recordedPinFor(pins, only.manifest.id, "one_per_deployment");
  if (recorded.kind !== "not_pinned") {
    const { checkIntegrationPin } = await import("../../services/integrations/runtime.js");
    const state = resolved.states.get(only.manifest.id);
    const check =
      recorded.kind === "pinned" && state
        ? checkIntegrationPin(recorded.pin, state)
        : ({ ok: false, reason: "disconnected" } as const);
    if (!check.ok) {
      return {
        ok: false,
        reason: pinnedProviderMovedReason(check.reason, only.manifest.name),
        retrieval: "unavailable",
        moved: check.reason,
      };
    }
  }
  const factory = only.runtime.capabilities.messaging;
  if (typeof factory !== "function") {
    return {
      ok: false,
      reason: `${only.manifest.name} declares messaging and ships no code for it`,
      retrieval: "unsupported",
    };
  }
  return {
    ok: true,
    name: only.manifest.name,
    adapter: (factory as (ctx: unknown) => import("@integrations/sdk").MessagingAdapter)(only.ctx),
  };
}

/**
 * The ticket as the provider needs it. The link is dropped rather than guessed
 * for a subject that is not a tracker key: synthesized identifiers (a webhook
 * delivery, a schedule occurrence, a pull request with no ticket) have no page
 * on the tracker, and `/browse/<that>` is always a 404.
 */
async function ticketRef(ticketKey: string): Promise<MessagingTicket> {
  // Where a person opens the ticket, asked of whichever integration serves the
  // issue tracker capability. A deployment with none answers an empty site and
  // the message carries no link, which is right: a message about a ticket is
  // still worth sending, and a link to nowhere is not.
  const { resolveActiveIssueTracker } = await import("./issue-tracker-runtime.js");
  const tracker = await resolveActiveIssueTracker();
  return {
    key: ticketKey,
    url: tracker.ok ? ticketUrlFor(ticketKey, tracker.wiring.baseUrl) : null,
  };
}

/** Why the provider this run pinned is not the one it may use now. */
function pinnedProviderMovedReason(
  reason: IntegrationUnavailableReason,
  name: string,
): string {
  if (reason === "disabled") return `${name} was disabled after this run started`;
  if (reason === "disconnected") return `${name} was disconnected after this run started`;
  return `${name}'s configuration changed after this run started`;
}
