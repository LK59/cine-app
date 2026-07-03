/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    remotePatterns: [{ hostname: "**" }],
  },
  env: {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
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
