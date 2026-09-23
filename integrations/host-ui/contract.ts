import type { ComponentType } from "react";
import type { IntegrationManifest } from "@integrations/sdk";

/**
 * What a contributed page is handed: the id it was asked for, and what its own
 * reader returned. Nothing else.
 *
 * This is a contract, not a sandbox, and the difference matters. A page is a
 * Server Component compiled into the cockpit and run in its process, so it can
 * reach further than its props: the process environment, global `fetch`, its
 * own dependencies. An integration is trusted code, reviewed like ours, and the
 * rules around this seam exist so a page does not couple itself to our runtime
 * by accident, not because they would stop one that meant to.
 *
 * So the props stay narrow on purpose. A page shows what its own package
 * knows; there is no session, no database handle and no worker client in them.
 * The boundaries gate refuses the imports that would fetch those (`next/*`,
 * `node:*` and `server-only` in `dashboard.tsx`, the dashboard's `@/` alias
 * anywhere), and the registry generator refuses a read of the process
 * environment. Widening this is a contract decision, not a convenience, and
 * ADR-010 records where that decision belongs.
 */
export interface IntegrationPageProps {
  /** The integration whose area this page is being rendered in. */
  readonly integrationId: string;
  /**
   * What this page's own reader returned, resolved on the server before the
   * page rendered.
   *
   * This is the one thing a page is given besides its id, and it comes from
   * the integration's own `worker` entry (`runtime.api[pageId]`), through the
   * connection the deployment has: never our database, never our session. The
   * host waits for it, so a page renders once rather than fetching on its own
   * and leaving the cockpit with a spinner it cannot cancel.
   *
   * It is `unknown` because the registry erases a page's types, and the reader
   * that produced it lives in a half of the package the dashboard entry may
   * not import. The page wrote both ends, so it is the one that can read the
   * value back; do it defensively, because a deployment can be a build behind.
   */
  readonly data: IntegrationPageData;
}

/**
 * Three answers, kept apart because a person acts differently on each: the
 * provider answered, the integration declared no reader for this page (a
 * static page, and nothing is wrong), or we could not ask it. Collapsing the
 * last two is how "nothing to show" comes to mean "your provider is down".
 *
 * "Could not ask" has three causes a reader acts on differently, so it says
 * which: our own side could not answer (the worker did not reply, or could not
 * read this deployment's own settings: ours to fix, nothing is known about the
 * provider), the integration is not connected here (an admin connects it), or
 * the provider was asked and failed (its reason, redacted).
 */
export type IntegrationPageData =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "none" }
  | {
      readonly status: "unavailable";
      readonly cause: "worker" | "not_connected" | "provider";
      readonly reason: string;
    };

export type IntegrationPageComponent = ComponentType<IntegrationPageProps>;

/**
 * One component per page the manifest declares, keyed by the page id.
 *
 * The keys are the manifest's literal page ids, so a page declared without a
 * component and a component for a page nobody declared are both refused where
 * the mistake is rather than at the tab that renders nothing.
 */
export type IntegrationDashboardPages<M extends IntegrationManifest> = {
  readonly [PageId in M["pages"][number]["id"]]: IntegrationPageComponent;
};

export interface IntegrationDashboard<M extends IntegrationManifest = IntegrationManifest> {
  readonly pages: IntegrationDashboardPages<M>;
}

/**
 * One integration's pages with their types erased: the page ids of a manifest
 * core does not know statically, with the props kept. The same shape as the
 * SDK's `ErasedIntegrationRuntime` and for the same reason.
 */
export interface ErasedIntegrationDashboard {
  readonly pages: Readonly<Record<string, IntegrationPageComponent>>;
}

/**
 * How the generated registry holds one integration's pages: the ids as data,
 * and the module behind a loader.
 *
 * The split is the point. A static import of every integration's dashboard
 * entry would run the top level of every shipped integration on the first load
 * of any integration route, whether or not that integration is connected, which
 * is not what "an unusable integration's page does not run" means. The ids are
 * what the route needs to decide, and deciding costs no module.
 */
export interface ErasedIntegrationDashboardEntry {
  /** The page ids this integration's entry serves, read without loading it. */
  readonly pages: readonly string[];
  readonly load: () => Promise<{ readonly dashboard: ErasedIntegrationDashboard }>;
}

/**
 * Declares an integration's dashboard pages.
 *
 * Written with the manifest's type rather than its value, so the import that
 * types it erases at build: a dashboard entry that imported `manifest.ts` would
 * pull that manifest's zod schemas into the browser for nothing.
 *
 * ```ts
 * import type { manifest } from "./manifest";
 * export const dashboard = defineIntegrationDashboard<typeof manifest>({
 *   pages: { overview: OverviewPage },
 * });
 * ```
 */
export function defineIntegrationDashboard<M extends IntegrationManifest>(
  dashboard: IntegrationDashboard<M>,
): IntegrationDashboard<M> {
  return dashboard;
}
