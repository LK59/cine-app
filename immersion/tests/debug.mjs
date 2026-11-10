// Outil de mise au point : ouvre le monde et évalue un script dans la page. node debug.mjs <fichier.js>
import { chromium } from "@playwright/test";
import fs from "node:fs";
const BASE = process.env.BASE || "http://localhost:5198";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[${m.type()}]`, m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${BASE}/immersion`);
await page.getByTestId("enter").waitFor({ state: "visible", timeout: 180_000 });
await page.getByTestId("enter").click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world");
await page.waitForTimeout(1500);
const result = await page.evaluate(fs.readFileSync(process.argv[2], "utf8"));
console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1));
await browser.close();
