import type { NextConfig } from "next";

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
  transpilePackages: ["@workeasy/ui", "@workeasy/form-engine", "@workeasy/form-renderer", "@workeasy/form-schema"],
  async rewrites() {
    // Respondent API calls stay same-origin; the public routes take no cookies.
    return [{ source: "/public/:path*", destination: `${apiInternalUrl}/public/:path*` }];
  },
  async headers() {
    // Published forms may be embedded on any site (docs/06 §3); nothing else may be framed.
    return [
      { source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
      {
        // Everything except form pages.
        source: "/((?!f/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      { source: "/f/:slug", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }] },
    ];
  },
};

export default nextConfig;
