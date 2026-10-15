import type { NextConfig } from "next";

// Express API that serves /auth and /api. Proxying through the console keeps
// session cookies first-party to the console origin.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Dev only: with browser-log forwarding on, every page load writes to
  // .next/dev/logs, which the monorepo-wide watcher picks up and turns into
  // a reload, so the page reloads forever. Browser logs stay in the browser.
  logging: { browserToTerminal: false },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@workeasy/ui", "@workeasy/builder", "@workeasy/form-engine", "@workeasy/form-renderer", "@workeasy/form-schema"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` },
      { source: "/auth/:path*", destination: `${apiInternalUrl}/auth/:path*` },
    ];
  },
};

export default nextConfig;
