/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    remotePatterns: [{ hostname: "**" }],
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
  // sharp and web-push are handled outside webpack (runtime install / externals)
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push("sharp");
      config.externals.push("web-push");
    }
    return config;
  },
};

module.exports = nextConfig;
