// THIS FILE IS GENERATED. DO NOT EDIT.
// Run pnpm run gen:integrations to update.

/**
 * The pages every integration in this build contributes to the dashboard.
 *
 * React components, so this file belongs to the dashboard's bundle and to
 * nothing else: the worker never imports it, and neither does the registry's
 * root entry, which the Workflow DevKit reads inside a flow bundle that has
 * no React in it.
 *
 * An integration appears here only when its manifest declares a page, and
 * its module is loaded only when one of its pages is actually rendered.
 */
import type { ErasedIntegrationDashboardEntry } from "@integrations/host-ui";

type Dashboards = Readonly<Record<string, ErasedIntegrationDashboardEntry>>;

export const generatedIntegrationDashboards: Dashboards = {};
