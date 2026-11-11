// L'écran de chargement, sur une liaison lente (20 Mb/s) : ce que la barre affiche au fil du temps — elle ne
// doit jamais reculer ni rester longtemps sur le même chiffre — et deux captures.
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://localhost:5198";
const OUT = process.env.CAPTURES || "/immersion/captures";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 30, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
const t0 = Date.now();
await page.goto(`${BASE}/immersion`);
const seen = [];
let shots = 0;
for (;;) {
  const state = await page.evaluate(() => ({ text: document.querySelector(".intro-detail")?.textContent ?? null, gate: !!document.querySelector("[data-testid=enter]"), value: Number(document.querySelector(".intro-bar")?.getAttribute("aria-valuenow") ?? -1) }));
  if (state.gate) break;
  if (state.text) seen.push({ at: (Date.now() - t0) / 1000, ...state });
  if (state.text && ((shots === 0 && seen.length > 8) || (shots === 1 && !state.text.includes("/")))) await page.screenshot({ path: `${OUT}/chargement-${++shots}.jpg`, type: "jpeg", quality: 85 });
  if (Date.now() - t0 > 240_000) break;
  await page.waitForTimeout(400);
}
const values = seen.map((s) => s.value);
const back = values.filter((v, i) => i > 0 && v < values[i - 1]).length;
let longest = 0;
for (let i = 0, from = 0; i < seen.length; i++) {
  if (seen[i].value !== seen[from].value) from = i;
  longest = Math.max(longest, seen[i].at - seen[from].at);
}
console.log(`prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s ; ${seen.length} relevés ; reculs : ${back} ; plus long palier : ${longest.toFixed(1)} s`);
console.log(seen.filter((_, i) => i % Math.ceil(seen.length / 12) === 0).map((s) => `${s.at.toFixed(1)} s « ${s.text} »`).join("\n"));
await browser.close();
