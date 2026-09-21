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
import type {
  MessageRetrievalFailure,
  MessageSearchOutcome,
  MessageSearchQuery,
  MessagingDelivery,
  MessagingSender,
  MessagingTicket,
  TicketEvent,
} from "@integrations/sdk";

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
export function messagingSender(): MessagingSender {
  return {
    async notifyForTicket(ticketKey: string, event: TicketEvent): Promise<MessagingDelivery> {
      const resolved = await activeMessaging();
      if (!resolved.ok) {
        const { logger } = await import("../../infra/logger.js");
        logger.warn(
          { ticketKey, kind: event.kind, reason: resolved.reason },
          "messaging_notification_dropped",
        );
        return { delivered: false, reason: resolved.reason };
      }
      const { conversationFor } = await import("./messaging-conversation.js");
      try {
        return await resolved.adapter.notifyForTicket(
          await ticketRef(ticketKey),
          event,
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
      const resolved = await activeMessaging();
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
async function activeMessaging(): Promise<ResolvedMessaging> {
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
  // The same variable `services/settings` reads for the tracker's base url,
  // read here because the engine may not reach that cluster. It leaves with
  // the tracker in S12.
  const { env } = await import("../../infra/vcs-config.js");
  return { key: ticketKey, url: ticketUrlFor(ticketKey, env.JIRA_BASE_URL) };
}

const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export function ticketUrlFor(ticketKey: string, baseUrl: string): string | null {
  if (!TICKET_KEY_PATTERN.test(ticketKey)) return null;
  const base = baseUrl.replace(/\/$/, "");
  return base === "" ? null : `${base}/browse/${ticketKey}`;
}
