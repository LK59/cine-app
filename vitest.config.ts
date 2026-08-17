import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Default to "node" (fast, no fake DOM) for the API/lib tests that make up most of the
    // suite. Component tests opt into jsdom individually via a
    // `// @vitest-environment jsdom` docblock at the top of the file, rather than paying the
    // jsdom setup cost across every test file.
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
