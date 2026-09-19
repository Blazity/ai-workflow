/**
 * The pages integrations contribute to the dashboard.
 *
 * Separate from the root entry because it is a different bundle: these are
 * React components, and the root entry is read inside the Workflow DevKit's
 * flow bundle and by the worker, neither of which has React in it. The
 * boundaries gate states both halves of that.
 *
 * Two levels, and the split is deliberate. Which page ids an integration serves
 * is data and answering that question loads nothing; the module behind them is
 * loaded only when one of its pages is rendered. A static import would run the
 * top level of every shipped integration on the first load of any integration
 * route, whether or not that integration is connected.
 *
 * `dashboard.generated.ts` is written by `pnpm run gen:integrations`. Nothing
 * here is edited by hand, and nothing here knows an id: a lookup takes the id
 * its caller already holds, which on this path is the one in the URL.
 */
import type { IntegrationPageComponent } from "@integrations/host-ui";
import { generatedIntegrationDashboards } from "./dashboard.generated";

/**
 * The page ids one integration contributes, empty when it contributes none.
 * Reading this runs no integration code.
 */
export function integrationDashboardPages(id: string): readonly string[] {
  return generatedIntegrationDashboards[id]?.pages ?? [];
}

/**
 * One contributed page, loading that integration's module for the first time.
 *
 * Absent for three different reasons the caller has to tell apart: this build
 * ships no such integration, the integration ships no page under that id, or
 * the id came from a URL somebody typed. The caller holds the manifest and can
 * say which, so this answers the narrow question and nothing more.
 */
export async function loadIntegrationPage(
  id: string,
  pageId: string,
): Promise<IntegrationPageComponent | undefined> {
  const entry = generatedIntegrationDashboards[id];
  if (!entry || !entry.pages.includes(pageId)) return undefined;
  const module = await entry.load();
  return module.dashboard.pages[pageId];
}
