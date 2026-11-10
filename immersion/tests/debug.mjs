// Outil de mise au point : ouvre le monde, puis exécute un module qui reçoit la page. node debug.mjs <module.mjs>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const BASE = process.env.BASE || "http://localhost:5198";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(fs.existsSync("/tmp/immersion-state.json") ? { storageState: "/tmp/immersion-state.json" } : {}) });
const page = await context.newPage();
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && !/THREE.Clock|deprecated/.test(m.text()) && console.log(`[${m.type()}]`, m.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message, String(e.stack).split("\n").slice(1, 4).join(" | ")));
await page.addInitScript((q) => localStorage.setItem("laterna:immersion:settings:v2", JSON.stringify({ quality: q })), process.env.QUALITY || "medium");
await page.goto(`${BASE}/immersion`);
await page.getByTestId("enter").waitFor({ state: "visible", timeout: 180_000 });
await page.getByTestId("enter").click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world");
await page.evaluate(() => {
  window.__immersion.panelDebug.skipLockCheck = true;
  window.__immersion.store.getState().setMode("walk");
});
await page.waitForTimeout(1200);
const run = (await import(pathToFileURL(process.argv[2]).href)).default;
try {
  await run(page);
} catch (e) {
  console.log("ÉCHEC", String(e).slice(0, 600));
}
await browser.close();
