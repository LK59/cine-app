// D'où viennent les à-coups ? Vingt secondes sur une vue : chaque image longue, quand elle tombe, et ce que
// le navigateur en dit (« long-animation-frame » : le script en cause, ou rien — alors c'est la carte graphique).
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://localhost:5198";
const [W, H] = (process.env.SIZE || "1280x614").split("x").map(Number);
const gl = process.env.IMMERSION_GL === "egl" ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
await page.addInitScript((quality) => localStorage.setItem("laterna:immersion:settings:v2", JSON.stringify({ quality })), process.env.QUALITY || "ultra");
await page.goto(`${BASE}/immersion`);
const enter = page.getByTestId("enter");
await enter.waitFor({ state: "visible", timeout: 240_000 });
await enter.click();
await page.waitForFunction(() => window.__immersion.store.getState().phase === "world", null, { timeout: 90_000 });
await page.evaluate(() => {
  const { rig, store } = window.__immersion;
  store.getState().setMode("walk");
  const target = rig.position.clone();
  target.set(-1.08, 0, -1.5);
  rig.teleport = target;
  rig.yaw = -Math.PI / 2;
  rig.pitch = 0.06;
  store.getState().setSeated(true);
});
if (process.env.BISECT) {
  // Une seule page : chaque enfant de la scène est caché tour à tour, et on compte les images longues en 6 s.
  const count = (label) =>
    page.evaluate(
      (name) =>
        new Promise((resolve) => {
          let last = 0;
          let long = 0;
          let frames = 0;
          const start = performance.now();
          const tick = (now) => {
            frames++;
            if (last && now - last > 120) long++;
            last = now;
            if (now - start < 6000) requestAnimationFrame(tick);
            else resolve(`${name.padEnd(44)} ${String(long).padStart(3)} images longues, ${Math.round(frames / 6)} i/s`);
          };
          requestAnimationFrame(tick);
        }),
      label
    );
  await page.waitForTimeout(4000);
  console.log(await count("tout visible"));
  const names = await page.evaluate((maxDepth) => {
    const list = [];
    const root = window.__immersion.scene;
    const walk = (o, path, depth) => o.children.forEach((c, i) => { const p = [...path, i]; list.push({ path: p, name: `${"·".repeat(depth)}${c.name || c.type}${c.isLight ? " (lampe)" : ""}` }); if (depth < maxDepth - 1 && c.children.length && !c.isMesh) walk(c, p, depth + 1); });
    walk(root, [], 0);
    return list;
  }, Number(process.env.BISECT));
  for (const { path, name } of names) {
    await page.evaluate((p) => { let o = window.__immersion.scene; for (const i of p) o = o.children[i]; o.userData.wasVisible = o.visible; o.visible = false; }, path);
    await page.waitForTimeout(700);
    console.log(await count(name));
    await page.evaluate((p) => { let o = window.__immersion.scene; for (const i of p) o = o.children[i]; o.visible = o.userData.wasVisible; }, path);
  }
  await browser.close();
  process.exit(0);
}
if (process.env.PREP) await page.evaluate(`(() => { const h = window.__immersion; ${process.env.PREP}; })()`);
await page.waitForTimeout(6000);
const report = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const frames = [];
      const loaf = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) loaf.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), scripts: e.scripts.map((s) => `${s.invokerType}:${s.invoker.slice(-40)} ${Math.round(s.duration)}ms ${s.sourceFunctionName || ""}`) });
        }).observe({ type: "long-animation-frame", buffered: false });
      } catch {}
      let last = 0;
      const start = performance.now();
      const tick = (now) => {
        if (last && now - last > 120) frames.push({ at: Math.round(now), ms: Math.round(now - last) });
        last = now;
        if (now - start < 20000) requestAnimationFrame(tick);
        else resolve({ frames, loaf: loaf.filter((l) => l.ms > 120) });
      };
      requestAnimationFrame(tick);
    })
);
console.log(`${process.env.PREP || "tel quel"} → ${report.frames.length} images longues (> 120 ms) en 20 s :`, report.frames.slice(0, 8).map((f) => `${f.at}:${f.ms}`).join("  "));
for (const l of report.loaf.slice(0, 3)) console.log(`  à ${l.at} — ${l.ms} ms (rendu ${l.render} ms) — ${l.scripts.join(" | ") || "aucun script"}`);
await browser.close();
