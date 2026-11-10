// Le banc de rendu, sur la carte graphique de la machine (voir capture.sh : /dev/dri → ANGLE gl-egl).
//
//   SCRIPT=perf.mjs SIZE=1280x614 QUALITY=ultra tests/capture.sh [vue…]
//
// Pour chaque vue : les images par seconde et le temps d'image (moyen, 1 % le plus lent), écrans éteints,
// vidéo en lecture, vidéo en pause — puis, vidéo en lecture, chaque variante (ce qu'on coupe pour savoir
// ce que ça coûte). VARIANTS=nom,nom limite la liste (« aucune » : pas de variantes) ; SECONDS règle la
// durée d'une mesure ; TREE=1 imprime l'arbre de la scène et ses appels de dessin.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:5198";
const QUALITY = process.env.QUALITY || "ultra";
const [W, H] = (process.env.SIZE || "1280x614").split("x").map(Number);
const SECONDS = Number(process.env.SECONDS || 6);
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const VIEWS = {
  canape: { x: -1.08, z: -1.5, yaw: -Math.PI / 2, pitch: 0.06, seated: true },
  entree: { x: -1.2, z: 3.1, yaw: -0.32, pitch: 0.04 },
  baie: { x: 1.4, z: 1.2, yaw: 0.12, pitch: 0.22 },
  cuisine: { x: -2.6, z: 5.0, yaw: -2.2, pitch: -0.05 },
  chambre: { x: -0.2, z: 12.9, yaw: 1.05, pitch: -0.06 },
  terrasse: { x: -2.6, z: -10.6, yaw: -2.1, pitch: -0.08 },
};

// Chaque variante : ce qu'elle change dans la page, et comment le défaire.
const VARIANTS = {
  "sans passe vidéo": ["h.perf.overlay = false", "h.perf.overlay = true"],
  "sans lumière des écrans": ["h.perf.screenLight = false", "h.perf.screenLight = true"],
  "sans copie réduite": ["h.perf.sample = false", "h.perf.sample = true"],
  "sans halo": ["h.store.getState().setPerfProfile({ bloom: false })", "h.store.getState().setPerfProfile(null)"],
  "sans anticrénelage": ["h.store.getState().setPerfProfile({ smaa: false })", "h.store.getState().setPerfProfile(null)"],
  "sans neige": ["h.store.getState().setPerfProfile({ snow: 0 })", "h.store.getState().setPerfProfile(null)"],
  "échelle 0,8": ["h.store.getState().setPerfProfile({ scale: 0.8 })", "h.store.getState().setPerfProfile(null)"],
  "sans transparents": [
    "h.scene.traverse((o) => { if (o.isMesh && o.material && o.material.transparent && o.visible) { o.visible = false; o.userData.perfHidden = true; } })",
    "h.scene.traverse((o) => { if (o.userData.perfHidden) { o.visible = true; delete o.userData.perfHidden; } })",
  ],
  ...Object.fromEntries(
    (process.env.HIDE || "").split(",").filter(Boolean).map((name) => [
      `sans « ${name} »`,
      [`h.scene.traverse((o) => { if (o.name === ${JSON.stringify(name)}) o.visible = false; })`, `h.scene.traverse((o) => { if (o.name === ${JSON.stringify(name)}) o.visible = true; })`],
    ])
  ),
};

const wantedViews = process.argv.slice(2).length ? process.argv.slice(2) : ["canape"];
const wantedVariants = process.env.VARIANTS === "aucune" ? [] : process.env.VARIANTS ? process.env.VARIANTS.split(",") : Object.keys(VARIANTS);

const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"] });
const context = await browser.newContext({ viewport: { width: W, height: H } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.addInitScript((quality) => {
  try {
    const key = "laterna:immersion:settings:v2";
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || "{}"), quality }));
  } catch {}
}, QUALITY);
await page.goto(`${BASE}/immersion`);
const enter = page.getByTestId("enter");
await enter.waitFor({ state: "visible", timeout: 240_000 });
await enter.click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 90_000 });
await page.evaluate(() => window.__immersion.store.getState().setMode("walk"));
console.log(await page.evaluate(() => {
  const g = window.__immersion.gl.getContext();
  const ext = g.getExtension("WEBGL_debug_renderer_info");
  const size = window.__immersion.gl.getDrawingBufferSize({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } });
  return `${ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?"} — rendu ${size.x}×${size.y}`;
}), `— ${QUALITY}`);

const measure = (seconds) =>
  page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const frames = [];
        let last = 0;
        const start = performance.now();
        const tick = (now) => {
          if (last) frames.push(now - last);
          last = now;
          if (now - start < ms) requestAnimationFrame(tick);
          else {
            frames.sort((a, b) => b - a);
            const total = frames.reduce((s, f) => s + f, 0);
            const slow = frames.slice(0, Math.max(1, Math.round(frames.length / 100)));
            resolve({ fps: (frames.length / total) * 1000, ms: total / frames.length, low: slow.reduce((s, f) => s + f, 0) / slow.length, max: frames[0] });
          }
        };
        requestAnimationFrame(tick);
      }),
    seconds * 1000
  );
const line = (label, r, ref) => console.log(`  ${label.padEnd(28)} ${r.fps.toFixed(1).padStart(6)} i/s   ${r.ms.toFixed(1).padStart(6)} ms   1 % lent ${r.low.toFixed(0).padStart(4)} ms   pire ${r.max.toFixed(0).padStart(4)} ms${ref ? `   ${(r.ms - ref.ms >= 0 ? "+" : "") + (r.ms - ref.ms).toFixed(1)} ms` : ""}`);
const run = (code) => page.evaluate(`(() => { const h = window.__immersion; ${code}; })()`);

// Les appels de dessin et les triangles d'une image (toutes passes confondues).
const drawInfo = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const info = window.__immersion.gl.info;
        info.autoReset = false;
        info.reset();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const r = { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0, textures: info.memory.textures, geometries: info.memory.geometries };
            info.autoReset = true;
            resolve(r);
          })
        );
      })
  );

if (process.env.TREE) {
  const tree = await page.evaluate(() => {
    const out = [];
    const count = (o) => { let meshes = 0; let tris = 0; o.traverse((c) => { if (c.isMesh || c.isPoints || c.isInstancedMesh) { meshes++; const g = c.geometry; const n = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0; tris += (n / 3) * (c.isInstancedMesh ? c.count : 1); } }); return [meshes, Math.round(tris)]; };
    const walk = (o, depth) => {
      if (depth > 3) return;
      const [meshes, tris] = count(o);
      if (meshes) out.push(`${"  ".repeat(depth)}${o.name || o.type} — ${meshes} objets, ${tris} triangles`);
      for (const c of o.children) if (!c.isMesh || c.name) walk(c, depth + 1);
    };
    walk(window.__immersion.scene, 0);
    return out.join("\n");
  });
  console.log(tree);
}

for (const name of wantedViews) {
  const view = VIEWS[name];
  if (!view) continue;
  await page.evaluate((v) => {
    const { rig, store } = window.__immersion;
    const target = rig.position.clone();
    target.set(v.x, v.y || 0, v.z);
    rig.teleport = target;
    rig.yaw = v.yaw;
    rig.pitch = v.pitch;
    store.getState().setSeated(!!v.seated);
  }, view);
  await page.waitForTimeout(3000);
  const info = await drawInfo();
  console.log(`\n${name} — ${info.calls} appels de dessin, ${info.triangles} triangles, ${info.programs} programmes, ${info.textures} textures`);
  await run("h.dispatch({ type: 'stop' })");
  await page.waitForTimeout(1500);
  const off = await measure(SECONDS);
  line("écrans éteints", off);
  await page.evaluate(() => window.__immersion.playTestClip("/api/immersion/mire.webm"));
  await page.waitForFunction(() => window.__immersion.store.getState().playback.status === "playing", null, { timeout: 30_000 });
  await page.waitForTimeout(3500);
  const playing = await measure(SECONDS);
  line("vidéo en lecture", playing, off);
  for (const variant of wantedVariants) {
    if (!VARIANTS[variant]) continue;
    await run(VARIANTS[variant][0]);
    await page.waitForTimeout(2500);
    line(`· ${variant}`, await measure(SECONDS), playing);
    await run(VARIANTS[variant][1]);
    await page.waitForTimeout(1200);
  }
  await run("h.dispatch({ type: 'pause' })");
  await page.waitForTimeout(2000);
  line("vidéo en pause", await measure(SECONDS), off);
  await run("h.dispatch({ type: 'stop' })");
}
await browser.close();
