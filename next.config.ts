import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
