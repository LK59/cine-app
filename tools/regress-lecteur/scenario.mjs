// Le parcours du banc anti-régression : chaque titre de titres.json, dans chaque profil de
// navigateur, par les vraies commandes du lecteur — puis les lignes que l'instance a écrites pour
// lui. Lancé par regress.sh dans l'image Playwright ; voir README.md.
//
// Le parcours, fixe : ouvrir → première image → trois sauts → pause 3 s → changement de piste son
// (s'il y en a une autre) → sous-titres allumés puis éteints → arrière-plan simulé → (épisode :
// épisode suivant) → retour près du début → fermer.
//
// Rien n'est jugé ici : chaque étape note ce qu'elle a vu (fait / délai dépassé / absent), et la
// comparaison se fait entre deux passages, sur les lignes du journal normalisées (normalise.py).
import { chromium, firefox, webkit, devices } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3098";
const PROFILES = (process.env.PROFILES || "chromium firefox webkit iphone").split(/\s+/).filter(Boolean);
const TITLES = JSON.parse(fs.readFileSync(process.env.TITLES || "/tool/titres.json", "utf8"));
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const LOGS = "/logs";
const OUT = "/out";

// Les identifiants du compte de test : lus ici, jamais écrits nulle part.
const cred = Object.fromEntries(
  fs.readFileSync("/creds.txt", "utf8").trim().split("\n").map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);

const PROFILE_DEFS = {
  chromium: { type: chromium, launch: { args: ["--autoplay-policy=no-user-gesture-required"] }, ctx: { viewport: { width: 1440, height: 900 } } },
  firefox: { type: firefox, launch: { firefoxUserPrefs: {
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
        // Le bouton « Pop out this video » de Firefox se pose sur la vidéo et prend les clics des menus.
        "media.videocontrols.picture-in-picture.enabled": false,
        "media.videocontrols.picture-in-picture.video-toggle.enabled": false,
      } }, ctx: { viewport: { width: 1440, height: 900 } } },
  webkit: { type: webkit, launch: {}, ctx: { viewport: { width: 1440, height: 900 } } },
  // Un iPhone émulé : agent, écran, toucher. Le moteur reste WebKit pour Linux (GStreamer), pas
  // celui d'iOS — voir README, « Ce que le banc couvre vraiment ».
  iphone: { type: webkit, launch: {}, ctx: { ...devices["iPhone 15 Pro"] } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logSize = (name) => {
  try {
    return fs.statSync(`${LOGS}/${name}`).size;
  } catch {
    return 0;
  }
};
const logSlice = (name, from) => {
  try {
    const buf = fs.readFileSync(`${LOGS}/${name}`);
    return buf.subarray(from).toString("utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

async function login(browser, def) {
  const ctx = await browser.newContext({ ...def.ctx, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const res = await ctx.request.post(`${BASE}/api/auth/jellyfin`, {
    data: { username: cred.user, password: cred.password },
    headers: { Origin: BASE },
  });
  if (!res.ok()) throw new Error(`connexion refusée (${res.status()})`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function logout(browser, def, state) {
  // La déconnexion rend l'appareil Jellyfin que la connexion avait inscrit.
  const ctx = await browser.newContext({ ...def.ctx, storageState: state });
  await ctx.request.post(`${BASE}/api/auth/logout`, { headers: { Origin: BASE } }).catch(() => {});
  await ctx.close();
}

async function resolveTitles(browser, def, state) {
  const ctx = await browser.newContext({ ...def.ctx, storageState: state });
  const movies = await (await ctx.request.get(`${BASE}/api/cinema/movies`)).json();
  const series = await (await ctx.request.get(`${BASE}/api/cinema/series`)).json();
  await ctx.close();
  return TITLES.map((t) => {
    const list = t.kind === "series" ? series.items : movies.items;
    const hit = list.find((x) => x.title === t.title && (!t.year || x.year === t.year));
    const id = hit ? (t.kind === "series" ? hit.sonarrId : hit.radarrId) : null;
    return { ...t, id, hash: id ? (t.kind === "series" ? `#tab=series&serie=${id}` : `#film=${id}`) : null };
  });
}

/** L'élément vidéo du lecteur : le plus grand qui ait une source (la fiche peut en montrer d'autres). */
async function video(page) {
  return page
    .evaluate(() => {
      const vids = [...document.querySelectorAll("video")].filter((v) => v.currentSrc || v.srcObject);
      if (vids.length === 0) return null;
      const v = vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      const src = v.currentSrc || "";
      return {
        t: v.currentTime,
        d: v.duration,
        paused: v.paused,
        rs: v.readyState,
        seeking: v.seeking,
        err: v.error ? v.error.code : null,
        src: src.startsWith("blob:") ? "blob" : /\.m3u8|master|hls/i.test(src) ? "hls" : src ? "url" : "objet",
        w: v.videoWidth,
      };
    })
    .catch(() => null);
}

/** Attend que l'horloge du film avance (une image montrée et la lecture en cours). */
async function waitPlaying(page, timeoutMs, minAdvance = 0.4) {
  const until = Date.now() + timeoutMs;
  let first = null;
  while (Date.now() < until) {
    const v = await video(page);
    if (v && v.rs >= 2 && !v.seeking && !v.paused) {
      if (first === null) first = v.t;
      else if (v.t - first >= minAdvance) return v;
    } else first = null;
    await sleep(250);
  }
  return null;
}

async function showControls(page, profile) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.move(vp.width / 2 + 7, vp.height / 2 + 3);
  await sleep(150);
  const shown = await page.locator('[data-chrome="shown"]').count();
  if (shown === 0 && profile === "iphone") {
    await page.touchscreen.tap(vp.width / 2, vp.height * 0.3);
    await sleep(300);
  }
}

let forcedClicks = 0;
async function press(page, profile, locator) {
  try {
    if (profile === "iphone") await locator.tap({ timeout: 5000 });
    else await locator.click({ timeout: 5000 });
  } catch (e) {
    // Firefox juge parfois instable une ligne de menu encore en mouvement (le verre, le défilement
    // de la liste) : le clic est alors envoyé à l'élément lui-même. Compté dans brut.json, pas comparé.
    if (!(await locator.isVisible().catch(() => false))) throw e;
    forcedClicks++;
    await locator.dispatchEvent("click");
  }
}

/** Un saut par la barre de progression, à une fraction du film — la souris, sur tous les profils. */
async function seekBar(page, profile, fraction) {
  await showControls(page, profile);
  const bar = page.locator('[data-chrome] input[type="range"]').last();
  const box = await bar.boundingBox();
  if (!box) return "barre absente";
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  return (await waitPlaying(page, 30000)) ? "fait" : "délai dépassé";
}

async function menuChoose(page, profile, nav, pick) {
  await showControls(page, profile);
  const btn = page.locator(`[data-player-nav="${nav}"]`);
  if ((await btn.count()) === 0 || !(await btn.first().isVisible())) return { outcome: "absent" };
  await press(page, profile, btn.first());
  await sleep(700);
  const options = page.locator("button:has(> svg.lucide-check)");
  const rows = [];
  for (let i = 0; i < (await options.count()); i++) {
    const o = options.nth(i);
    if (!(await o.isVisible())) continue;
    rows.push({ i, on: (await o.locator("svg[data-option-on]").count()) > 0, label: (await o.innerText()).trim().replace(/\s+/g, " ") });
  }
  const choice = pick(rows);
  if (!choice) {
    // Un appui hors du menu le referme (`toggleControls` : menu ouvert → fermé, sans pause).
    // Échap ne le ferme pas, et le menu recouvre son propre bouton.
    const vp = page.viewportSize();
    if (profile === "iphone") await page.touchscreen.tap(vp.width / 2, vp.height * 0.3);
    else await page.mouse.click(vp.width / 2, vp.height * 0.3);
    await sleep(400);
    return { outcome: "rien à choisir", rows: rows.length };
  }
  await press(page, profile, options.nth(choice.i));
  return { outcome: "choisi", label: choice.label, rows: rows.length };
}

async function setHidden(page, hidden) {
  await page.evaluate((hidden) => {
    if (hidden) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    } else {
      delete document.visibilityState;
      delete document.hidden;
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

async function dismissOverlays(page) {
  // L'accueil du compte (« Passer » ne l'éteint pas côté serveur) et l'invitation à installer.
  for (const name of ["Passer"]) {
    const b = page.getByRole("button", { name, exact: true });
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
  await sleep(300);
}

async function playCase(browser, def, state, profile, title) {
  const steps = [];
  const step = (name, outcome, extra) => steps.push({ step: name, outcome, ...(extra || {}) });
  const ctx = await browser.newContext({ ...def.ctx, storageState: state, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e.message).split("\n")[0].slice(0, 200)));
  const t0 = Date.now();
  forcedClicks = 0;
  try {
    await page.goto(`${BASE}/${title.hash}`, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    await dismissOverlays(page);
    await sleep(1500);

    // « Recommencer depuis le début » quand le compte a une reprise, « Lire » sinon : le film part
    // toujours du début, quel que soit l'état laissé par un passage précédent.
    const scope = (await page.locator('[role="dialog"]').count()) > 0 ? page.locator('[role="dialog"]').last() : page;
    // Une série propose « À suivre S1 · É1 » (le prochain épisode du compte) ; jamais « Reprendre ».
    let playBtn = null;
    let how = null;
    for (const [name, label] of [[/^Recommencer depuis le début/, "recommencer"], [/^À suivre S\d+/, "à suivre"], [/^Lire( |$)/, "lire"]]) {
      const candidates = scope.getByRole("button", { name });
      for (let i = (await candidates.count()) - 1; i >= 0; i--) {
        if (await candidates.nth(i).isVisible().catch(() => false)) {
          playBtn = candidates.nth(i);
          how = label;
          break;
        }
      }
      if (playBtn) break;
    }
    if (!playBtn) {
      step("ouvrir", "bouton absent");
      await page.screenshot({ path: `${OUT}/${profile}-${title.key}-ouvrir.png` });
      return { steps, consoleErrors, how: null, forcedClicks, ms: Date.now() - t0 };
    }
    await press(page, profile, playBtn);
    step("ouvrir", "fait");

    const first = await waitPlaying(page, 90000);
    step("première image", first ? "fait" : "délai dépassé", first ? { source: first.src } : {});
    if (!first) {
      await page.screenshot({ path: `${OUT}/${profile}-${title.key}-premiere-image.png` });
      return { steps, consoleErrors, how, forcedClicks, ms: Date.now() - t0 };
    }
    await sleep(2000);

    step("saut 40 %", await seekBar(page, profile, 0.4));
    await sleep(1500);
    step("saut 75 %", await seekBar(page, profile, 0.75));
    await sleep(1500);
    await showControls(page, profile);
    await page.keyboard.press("ArrowLeft");
    step("saut −10 s", (await waitPlaying(page, 30000)) ? "fait" : "délai dépassé");
    await sleep(1500);

    await page.keyboard.press("k");
    await sleep(500);
    const pausedNow = await video(page);
    await sleep(3000);
    await page.keyboard.press("k");
    step("pause 3 s", pausedNow?.paused ? ((await waitPlaying(page, 20000)) ? "fait" : "reprise non vue") : "pas en pause");

    const audio = await menuChoose(page, profile, "audio", (rows) => rows.find((r) => !r.on));
    if (audio.outcome === "choisi") {
      await sleep(1000);
      step("piste son", (await waitPlaying(page, 60000)) ? "fait" : "délai dépassé", { pistes: audio.rows });
    } else step("piste son", audio.outcome, { pistes: audio.rows ?? 0 });
    await sleep(1500);

    const subOn = await menuChoose(page, profile, "captions", (rows) => rows.find((r) => !r.on && !/^Aucun/.test(r.label)) ?? null);
    if (subOn.outcome === "choisi") {
      await sleep(4000);
      const subOff = await menuChoose(page, profile, "captions", (rows) => rows.find((r) => /^Aucun/.test(r.label)) ?? null);
      step("sous-titres", subOff.outcome === "choisi" ? "allumés puis éteints" : `allumés, ${subOff.outcome}`);
    } else step("sous-titres", subOn.outcome);
    await sleep(1500);

    await setHidden(page, true);
    await sleep(6000);
    await setHidden(page, false);
    let back = await waitPlaying(page, 30000);
    if (!back) {
      // Un lecteur qui se met en pause au retour : le spectateur relance.
      await page.keyboard.press("k");
      back = await waitPlaying(page, 30000);
      step("arrière-plan", back ? "relancé à la main" : "délai dépassé");
    } else step("arrière-plan", "fait");

    if (title.kind === "series") {
      // Retour près du début avant de passer à la suite : aucune reprise ne reste sur cet épisode.
      await seekBar(page, profile, 0.003);
      await showControls(page, profile);
      const next = page.locator('[data-player-nav="next-episode"]');
      if ((await next.count()) > 0 && (await next.first().isVisible())) {
        await press(page, profile, next.first());
        await sleep(3000);
        step("épisode suivant", (await waitPlaying(page, 90000)) ? "fait" : "délai dépassé");
      } else step("épisode suivant", "absent");
    } else {
      step("retour au début", await seekBar(page, profile, 0.003));
    }
    await sleep(1000);

    await showControls(page, profile);
    const close = page.locator('[data-player-nav="close"]');
    if (await close.first().isVisible().catch(() => false)) {
      await press(page, profile, close.first());
      step("fermer", "fait");
    } else step("fermer", "absent");
    await sleep(5000); // la ligne `stop` part à la fermeture
    return { steps, consoleErrors, how, forcedClicks, ms: Date.now() - t0 };
  } catch (e) {
    // Revenu à l'écran de connexion : la session est tombée en route (vu une fois sur WebKit pour
    // Linux, une requête du flux refusée « due to access control checks »). Nommé à part, pour ne
    // pas le confondre avec une commande devenue introuvable.
    const lost = /\/login/.test(page.url());
    step(lost ? "session perdue" : "exception", lost ? "retour à l'écran de connexion" : String(e.message).split("\n")[0].slice(0, 160));
    await page.screenshot({ path: `${OUT}/${profile}-${title.key}-exception.png` }).catch(() => {});
    return { steps, consoleErrors, how: null, forcedClicks, ms: Date.now() - t0 };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const results = [];
for (const profile of PROFILES) {
  const def = PROFILE_DEFS[profile];
  if (!def) throw new Error(`profil inconnu : ${profile}`);
  const browser = await def.type.launch(def.launch);
  const version = browser.version();
  const state = await login(browser, def);
  const titles = await resolveTitles(browser, def, state);
  for (const title of titles) {
    if (ONLY.length && !ONLY.includes(title.key)) continue;
    if (!title.hash) {
      results.push({ profile, version, key: title.key, title: title.title, steps: [{ step: "titre", outcome: "absent du catalogue" }] });
      continue;
    }
    const before = { player: logSize("player.log"), server: logSize("server.log") };
    const r = await playCase(browser, def, state, profile, title);
    await sleep(1500);
    results.push({
      profile,
      version,
      key: title.key,
      title: title.title,
      ...r,
      playerLines: logSlice("player.log", before.player),
      serverLines: logSlice("server.log", before.server),
    });
    console.log(`${profile} ${title.key} ${Math.round(r.ms / 1000)} s — ${r.steps.map((s) => `${s.step}: ${s.outcome}`).join(" · ")}`);
    fs.writeFileSync(`${OUT}/brut.json`, JSON.stringify(results, null, 1));
  }
  await logout(browser, def, state);
  await browser.close();
}
fs.writeFileSync(`${OUT}/brut.json`, JSON.stringify(results, null, 1));
