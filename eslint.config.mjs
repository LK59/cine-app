import nextConfig from "eslint-config-next";

// .next-dev is the development stack's build output (see docker-compose.dev.yml). Next's own
// config already excludes .next, but not a custom distDir, and linting a few megabytes of
// generated bundles reports errors about code nobody wrote.
const config = [...nextConfig, { ignores: ["public/sw.js", ".next-dev/**"] }];

export default config;
