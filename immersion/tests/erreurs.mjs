// Ouvre la page et imprime ce que la console et WebGL disent pendant le chargement — pour trouver un
// programme de matière qui ne compile pas, ou une erreur avant « Cliquer pour entrer ».
//   BASE=http://localhost:5198 node erreurs.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:5198";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(fs.existsSync("/tmp/immersion-state.json") ? { storageState: "/tmp/immersion-state.json" } : {}) });
const page = await context.newPage();
page.on("console", (m) => ["error", "warning"].includes(m.type()) && console.log(`[${m.type()}]`, m.text().slice(0, 1800)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message, String(e.stack).split("\n").slice(0, 6).join("\n")));
await page.goto(`${BASE}/immersion`);
await page.waitForTimeout(Number(process.env.WAIT || 45000));
if (process.env.ENTER !== "0") {
  await page.getByTestId("enter").click().catch((e) => console.log("[clic]", e.message.split("\n")[0]));
  await page.waitForTimeout(8000);
}
console.log("phase :", await page.evaluate(() => window.__immersion?.store.getState().phase), "| prête :", await page.evaluate(() => window.__immersion?.store.getState().sceneReady));
await browser.close();
