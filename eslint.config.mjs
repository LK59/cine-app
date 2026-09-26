import nextConfig from "eslint-config-next";

// .next-dev is the development stack's build output (see docker-compose.dev.yml). Next's own
// config already excludes .next, but not a custom distDir, and linting a few megabytes of
// generated bundles reports errors about code nobody wrote.
// data/ holds the previous builds' bundles too (data/static-previous, kept by server-boot).
const config = [...nextConfig, { ignores: ["public/sw.js", ".next-dev/**", ".claude/**", "src/lib/webcodecs/truehd/truehd-wasm.mjs", "server-boot/*.d.mts", "data/**"] }];

export default config;
