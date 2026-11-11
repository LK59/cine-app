// Imprime ce que renvoie EXPR, évaluée dans la page une fois le monde ouvert (h = window.__immersion).
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://localhost:5198";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 614 } })).newPage();
await page.addInitScript((quality) => localStorage.setItem("laterna:immersion:settings:v2", JSON.stringify({ quality })), process.env.QUALITY || "ultra");
await page.goto(`${BASE}/immersion`);
const enter = page.getByTestId("enter");
await enter.waitFor({ state: "visible", timeout: 240_000 });
await enter.click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 90_000 });
await page.waitForTimeout(3000);
console.log(await page.evaluate(`(() => { const h = window.__immersion; ${process.env.PREP}; })()`));
await browser.close();
