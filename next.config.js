/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // sharp is externalized by Next.js by default; web-push needs to be added explicitly.
  serverExternalPackages: ["web-push"],
  images: {
    remotePatterns: [{ hostname: "**" }],
    // Next.js 16 defaults local image patterns to an empty query string;
    // our Jellyfin image proxy passes itemId/tag as query params.
    localPatterns: [{ pathname: "/api/jellyfin/image" }],
  },
  env: {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
    NEXT_PUBLIC_CLARA_GALLERY_ENABLED: process.env.CLARA_GALLERY_ENABLED ?? "true",
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
