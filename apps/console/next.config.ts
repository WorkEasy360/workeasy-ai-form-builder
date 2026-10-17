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
  async headers() {
    // The console is never framed (clickjacking), and never sends its URLs,
    // which can hold invitation tokens, to other sites. HSTS is set by the
    // TLS-terminating proxy in production.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
