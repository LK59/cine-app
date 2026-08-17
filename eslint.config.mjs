import nextConfig from "eslint-config-next";

const config = [...nextConfig, { ignores: ["public/sw.js"] }];

export default config;
