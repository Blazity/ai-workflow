import type { NextConfig } from "next";
import { integrationManifests } from "@integrations/registry";
import { integrationHref } from "./lib/cockpit/navigation";

/**
 * A screen that moved out of core into an integration's area keeps its old
 * path. The integration declares it on the page (`legacyPaths`), because the
 * screen is the integration's now and core does not name it.
 */
function integrationPageRedirects() {
  return integrationManifests.flatMap((manifest) =>
    manifest.pages.flatMap((page) =>
      (page.legacyPaths ?? []).map((source) => ({
        source,
        destination: integrationHref(manifest.id, page.id),
        permanent: true,
      })),
    ),
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Screens that moved, kept working.
   *
   * `/scripts` became a tab inside a repository entry. `/health` and `/users`
   * became tabs of the Settings area, so the sidebar could say what belongs to
   * the product and what belongs to an integration without growing to fifteen
   * flat entries. A screen that moved into an integration's area is declared
   * by that integration (`integrationPageRedirects`).
   *
   * Permanent redirects rather than deleted routes: all of them are in
   * bookmarks, in Slack messages the worker posted, in runbooks and in the
   * workflow editor's older block panels, and a 404 there teaches nothing.
   * Next carries the query string across, and a fragment never reaches the
   * server, so `/health?provider=jira` and `/users?tab=invites#row-7` arrive
   * whole.
   */
  async redirects() {
    return [
      { source: "/scripts", destination: "/repositories", permanent: true },
      { source: "/health", destination: "/settings/health", permanent: true },
      { source: "/users", destination: "/settings/users", permanent: true },
      ...integrationPageRedirects(),
    ];
  },
};

export default nextConfig;
