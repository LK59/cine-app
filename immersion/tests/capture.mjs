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
  // Le dehors : au pied de la baie, puis par une fenêtre ouest.
  vallee: { x: 0.3, z: -5.6, yaw: 0.05, pitch: 0.02 },
  ouest: { x: -3.6, z: -3.2, yaw: 1.35, pitch: 0.02 },
  canape: { x: -1.08, z: -1.5, yaw: -Math.PI / 2, pitch: 0.06, seated: true },
  charpente: { x: 3.4, z: 2.2, yaw: 0.85, pitch: 0.62 },
  retour: { x: 2.6, z: -5.2, yaw: 2.55, pitch: 0.05 },
  // Les autres pièces.
  cuisine: { x: -2.6, z: 5.0, yaw: -2.2, pitch: -0.05 },
  ilot: { x: 1.3, z: 4.6, yaw: Math.PI, pitch: -0.12 },
  escalier: { x: -3.2, z: 4.4, yaw: 2.6, pitch: 0.1 },
  mezzanine: { x: -2.5, z: 8.6, y: 2.9, yaw: -0.9, pitch: -0.12 },
  balcon: { x: 0.5, z: 4.7, y: 2.9, yaw: 0.1, pitch: -0.28 },
  couloir: { x: -4.6, z: 10.9, yaw: -Math.PI / 2, pitch: 0 },
  chambre: { x: -0.2, z: 12.9, yaw: 1.05, pitch: -0.06 },
  lit: { x: -2.4, z: 16.0, yaw: -0.5, pitch: -0.08 },
  // La terrasse et son bain, la baie vue du dehors, le foyer et le chat, la chaîne hi-fi.
  // Au garde-corps, le regard plongeant vers la vallée.
  vue: { x: -1.2, z: -11.3, yaw: 0.05, pitch: -0.2 },
  terrasse: { x: -2.6, z: -10.6, yaw: -2.1, pitch: -0.08 },
  bain: { x: 1.4, z: -8.3, yaw: -2.2, pitch: -0.22 },
  dehors: { x: -3.8, z: -11.0, yaw: Math.PI + 0.35, pitch: 0.12 },
  foyer: { x: 1.9, z: -0.3, yaw: -Math.PI / 2 - 0.25, pitch: -0.2 },
  // Le plaid et les coussins, de près.
  plaid: { x: -0.9, z: -2.3, yaw: 1.25, pitch: -0.42 },
  coussins: { x: -0.4, z: -0.6, yaw: 0.9, pitch: -0.35 },
  chat: { x: 2.3, z: -1.0, yaw: -Math.PI / 2 - 0.55, pitch: -0.5 },
  hifi: { x: -3.6, z: -0.1, yaw: Math.PI / 2, pitch: -0.25 },
  porte: { x: -0.6, z: -4.6, yaw: 0.05, pitch: -0.02 },
  // La télévision de la chambre, vue du pied du lit.
  telechambre: { x: -2.9, z: 14.3, yaw: -Math.PI / 2, pitch: 0.02 },
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
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 90_000 });
await page.evaluate(() => window.__immersion.store.getState().setMode("walk"));

// TV=1 : une mire joue sur l'écran pendant les captures (image, halo, ambilight).
if (process.env.TV) {
  await page.evaluate(() => window.__immersion.playTestClip("/api/immersion/mire.webm"));
  await page.waitForFunction(() => window.__immersion.store.getState().playback.status === "playing", null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

for (const name of wanted) {
  // Une vue libre : « nom=x,z,lacet,tangage[,y] » (par exemple dehors-est=7,13,1.57,0).
  const free = /^([a-z0-9-]+)=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?$/.exec(name);
  const view = free ? { x: Number(free[2]), z: Number(free[3]), yaw: Number(free[4]), pitch: Number(free[5]), y: Number(free[6] || 0) } : VIEWS[name];
  if (!view) continue;
  const file = free ? free[1] : name;
  await page.evaluate((v) => {
    const { rig, store } = window.__immersion;
    const target = rig.position.clone();
    target.set(v.x, v.y || 0, v.z);
    rig.teleport = target;
    rig.yaw = v.yaw;
    rig.pitch = v.pitch;
    store.getState().setSeated(!!v.seated);
  }, view);
  await page.waitForTimeout(view.seated ? 2600 : 1200);
  // Sans l'interface : seulement le monde.
  await page.addStyleTag({ content: ".reticle,.hints{display:none!important}" });
  await page.screenshot({ path: `${OUT}/${file}.jpg`, type: "jpeg", quality: 85 });
  console.log(`capture ${file}`);
}

// ── L'affiche : `affiche`, avec SIZE=1000x1500 — écrite dans public/poster.jpg ──────────────────
// La carte « Le Chalet » de la recherche montre cette image : le vrai chalet, la nuit, la neige, un
// écran allumé, et le titre posé dessus comme sur une affiche de film.
if (wanted.includes("affiche")) {
  // L'affiche montre la pièce éclairée : le mode cinéma (qui baisserait les lampes dès que l'écran s'allume) est coupé.
  await page.evaluate(() => window.__immersion.store.getState().updateSettings({ cinema: false }));
  await page.evaluate(async () => {
    // Sur l'écran : un plan de film inventé — un crépuscule —, pas la mire.
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 536;
    const c = canvas.getContext("2d");
    const paint = () => {
      const sky = c.createLinearGradient(0, 0, 0, 536);
      sky.addColorStop(0, "#1b2a55");
      sky.addColorStop(0.55, "#c9683c");
      sky.addColorStop(0.62, "#ffd08a");
      sky.addColorStop(0.64, "#1a1420");
      sky.addColorStop(1, "#07060a");
      c.fillStyle = sky;
      c.fillRect(0, 0, 1280, 536);
      const sun = c.createRadialGradient(820, 330, 0, 820, 330, 260);
      sun.addColorStop(0, "rgba(255,236,190,0.95)");
      sun.addColorStop(0.15, "rgba(255,190,110,0.55)");
      sun.addColorStop(1, "rgba(255,150,80,0)");
      c.fillStyle = sun;
      c.fillRect(0, 0, 1280, 536);
    };
    paint();
    setInterval(paint, 100);
    await window.__immersion.playTestClip(canvas.captureStream(15));
  });
  await page.waitForFunction(() => window.__immersion.store.getState().playback.status === "playing", null, { timeout: 30_000 });
  const view = { x: -2.5, z: 3.6, yaw: -0.6, pitch: 0.2 };
  await page.evaluate((v) => {
    const { rig, store } = window.__immersion;
    const target = rig.position.clone();
    target.set(v.x, 0, v.z);
    rig.teleport = target;
    rig.yaw = v.yaw;
    rig.pitch = v.pitch;
    store.getState().setSeated(false);
  }, view);
  await page.waitForTimeout(3500);
  await page.addStyleTag({
    content: `.reticle,.hints,.hud,.fps{display:none!important}
      .affiche{position:fixed;inset:0;z-index:99;pointer-events:none;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;
        padding:0 0 9%;background:linear-gradient(to bottom,rgba(4,5,10,.5) 0%,rgba(4,5,10,0) 16%,rgba(4,5,10,0) 52%,rgba(4,5,10,.82) 86%,rgba(4,5,10,.95) 100%);
        font-family:Outfit,Inter,sans-serif;color:#f6efe4;text-align:center}
      .affiche b{font-weight:300;font-size:11.4vw;letter-spacing:.2em;margin-right:-.2em;line-height:1;text-shadow:0 2px 30px rgba(0,0,0,.6)}
      .affiche i{font-style:normal;font-weight:500;font-size:2.5vw;letter-spacing:.52em;margin-right:-.52em;margin-top:3.2vw;opacity:.72;text-transform:uppercase}`,
  });
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.className = "affiche";
    overlay.innerHTML = "<b>LE CHALET</b><i>Laterna Experience</i>";
    document.body.appendChild(overlay);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/immersion/public/poster.jpg", type: "jpeg", quality: 86 });
  await page.screenshot({ path: `${OUT}/affiche.jpg`, type: "jpeg", quality: 86 });
  console.log("capture affiche → public/poster.jpg");
  await page.evaluate(() => {
    document.querySelector(".affiche")?.remove();
    window.__immersion.dispatch({ type: "stop" });
  });
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
