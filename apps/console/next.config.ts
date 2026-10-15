import type { NextConfig } from "next";

// Express API that serves /auth and /api. Proxying through the console keeps
// session cookies first-party to the console origin.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Next 16's dev MCP server records every log line to .next/dev/logs. In this
    // monorepo the repo-wide watcher sees those writes and reloads the page,
    // which logs again: an endless reload loop. Not needed for development.
    mcpServer: false,
  },
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
