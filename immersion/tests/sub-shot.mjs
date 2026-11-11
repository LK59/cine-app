// Une capture des sous-titres sur l'écran du salon, l'application jouée par des réponses écrites à la main.
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://localhost:5198";
const OUT = process.env.CAPTURES || "/immersion/captures";
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await page.route(/\/api\/(?!immersion\/)/, (route) => route.fulfill({ status: 502, body: "" }));
await page.route("**/api/jellyfin/playback/start", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      playSessionId: "s", mediaSourceId: "m", manifestUrl: "/api/immersion/mire.webm", isDirectPlay: true, title: "Film d'essai",
      playbackInfo: { playMethod: "DirectPlay", transcodeReasons: [], video: { codec: "vp9", width: 1280, height: 720, rangeType: "SDR" }, audio: { codec: "opus", channels: 2 } },
      audioTracks: [{ index: 1, language: "fre", title: null, codec: "ac3", channels: 6, profile: null, isDefault: true }, { index: 2, language: "eng", title: null, codec: "truehd", channels: 8, profile: null, isDefault: false }],
      subtitleTracks: [{ index: 3, language: "fre", title: null, isDefault: false, isForced: false, isHearingImpaired: false, isExternal: false, url: "/api/jellyfin/stream/subtitle/film?mediaSourceId=m&index=3" }],
    }),
  })
);
await page.route("**/api/jellyfin/stream/subtitle/**", (route) => route.fulfill({ status: 200, contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n— Tu crois qu'il neige encore, là-haut ?\n— Depuis trois jours. On ne redescendra pas ce soir.\n" }));
await page.addInitScript(() => localStorage.setItem("laterna:immersion:settings:v2", JSON.stringify({ quality: "ultra" })));
await page.goto(`${BASE}/immersion`);
const enter = page.getByTestId("enter");
await enter.waitFor({ state: "visible", timeout: 240_000 });
await enter.click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 90_000 });
await page.evaluate(() => {
  const h = window.__immersion;
  h.debug.skipCaptureCheck = true;
  h.store.getState().setMode("walk");
  h.dispatch({ type: "open", item: { id: "film", title: "Film" }, from: 0 });
});
await page.waitForFunction(() => window.__immersion.store.getState().playback.status === "playing", null, { timeout: 30_000 });
await page.evaluate(() => {
  const h = window.__immersion;
  h.dispatch({ type: "subtitle", index: 3 });
  const t = h.rig.position.clone();
  t.set(-1.08, 0, -1.5);
  h.rig.teleport = t;
  h.rig.yaw = -Math.PI / 2;
  h.rig.pitch = 0.1;
  h.store.getState().setSeated(true);
  h.view.zoom = 0.55;
});
await page.waitForTimeout(4000);
await page.addStyleTag({ content: ".reticle,.hints,.hud{display:none!important}" });
await page.screenshot({ path: `${OUT}/sous-titres.jpg`, type: "jpeg", quality: 88 });
await page.evaluate(() => { window.__immersion.view.zoom = 0; window.__immersion.openPanel("salon"); });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/panneau-pistes.jpg`, type: "jpeg", quality: 88 });
await browser.close();
