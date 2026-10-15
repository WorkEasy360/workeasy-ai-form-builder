import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Dev only: with browser-log forwarding on, every page load writes to
  // .next/dev/logs, which the monorepo-wide watcher picks up and turns into
  // a reload, so the page reloads forever. Browser logs stay in the browser.
  logging: { browserToTerminal: false },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@workeasy/ui"],
};

export default nextConfig;
