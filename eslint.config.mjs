import nextConfig from "eslint-config-next";

export default [...nextConfig, { ignores: ["public/sw.js"] }];
