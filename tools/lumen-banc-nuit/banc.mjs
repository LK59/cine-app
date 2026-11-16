// Le pilote du banc de nuit : joue la page `/lumen-test` de l'instance jetable dans le WebKit (WPE) de Playwright.
// Lancé par nuit.sh dans le conteneur `lumen-nuit-nav`, qui partage l'espace réseau de l'instance
// (`--network container:lumen-nuit-app`) : http://localhost:3000 est un contexte sécurisé, sans relais.
//
// MODE=serie  — une passe de la page (PASS = courte | complète | leviers | multiplexé ; ORDER = serveur | actuel),
//               déroulée seule par la page ; le pilote ne fait que les appuis (« Touchez pour continuer » après le
//               rechargement de l'ordre `actuel`), attend la fin, envoie le bilan.
// MODE=conso  — une lecture continue de DURATION_S secondes d'un titre (ITEM) par un lecteur (PLAYER = serveur |
//               actuel), en mode manuel, avec AUDIO (numéro de piste dans le fichier) si donné. Le pilote note dans
//               /out/marks.jsonl le début et la fin de la fenêtre mesurée (heure murale) ; le relevé CPU est fait
//               par sampler.py, sur l'hôte, par cgroup et par processus.
//
// Toujours : LABEL (nom de la lecture dans marks.jsonl), /secrets/cookie (cine_session=…, lu, jamais affiché).
import fs from "node:fs";
import { webkit } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3000";
const MODE = process.env.MODE ?? "serie";
const LABEL = process.env.LABEL ?? `${MODE}-${Date.now()}`;
const OUT = "/out";
const cookie = fs.readFileSync("/secrets/cookie", "utf8").trim();
const [cookieName, cookieValue] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];

const mark = (phase, extra = {}) => {
  const line = { t: Date.now(), label: LABEL, mode: MODE, phase, ...extra };
  fs.appendFileSync(`${OUT}/marks.jsonl`, `${JSON.stringify(line)}\n`);
  console.log(`[banc] ${new Date().toISOString()} ${LABEL} ${phase} ${JSON.stringify(extra).slice(0, 300)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await webkit.launch({ headless: process.env.HEADED !== "1" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: cookieName, value: cookieValue, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
// Ce que la page ne mesure pas elle-même : le retard de la boucle d'évènements du fil principal (WebKit n'expose pas
// `longtask`) — un minuteur de 50 ms dont chaque retard au-delà de 50 ms est une « tâche longue » vue d'ici.
await context.addInitScript(() => {
  const lag = { n50: 0, n200: 0, maxMs: 0, overMs: 0, ticks: 0, since: performance.now() };
  window.__lag = lag;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - 50;
    last = now;
    lag.ticks += 1;
    if (late > 50) {
      lag.n50 += 1;
      lag.overMs += late;
      if (late > 200) lag.n200 += 1;
      if (late > lag.maxMs) lag.maxMs = late;
    }
  }, 50);
  window.__lagReset = () => Object.assign(lag, { n50: 0, n200: 0, maxMs: 0, overMs: 0, ticks: 0, since: performance.now() });
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("crash", () => errors.push("page crash"));

async function open() {
  await page.goto(`${BASE}/lumen-test`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Banc Lumen serveur" }).waitFor({ timeout: 60_000 });
}

/** Le bouton dont le texte commence par `prefix` (les libellés portent des comptes : « Comparatif rapide (12 essais, … »). */
const buttonStarting = (prefix) => page.locator("button", { hasText: new RegExp(`^${prefix.replace(/[()]/g, "\\$&")}`) }).first();

async function serie() {
  const pass = process.env.PASS ?? "courte";
  const order = process.env.ORDER ?? "serveur";
  const timeoutMs = Number(process.env.SERIE_TIMEOUT_S ?? 4200) * 1000;
  await open();
  const env = await page.evaluate(() => ({ ua: navigator.userAgent, hls: document.createElement("video").canPlayType("application/vnd.apple.mpegurl"), entryTypes: PerformanceObserver.supportedEntryTypes }));
  mark("debut", { pass, order, env });
  if (order === "actuel") await page.getByRole("button", { name: "Lecteur actuel d'abord (rechargement)" }).click();
  const label = { courte: "Comparatif rapide", complète: "Tout enchaîner", leviers: "Leviers de démarrage", multiplexé: "Son multiplexé" }[pass];
  await buttonStarting(label).click();
  const t0 = Date.now();
  let taps = 0;
  let reloads = 0;
  page.on("load", () => (reloads += 1));
  let lastProgress = "";
  let lastChange = Date.now();
  let shots = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    try {
      // Où en est la série : « Essai k sur n », titre, lecteur, étape. Une étape figée 4 minutes : capture d'écran.
      const progress = await page.evaluate(() => {
        const box = [...document.querySelectorAll("div.font-semibold")].find((n) => /^Essai \d+ sur \d+/.test(n.textContent ?? ""));
        return box ? `${box.textContent} · ${box.parentElement?.parentElement?.querySelector(".mt-1.text-xs")?.textContent ?? ""}` : "";
      }).catch(() => "");
      if (progress !== lastProgress) { lastProgress = progress; lastChange = Date.now(); console.log(`[banc] ${new Date().toISOString()} ${progress}`); }
      else if (Date.now() - lastChange > 240_000 && shots < 3) {
        shots += 1;
        lastChange = Date.now();
        await page.screenshot({ path: `${OUT}/fige-${LABEL}-${shots}.png`, fullPage: true }).catch(() => {});
        const tail = await page.evaluate(() => [...document.querySelectorAll("li, p")].map((n) => n.textContent).slice(-15)).catch(() => []);
        mark("fige", { progress, tail });
      }
      const tap = page.getByRole("button", { name: "Touchez pour continuer" });
      if (await tap.count()) {
        await tap.first().click({ timeout: 5000 });
        taps += 1;
        continue;
      }
      const done = await page.getByText(/^Série (terminée|arrêtée) :/).count();
      if (done) break;
    } catch (e) {
      errors.push(`pilote : ${String(e).slice(0, 200)}`);
    }
  }
  const timedOut = Date.now() - t0 >= timeoutMs;
  if (timedOut) {
    await page.getByRole("button", { name: "Arrêter" }).first().click().catch(() => {});
    await page.getByText(/^Série (terminée|arrêtée) :/).waitFor({ timeout: 60_000 }).catch(() => {});
  }
  const summary = (await page.getByText(/^Série (terminée|arrêtée) :/).first().textContent().catch(() => null)) ?? null;
  await page.getByRole("button", { name: "Envoyer le bilan" }).click({ timeout: 10_000 }).catch(() => errors.push("bilan non envoyé"));
  await sleep(3000);
  const lag = await page.evaluate(() => window.__lag).catch(() => null);
  mark("fin", { pass, order, summary, taps, reloads, timedOut, lag, errors: errors.slice(-20) });
}

async function conso() {
  const item = process.env.ITEM;
  const player = process.env.PLAYER ?? "serveur";
  const audio = process.env.AUDIO ? Number(process.env.AUDIO) : null;
  const durationS = Number(process.env.DURATION_S ?? 900);
  const warmS = Number(process.env.WARM_S ?? 20);
  await open();
  await page.getByPlaceholder("32 caractères hexadécimaux").fill(item);
  await page.locator("button", { hasText: player === "serveur" ? "Lumen serveur" : "Lecteur actuel" }).filter({ hasText: player === "serveur" ? "la liste HLS" : "remux dans la page" }).first().click();
  await page.getByRole("button", { name: "Préparer", exact: true }).click();
  await page.locator('input[name="piste"]').first().waitFor({ timeout: 120_000 });
  if (audio !== null) {
    const radio = page.locator('label', { hasText: new RegExp(`^piste ${audio} ·`) }).locator('input[name="piste"]');
    if (await radio.isDisabled()) {
      // Une piste que le serveur refuse (DTS, TrueHD) se choisit quand même pour le lecteur actuel : le bouton est
      // désactivé pour Lumen serveur seul.
      await radio.evaluate((el) => el.removeAttribute("disabled"));
    }
    await radio.check({ force: true });
  }
  const t0 = Date.now();
  await page.getByRole("button", { name: "Lire", exact: true }).click();
  // La première image : l'horloge avance.
  const started = await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.currentTime > 1 && !v.paused;
  }, null, { timeout: 90_000, polling: 500 }).then(() => true, () => false);
  const startMs = Date.now() - t0;
  if (!started) {
    const facts = await page.evaluate(() => { const v = document.querySelector("video"); return { ct: v?.currentTime, err: v?.error?.code, msg: v?.error?.message, log: [...document.querySelectorAll("li, pre, p")].map((n) => n.textContent).filter((t) => t && /refus|erreur|moteur|non servi/i.test(t)).slice(-6) }; });
    mark("echec", { item, player, audio, startMs, facts, errors });
    await browser.close();
    process.exit(3);
  }
  await sleep(warmS * 1000);
  const state = () => page.evaluate(() => {
    const v = document.querySelector("video");
    const q = v.getVideoPlaybackQuality?.();
    return { rvfc: window.__rvfc ?? null, ct: Math.round(v.currentTime * 10) / 10, paused: v.paused, rs: v.readyState, err: v.error ? v.error.code : null, frames: q?.totalVideoFrames ?? null, dropped: q?.droppedVideoFrames ?? null, w: v.videoWidth, h: v.videoHeight, audioTracks: v.audioTracks?.length ?? null };
  });
  // Les images présentées, comptées par requestVideoFrameCallback : `getVideoPlaybackQuality` de ce WebKit compte mal.
  await page.evaluate(() => {
    const v = document.querySelector("video");
    window.__rvfc = 0;
    const tick = () => { window.__rvfc += 1; v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback?.(tick);
    window.__lagReset();
  });
  const s0 = await state();
  mark("debut", { item, player, audio, durationS, startMs, s0 });
  const samples = [];
  const end = Date.now() + durationS * 1000;
  while (Date.now() < end) {
    await sleep(Math.min(30_000, Math.max(0, end - Date.now())));
    samples.push({ t: Date.now(), ...(await state().catch(() => ({ err: "lecture d'état" }))) });
  }
  const s1 = await state();
  const lag = await page.evaluate(() => window.__lag);
  const playedS = Math.round((s1.ct - s0.ct) * 10) / 10;
  mark("fin", { item, player, audio, s1, playedS, lag, samples, errors: errors.slice(-20) });
  // La ligne `lumen-test` de la page (« Envoyer les résultats ») : ce qu'elle a mesuré de la même lecture.
  await page.getByRole("button", { name: "Arrêter", exact: true }).last().click().catch(() => {});
  await sleep(1500);
  await page.getByRole("button", { name: "Envoyer les résultats" }).click().catch(() => {});
  await sleep(2500);
}

/**
 * MODE=coupure — la résistance d'un lecteur au redémarrage du serveur (demande de Louis du 16/11). Une lecture
 * continue ; le pilote écrit `go-<cas>` dans marks.jsonl et redemarrage.sh, qui guette ce fichier, redémarre
 * l'instance (ou la remplace par une image d'un autre format, pour le 410). Le pilote relève l'élément toutes les
 * 250 ms pendant OBSERVE_S : position, état, avance tampon, erreur, évènements — d'où l'arrêt, la reprise (et en
 * combien de temps) ou l'échec (et lequel).
 * - `pleine` : après 100 s de lecture (tampon rempli) ;
 * - `faible` : tout de suite après un saut loin devant (tampon vide) ;
 * - `version` (CASES) : l'instance revient avec un autre LUMEN_FORMAT_VERSION — chaque adresse en cours répond 410.
 */
async function coupure() {
  const item = process.env.ITEM;
  const player = process.env.PLAYER ?? "serveur";
  const observeS = Number(process.env.OBSERVE_S ?? 90);
  const cases = (process.env.CASES ?? "pleine,faible").split(",");
  await open();
  await page.getByPlaceholder("32 caractères hexadécimaux").fill(item);
  await page.locator("button", { hasText: player === "serveur" ? "Lumen serveur" : "Lecteur actuel" }).filter({ hasText: player === "serveur" ? "la liste HLS" : "remux dans la page" }).first().click();
  await page.getByRole("button", { name: "Préparer", exact: true }).click();
  await page.locator('input[name="piste"]').first().waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Lire", exact: true }).click();
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.currentTime > 1 && !v.paused; }, null, { timeout: 90_000, polling: 500 });
  await page.evaluate(() => {
    const v = document.querySelector("video");
    window.__ev = [];
    for (const e of ["waiting", "playing", "stalled", "error", "emptied", "abort", "seeked", "ended", "pause"]) v.addEventListener(e, () => window.__ev.push([Math.round(performance.now()), e, Math.round(v.currentTime * 10) / 10]));
  });
  const watch = async (name) => {
    const tl = [];
    const t0 = Date.now();
    await page.evaluate(() => (window.__ev = []));
    while (Date.now() - t0 < observeS * 1000) {
      tl.push(await page.evaluate(() => {
        const v = document.querySelector("video");
        let ahead = null;
        try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) >= v.currentTime) ahead = Math.round((v.buffered.end(i) - v.currentTime) * 10) / 10; } catch {}
        return [Date.now(), Math.round(v.currentTime * 100) / 100, v.paused ? 1 : 0, v.readyState, v.networkState, ahead, v.error ? `${v.error.code} ${v.error.message}` : null];
      }).catch((e) => [Date.now(), null, null, null, null, null, `page : ${String(e).slice(0, 80)}`]));
      await sleep(250);
    }
    // Analyse : l'horloge arrêtée (avance < 0,2 s en 1 s) après le geste, puis repartie.
    let stopAt = null, resumeAt = null, maxStall = 0;
    for (let i = 4; i < tl.length; i++) {
      const moving = tl[i][1] !== null && tl[i - 4][1] !== null && tl[i][1] - tl[i - 4][1] > 0.2;
      if (!moving && stopAt === null) stopAt = tl[i - 4][0];
      if (moving && stopAt !== null && resumeAt === null) { resumeAt = tl[i][0]; maxStall = resumeAt - stopAt; }
    }
    const last = tl.at(-1);
    const events = await page.evaluate(() => window.__ev).catch(() => []);
    const logTail = await page.evaluate(() => [...document.querySelectorAll("li, p, div")].map((n) => n.childElementCount === 0 ? n.textContent : "").filter((t) => t && /erreur|moteur|refus|410|réseau|error/i.test(t)).slice(-12)).catch(() => []);
    mark(`obs-${name}`, { player, stopAt, resumeAt, stallMs: stopAt && resumeAt ? resumeAt - stopAt : stopAt ? `> ${Date.now() - stopAt}` : 0, endCt: last?.[1], endErr: last?.[6], endRs: last?.[3], timeline: tl.filter((_, i) => i % 2 === 0).map((r) => r.join(":")), events, logTail });
  };
  for (const c of cases) {
    if (c === "pleine") {
      await sleep(100_000);
      mark("go-pleine", { player, ct: await page.evaluate(() => document.querySelector("video").currentTime) });
    } else if (c === "faible") {
      const to = await page.evaluate(() => { const v = document.querySelector("video"); const to = Math.min(v.duration - 300, v.currentTime + 1500); v.currentTime = to; return to; });
      mark("go-faible", { player, to });
    } else if (c === "version") {
      await sleep(30_000);
      mark("go-version", { player });
    }
    await watch(c);
  }
}

/** Ouvre un titre en mode manuel et attend la première image ; rend le temps mis (ms) ou lève. */
async function openManual(item, player, audio, mux = false, startAt = 0) {
  await open();
  await page.getByPlaceholder("32 caractères hexadécimaux").fill(item);
  if (startAt) await page.getByLabel("Départ à (s)").fill(String(startAt));
  await page.locator("button", { hasText: player === "serveur" ? "Lumen serveur" : "Lecteur actuel" }).filter({ hasText: player === "serveur" ? "la liste HLS" : "remux dans la page" }).first().click();
  if (mux) await page.getByRole("button", { name: "son multiplexé", exact: true }).click();
  await page.getByRole("button", { name: "Préparer", exact: true }).click();
  await page.locator('input[name="piste"]').first().waitFor({ timeout: 120_000 });
  if (audio !== null && audio !== undefined) {
    const radio = page.locator("label", { hasText: new RegExp(`^piste ${audio} ·`) }).locator('input[name="piste"]');
    if (await radio.isDisabled()) await radio.evaluate((el) => el.removeAttribute("disabled"));
    await radio.check({ force: true });
  }
  const t0 = Date.now();
  await page.getByRole("button", { name: "Lire", exact: true }).click();
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.currentTime > 1 && !v.paused; }, null, { timeout: 90_000, polling: 250 });
  return Date.now() - t0;
}

/**
 * MODE=sonde-son — ce que ce WebKit permet pour vérifier le son : combien de pistes `audioTracks` annonce sur une liste
 * à plusieurs rendus, et si Web Audio (`createMediaElementSource` + ScriptProcessor) voit le son réellement joué.
 */
async function sondeSon() {
  const ms = await openManual(process.env.ITEM, process.env.PLAYER ?? "serveur", null, process.env.MUX === "1");
  const facts = await page.evaluate(async () => {
    const v = document.querySelector("video");
    const tracks = v.audioTracks ? [...Array(v.audioTracks.length).keys()].map((i) => ({ id: v.audioTracks[i].id, label: v.audioTracks[i].label, lang: v.audioTracks[i].language, on: v.audioTracks[i].enabled })) : null;
    const out = { tracks, ctx: null, rms: [], err: null };
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(v);
      const sp = ctx.createScriptProcessor(4096, 2, 1);
      src.connect(sp);
      sp.connect(ctx.destination);
      sp.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        if (out.rms.length < 200) out.rms.push(Math.round(Math.sqrt(s / d.length) * 1e4) / 1e4);
      };
      await ctx.resume().catch(() => {});
      out.ctx = { state: ctx.state, rate: ctx.sampleRate };
      await new Promise((r) => setTimeout(r, 5000));
      out.ctx.state2 = ctx.state;
      out.ct = v.currentTime;
    } catch (e) {
      out.err = String(e);
    }
    return out;
  });
  mark("sonde-son", { ms, playbin3: process.env.WEBKIT_GST_USE_PLAYBIN3 ?? null, facts: { ...facts, rmsN: facts.rms.length, rmsMax: Math.max(0, ...facts.rms), rms: facts.rms.slice(0, 30) } });
}

/**
 * MODE=son — le son réellement joué, capté par Web Audio (`createMediaElementSource` → ScriptProcessor), mono, décimé
 * à 8 kHz, chaque morceau daté par `video.currentTime` ; un changement de piste demandé au milieu (Lumen serveur :
 * `audioTracks[i].enabled`, s'il y en a plus d'une). La capture va dans /out/son-<LABEL>.json ; verif-son.mjs la
 * compare au son de chaque piste du fichier (son.sh).
 */
async function son() {
  const player = process.env.PLAYER ?? "serveur";
  const startAt = Number(process.env.START_AT ?? 600);
  const ms = await openManual(process.env.ITEM, player, process.env.AUDIO ? Number(process.env.AUDIO) : null, process.env.MUX === "1", startAt);
  await page.evaluate(() => {
    const v = document.querySelector("video");
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(v);
    const sp = ctx.createScriptProcessor(4096, 2, 1);
    const cap = { rate: 8000, chunks: [], switches: [], ctxRate: ctx.sampleRate };
    window.__cap = cap;
    const dec = Math.round(ctx.sampleRate / 8000);
    sp.onaudioprocess = (e) => {
      const n = e.inputBuffer.length;
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      const out = new Float32Array(Math.floor(n / dec));
      for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < dec; j++) s += L[i * dec + j] + R[i * dec + j]; out[i] = s / (2 * dec); }
      // Le morceau finit au moment du rappel : il commence n/rate plus tôt dans le temps du média.
      cap.chunks.push({ ct: v.currentTime - n / ctx.sampleRate, data: out });
    };
    src.connect(sp);
    sp.connect(ctx.destination);
    void ctx.resume();
  });
  await sleep(15_000);
  const sw = await page.evaluate(() => {
    const v = document.querySelector("video");
    const t = v.audioTracks;
    const out = { n: t ? t.length : 0, at: v.currentTime, wall: Date.now() };
    if (t && t.length > 1) {
      let cur = -1;
      for (let i = 0; i < t.length; i++) if (t[i].enabled) cur = i;
      const next = (cur + 1) % t.length;
      out.from = t[cur]?.language; out.to = t[next].language;
      t[next].enabled = true;
      if (cur >= 0) t[cur].enabled = false;
      window.__cap.switches.push({ at: v.currentTime, to: t[next].language, wallMs: 0 });
    }
    return out;
  });
  await sleep(15_000);
  const capture = await page.evaluate(() => {
    const cap = window.__cap;
    const b64 = (f) => { const u = new Uint8Array(f.buffer); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
    return { rate: cap.rate, ctxRate: cap.ctxRate, switches: cap.switches, chunks: cap.chunks.map((c) => ({ ct: c.ct, b64: b64(c.data) })) };
  });
  fs.writeFileSync(`${OUT}/son-${LABEL}.json`, JSON.stringify(capture));
  mark("son", { player, mux: process.env.MUX === "1", audio: process.env.AUDIO ?? null, ms, startAt, switch: sw, chunks: capture.chunks.length, firstCt: capture.chunks[0]?.ct, lastCt: capture.chunks.at(-1)?.ct });
}

/**
 * MODE=essai — un essai seul, dans un navigateur neuf : le mode manuel de la page (Préparer, Lire, 10 s de lecture,
 * « Lancer le parcours » de SEEKS sauts tirés au hasard par la page, Arrêter, « Envoyer les résultats »), mesuré par
 * le même code que les passes. Il existe pour le décodage par l'iGPU : dans ce WebKit, le greffon `va` fuit ses
 * surfaces (le conteneur tué vers 4 Go après une à trois minutes de 4K), et une passe entière dans une même page ne
 * tient pas ; un navigateur par essai, si.
 */
async function essai() {
  const player = process.env.PLAYER ?? "serveur";
  const seeks = Number(process.env.SEEKS ?? 10);
  const ms = await openManual(process.env.ITEM, player, process.env.AUDIO ? Number(process.env.AUDIO) : null, process.env.MUX === "1", Number(process.env.START_AT ?? 0));
  mark("debut", { item: process.env.ITEM, player, firstFrameDriverMs: ms });
  await sleep(10_000);
  const input = page.locator("button", { hasText: "Lancer le parcours" }).locator("xpath=..").locator("input");
  if (await input.count()) await input.first().fill(String(seeks));
  await page.getByRole("button", { name: "Lancer le parcours" }).click();
  await page.getByRole("button", { name: "Lancer le parcours" }).waitFor({ timeout: (seeks * 30 + 60) * 1000 }).catch(() => errors.push("parcours non terminé"));
  await sleep(2000);
  const lag = await page.evaluate(() => window.__lag).catch(() => null);
  await page.getByRole("button", { name: "Arrêter", exact: true }).last().click().catch(() => {});
  await sleep(1500);
  await page.getByRole("button", { name: "Envoyer les résultats" }).click().catch(() => errors.push("résultats non envoyés"));
  await sleep(3000);
  const mem = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null).catch(() => null);
  mark("fin", { item: process.env.ITEM, player, lag, mem, errors: errors.slice(-20) });
}

try {
  if (MODE === "essai") await essai();
  else if (MODE === "son") await son();
  else if (MODE === "sonde-son") await sondeSon();
  else if (MODE === "serie") await serie();
  else if (MODE === "coupure") await coupure();
  else if (MODE === "conso") await conso();
  else throw new Error(`MODE inconnu : ${MODE}`);
} catch (e) {
  mark("erreur", { message: String(e).slice(0, 500), errors });
  await page.screenshot({ path: `${OUT}/erreur-${LABEL}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
