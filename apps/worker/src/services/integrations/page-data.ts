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
import type { JsonValue } from "@shared/contracts";

/** Bounded well under the invocation ceiling; a page is a person waiting. */
const PAGE_READ_TIMEOUT_MS = 20_000;

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
  const runtime = integrationRuntime(integrationId);
  const reader = runtime?.api?.[pageId];
  if (typeof reader !== "function") return { status: "none" };

  const { usableIntegrations } = await import("./usable.js");
  const [usable] = await usableIntegrations({
    signal: AbortSignal.timeout(PAGE_READ_TIMEOUT_MS),
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

  const { redactIntegrationText, secretValuesOf } = await import("./connection-values.js");
  try {
    const value = await (reader as (context: typeof usable.ctx) => Promise<JsonValue>)(usable.ctx);
    return { status: "ok", value };
  } catch (error) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { integration: integrationId, page: pageId },
      "integration_page_data_failed",
    );
    // A provider that echoes a credential in an error body is normal, and that
    // body is what a person reads on a screen.
    const secrets = secretValuesOf(manifest, usable.ctx.connection as never);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      cause: "provider",
      reason: redactIntegrationText(message, secrets).slice(0, 300),
    };
  }
}
