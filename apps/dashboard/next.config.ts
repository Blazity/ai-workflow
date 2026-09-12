import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * The Repository scripts screen became a tab inside a repository entry, so
   * `/scripts` is gone. A permanent redirect rather than a deleted route: the
   * path is in bookmarks, in Slack messages the worker posted and in the
   * workflow editor's older block panels, and a 404 there teaches nothing.
   */
  async redirects() {
    return [{ source: "/scripts", destination: "/repositories", permanent: true }];
  },
};

export default nextConfig;
