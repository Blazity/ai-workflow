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
  /** Not connected or disabled here, or the provider was asked and failed. The reason is for a person. */
  | {
      readonly status: "unavailable";
      readonly cause: "not_connected" | "provider";
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

  const { usableIntegrations } = await import("./usable.js");
  const [usable] = await usableIntegrations({
    lifetime: AbortSignal.timeout(PAGE_READ_TIMEOUT_MS),
    filter: (candidate) => candidate.id === integrationId,
  });
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
  const read = usable.runtime.api?.[pageId] as (context: typeof usable.ctx) => Promise<JsonValue>;
  try {
    const value = await read(usable.ctx);
    return { status: "ok", value };
  } catch (error) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { integration: integrationId, page: pageId },
      "integration_page_data_failed",
    );
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", cause: "provider", reason: message.slice(0, 300) };
  }
}
