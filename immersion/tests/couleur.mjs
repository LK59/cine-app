// La vidéo est-elle montrée avec ses vraies couleurs ? Trois aplats de valeur connue sur l'écran du salon,
// vus du canapé, cadrés plein écran ; la capture est relue par le script appelant (ffmpeg).
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://localhost:5198";
const OUT = process.env.CAPTURES || "/immersion/captures";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await page.addInitScript(() => localStorage.setItem("laterna:immersion:settings:v2", JSON.stringify({ quality: "high" })));
await page.goto(`${BASE}/immersion`);
const enter = page.getByTestId("enter");
await enter.waitFor({ state: "visible", timeout: 240_000 });
await enter.click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 90_000 });
await page.evaluate(async () => {
  const h = window.__immersion;
  h.debug.skipCaptureCheck = true;
  h.store.getState().setMode("walk");
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const c = canvas.getContext("2d");
  const paint = () => {
    ["rgb(128,128,128)", "rgb(200,120,90)", "rgb(40,40,40)", "rgb(60,90,200)"].forEach((color, i) => {
      c.fillStyle = color;
      c.fillRect(i * 320, 0, 320, 720);
    });
  };
  paint();
  setInterval(paint, 100);
  await h.playTestClip(canvas.captureStream(15));
  const t = h.rig.position.clone();
  t.set(-1.08, 0, -1.5);
  h.rig.teleport = t;
  h.rig.yaw = -Math.PI / 2;
  h.rig.pitch = 0.11;
  h.store.getState().setSeated(true);
  h.view.zoom = 1;
});
await page.waitForTimeout(5000);
await page.addStyleTag({ content: ".reticle,.hints,.hud{display:none!important}" });
await page.screenshot({ path: `${OUT}/couleur.png`, type: "png" });
await browser.close();
