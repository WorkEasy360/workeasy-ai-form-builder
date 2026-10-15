import type { NextConfig } from "next";

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
  transpilePackages: ["@workeasy/ui"],
};

export default nextConfig;
