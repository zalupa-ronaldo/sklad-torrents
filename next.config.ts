import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Production image runs `node server.js` from this trace. The Mac drive-agent
  // is a host process and must not be copied into the panel image.
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [
      "agents/mac-agent/drive.mts",
      "agents/mac-agent/collect.mts",
      "agents/pc-agent/drive.mts",
      "agents/pc-agent/collect.mts",
      "data/**/*",
      ".env",
      ".env.*",
    ],
  },
  // Dev is bound to 0.0.0.0:4317. Browsers that open 127.0.0.1 must be allowed
  // to load /_next dev assets; otherwise the page stays an inert server shell.
  allowedDevOrigins: ["127.0.0.1"],
  // Torrent lists are live qBittorrent state and must not be prerendered.
  cacheComponents: false,
  partialPrefetching: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
