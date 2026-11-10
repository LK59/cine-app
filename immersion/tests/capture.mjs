// Captures du chalet depuis des points de vue fixes — pour juger le rendu à l'œil.
//
//   node capture.mjs [vue…]        (sans argument : toutes les vues)
//
// BASE : l'adresse de la page (aperçu du build ou instance jetable) ; CAPTURES : le dossier de sortie ;
// QUALITY : le préréglage (low, medium, high, ultra) ; SIZE : « 1600x900 ».
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:5198";
const OUT = process.env.CAPTURES || "/immersion/captures";
const QUALITY = process.env.QUALITY || "high";
const [W, H] = (process.env.SIZE || "1600x900").split("x").map(Number);
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** x, z, lacet, tangage (radians), et éventuellement « assis ». */
export const VIEWS = {
  entree: { x: -1.2, z: 3.1, yaw: -0.32, pitch: 0.04 },
  salon: { x: -3.6, z: 2.6, yaw: -0.75, pitch: 0.1 },
  tv: { x: -0.2, z: -1.5, yaw: -Math.PI / 2, pitch: 0.12 },
  baie: { x: 1.4, z: 1.2, yaw: 0.12, pitch: 0.22 },
  canape: { x: -1.08, z: -1.5, yaw: -Math.PI / 2, pitch: 0.06, seated: true },
  charpente: { x: 3.4, z: 2.2, yaw: 0.85, pitch: 0.62 },
  retour: { x: 2.6, z: -5.2, yaw: 2.55, pitch: 0.05 },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VIEWS);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"],
});
const context = await browser.newContext({ viewport: { width: W, height: H }, ...(fs.existsSync("/tmp/immersion-state.json") ? { storageState: "/tmp/immersion-state.json" } : {}) });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message + "\n" + String(e.stack).split("\n").slice(0, 8).join("\n")));
page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.addInitScript((quality) => {
  try {
    const key = "laterna:immersion:settings:v2";
    const current = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(key, JSON.stringify({ ...current, quality }));
  } catch {}
}, QUALITY);

const t0 = Date.now();
await page.goto(`${BASE}/immersion`);
const enter = page.getByTestId("enter");
await enter.waitFor({ state: "visible", timeout: 180_000 });
console.log(`chargé en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (wanted.includes("accueil")) await page.screenshot({ path: `${OUT}/accueil.jpg`, type: "jpeg", quality: 85 });
await enter.click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 20_000 });
await page.evaluate(() => window.__immersion.store.getState().setMode("walk"));

// TV=1 : une mire joue sur l'écran pendant les captures (image, halo, ambilight).
if (process.env.TV) {
  await page.evaluate(() => window.__immersion.playTestClip("/api/immersion/mire.webm"));
  await page.waitForFunction(() => window.__immersion.store.getState().playback.status === "playing", null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

for (const name of wanted) {
  const view = VIEWS[name];
  if (!view) continue;
  await page.evaluate((v) => {
    const { rig, store } = window.__immersion;
    const target = rig.position.clone();
    target.set(v.x, 0, v.z);
    rig.teleport = target;
    rig.yaw = v.yaw;
    rig.pitch = v.pitch;
    store.getState().setSeated(!!v.seated);
  }, view);
  await page.waitForTimeout(view.seated ? 2600 : 1200);
  // Sans l'interface : seulement le monde.
  await page.addStyleTag({ content: ".reticle,.hints{display:none!important}" });
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 85 });
  console.log(`capture ${name}`);
}

// ── L'interface : le panneau Laterna, une fiche, le menu pause, les réglages ─────────────────────
const ui = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 88 });
  console.log(`capture ${name}`);
};
if (wanted.some((w) => ["panneau", "fiche", "pause", "reglages"].includes(w))) {
  await page.evaluate(() => {
    const { rig, store, debug } = window.__immersion;
    debug.skipCaptureCheck = true;
    const target = rig.position.clone();
    target.set(-0.6, 0, -1.5);
    rig.teleport = target;
    rig.yaw = -Math.PI / 2;
    rig.pitch = 0;
    store.getState().setSeated(false);
  });
  await page.waitForTimeout(900);
  if (wanted.includes("panneau") || wanted.includes("fiche")) {
    await page.evaluate(() => window.__immersion.openPanel());
    await page.getByTestId("panel").waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(2500);
    if (wanted.includes("panneau")) await ui("panneau");
    if (wanted.includes("fiche")) {
      // Un vrai clic de souris, à l'endroit où l'affiche est dessinée (le panneau est en perspective).
      const box = await page.locator(".panel section:nth-of-type(2) .row .poster").first().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
      await page.waitForTimeout(1500);
      await ui("fiche");
    }
    await page.evaluate(() => window.__immersion.closePanel());
  }
  if (wanted.includes("pause") || wanted.includes("reglages")) {
    // L'intention « menu » — ce que vaut Échap : le regard est rendu, le menu pause s'ouvre.
    await page.evaluate(() => window.__immersion.emit("menu"));
    if (wanted.includes("pause")) await ui("pause");
    if (wanted.includes("reglages")) {
      await page.getByTestId("open-settings").click();
      await ui("reglages");
    }
    await page.evaluate(() => window.__immersion.store.getState().setMode("walk"));
  }
}

const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - start < 3000) requestAnimationFrame(tick);
        else resolve(Math.round((frames * 1000) / (performance.now() - start)));
      };
      requestAnimationFrame(tick);
    })
);
console.log(`images par seconde (dernière vue, ${QUALITY}, ${W}x${H}) : ${fps}`);
if (errors.length) console.log("ERREURS CONSOLE:\n" + [...new Set(errors)].slice(0, 12).join("\n"));
await browser.close();
