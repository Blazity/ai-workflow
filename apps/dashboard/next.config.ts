import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Screens that moved, kept working.
   *
   * `/scripts` became a tab inside a repository entry. `/health` and `/users`
   * became tabs of the Settings area, so the sidebar could say what belongs to
   * the product and what belongs to an integration without growing to fifteen
   * flat entries.
   *
   * `/evals` moved into the area of the integration that serves it, because
   * the screen reads what that integration reports and is its to show.
   *
   * Permanent redirects rather than deleted routes: all four are in bookmarks,
   * in Slack messages the worker posted, in runbooks and in the workflow
   * editor's older block panels, and a 404 there teaches nothing. Next carries
   * the query string across, and a fragment never reaches the server, so
   * `/health?provider=jira` and `/users?tab=invites#row-7` arrive whole.
   */
  async redirects() {
    return [
      { source: "/scripts", destination: "/repositories", permanent: true },
      { source: "/health", destination: "/settings/health", permanent: true },
      { source: "/users", destination: "/settings/users", permanent: true },
      // Evals moved into the area of the integration that grades the runs.
      { source: "/evals", destination: "/integrations/arthur/evals", permanent: true },
    ];
  },
};

export default nextConfig;
