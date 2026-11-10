import { defineConfig } from "@playwright/test";

/**
 * Les scénarios tournent contre une instance jetable de l'application (voir tests/README.md), dans
 * Chromium sans écran. WebGL y est rendu par le processeur graphique de la machine quand il est
 * passé au conteneur (`IMMERSION_GL=egl`), sinon par SwiftShader — lent, mais suffisant.
 */
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../test-results",
  globalSetup: "./global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // Une seule instance, un seul compte de test : pas de parallélisme.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE || "http://localhost:3097",
    storageState: "/tmp/immersion-state.json",
    viewport: { width: 1600, height: 900 },
    // Chromium sans écran n'annonce pas de pointeur fin : on le lui donne, c'est un ordinateur.
    hasTouch: false,
    launchOptions: {
      args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"],
    },
  },
});
