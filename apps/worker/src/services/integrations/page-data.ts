/**
 * What one of an integration's own pages reads.
 *
 * A contributed page is a component in the dashboard's process with no session,
 * no database and no client of ours in its props (ADR-010, S7). This is the
 * only way it sees anything: its own package declares a reader, core resolves
 * the connection here and calls it, and the page is handed the JSON it
 * returned.
 *
 * Read only, by construction. There is one reader per page, it takes no
 * arguments beyond the context, and nothing a page does can reach the write
 * surface of a connection.
 */
import { INTEGRATION_PROVIDER_WAIT_MS, type JsonValue } from "@shared/contracts";

/** Bounded well under the invocation ceiling; a page is a person waiting. The
 *  dashboard waits this long plus its own margin, so the one number lives in
 *  the contract both sides read. */
const PAGE_READ_TIMEOUT_MS = INTEGRATION_PROVIDER_WAIT_MS;

export type IntegrationPageDataResult =
  | { readonly status: "ok"; readonly value: JsonValue }
  /** This build ships no such integration, or no such page. */
  | { readonly status: "unknown" }
  /** The page has no reader: a page that shows only what it ships itself. */
  | { readonly status: "none" }
  /**
   * The provider was not asked, or was asked and failed; `reason` is for a
   * person. `worker` is ours: this deployment could not read its own
   * integration settings, so nothing is known about the provider. The causes
   * are the ones the page contract names (`IntegrationPageData` in
   * `@integrations/host-ui`), so a page acts on this one as on a worker that
   * did not answer.
   */
  | {
      readonly status: "unavailable";
      readonly cause: "worker" | "not_connected" | "provider";
      readonly reason: string;
    };

export async function readIntegrationPageData(
  integrationId: string,
  pageId: string,
): Promise<IntegrationPageDataResult> {
  const { integrationManifest } = await import("@integrations/registry");
  const { integrationRuntime } = await import("@integrations/registry/worker");
  const manifest = integrationManifest(integrationId);
  if (!manifest || !manifest.pages.some((page) => page.id === pageId)) {
    return { status: "unknown" };
  }
  // Whether the page has a reader is a fact about the build, answered before
  // any connection is opened: a page without one shows only what it ships,
  // connected or not.
  if (typeof integrationRuntime(integrationId)?.api?.[pageId] !== "function") {
    return { status: "none" };
  }

  // The provider's budget starts once the connection is resolved, not before:
  // a cold database read spent from it cut an 18 second provider off at 20
  // and reported the wait as the provider's. The resolution is bounded by the
  // dashboard's margin above this budget (`PROVIDER_CALL_CEILING_MS`).
  const lifetime = new AbortController();
  const { resolveUsableIntegrations } = await import("./usable.js");
  const resolved = await resolveUsableIntegrations({
    lifetime: lifetime.signal,
    filter: (candidate) => candidate.id === integrationId,
  });
  if (!resolved.readable) {
    // Not "not connected": nobody could look, and sending a person to the
    // Connection tab for a database that was briefly away sends them to fix a
    // connection that works.
    return {
      status: "unavailable",
      cause: "worker",
      reason: `This deployment's integration settings could not be read, so ${manifest.name} was not asked anything. Try again shortly.`,
    };
  }
  const usable = resolved.usable.find((candidate) => candidate.manifest.id === integrationId);
  if (!usable) {
    // The area already says which of the three states applies and offers the
    // Connection tab; this is the same answer in the page's own words.
    return {
      status: "unavailable",
      cause: "not_connected",
      reason: `${manifest.name} is not connected on this deployment, so it has nothing to show yet.`,
    };
  }

  // The usable runtime's reader, not the registry's: what it throws arrives
  // with this connection's secrets already taken out, and a provider that
  // echoes a credential in an error body is normal, while that body is what a
  // person reads on a screen. The boundary wraps every reader the registry's
  // runtime has, so the one found above is here.
  const { ctx } = usable;
  const read = usable.runtime.api?.[pageId] as (context: typeof ctx) => Promise<JsonValue>;
  const budget = setTimeout(
    () => lifetime.abort(new DOMException("The page read ran out of time", "TimeoutError")),
    PAGE_READ_TIMEOUT_MS,
  );
  try {
    const value = await read(ctx);
    return { status: "ok", value };
  } catch (error) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { integration: integrationId, page: pageId },
      "integration_page_data_failed",
    );
    // Our own budget running out reads as the provider not answering, in a
    // sentence, never as the runtime's "The operation was aborted due to
    // timeout".
    if (lifetime.signal.aborted) {
      return {
        status: "unavailable",
        cause: "provider",
        reason: `${manifest.name} did not answer within ${PAGE_READ_TIMEOUT_MS / 1000} seconds.`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", cause: "provider", reason: message.slice(0, 300) };
  } finally {
    clearTimeout(budget);
  }
}
