import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Move Next's dev-only indicator off the bottom-left so it doesn't overlap
  // the live-polling toggle pinned to the bottom of the sidebar.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
