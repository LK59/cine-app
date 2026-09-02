const { version } = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Lets the development stack compile into its own directory (see docker-compose.dev.yml), so a
  // `next dev` running against the working tree and a production image build never overwrite each
  // other's output.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  reactStrictMode: true,
  // sharp is externalized by Next.js by default; web-push needs to be added explicitly.
  serverExternalPackages: ["web-push"],
  images: {
    remotePatterns: [{ hostname: "**" }],
    // Next.js 16 defaults local image patterns to an empty query string;
    // our Jellyfin image proxy passes itemId/tag as query params.
    localPatterns: [{ pathname: "/api/jellyfin/image" }],
    // Every image the optimizer produces is written under .next/cache/images and re-served from
    // there — but only until its TTL expires, which defaults to 60s. On a self-hosted box that
    // means the server re-encodes the same posters all day long (and, on the Cinema grid, several
    // hundred of them at once while scrolling). Poster/backdrop URLs are content-addressed
    // upstream, so a new artwork is a new URL, never a stale cache entry: a year is safe.
    minimumCacheTTL: 31536000,
  },
  env: {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
    NEXT_PUBLIC_CLARA_GALLERY_ENABLED: process.env.CLARA_GALLERY_ENABLED ?? "true",
    NEXT_PUBLIC_APP_VERSION: version,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
