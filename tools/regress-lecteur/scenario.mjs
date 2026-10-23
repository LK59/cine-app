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
//
// Chaque étape attend une condition qu'on peut constater — l'élément <video> (saut arrivé, horloge
// qui avance, pause), une ligne du journal de l'instance, un élément du DOM — avec un plafond. Les
// seules attentes fixes qui restent sont des gestes dont la durée est le geste (la pause de 3 s,
// l'arrière-plan de 6 s) et les fenêtres de silence du journal (plus rien n'arrive depuis X ms).
// Jusqu'au 23/10/2026 le parcours dormait à heure fixe (~38 s par séance) : sur une machine calme
// c'était du temps perdu, sur une machine chargée ce n'était pas toujours assez.
import { chromium, firefox, webkit, devices } from "playwright";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

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
/**
 * Le plafond d'un saut. Au lecteur serveur, un saut relance chez Jellyfin le transcodage d'un 4K
 * HEVC en H.264 : machine chargée, 30 s ne suffisaient pas toujours (« délai dépassé » d'un passage
 * sur l'autre, même commit). Un plafond ne coûte rien quand le saut arrive.
 */
const SEEK_CAP_MS = 60000;
const POLL = 100;
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
/**
 * La séance en cours — ses heures, ses clics forcés, l'agent de son navigateur et où commencent
 * ses lignes dans les journaux.
 */
const caseCtx = new AsyncLocalStorage();
/**
 * Une ligne de journal est à la séance si elle porte son agent, ou pas d'agent du tout (une erreur
 * du serveur lui-même). Chaque ligne du lecteur porte `agent`, et les quatre profils en ont quatre
 * différents : une ligne tardive d'un autre profil (ou d'un autre navigateur ouvert sur l'instance)
 * ne s'attribue pas à cette séance.
 */
const isMine = (raw) => {
  const agent = caseCtx.getStore()?.agent;
  return !agent || !raw.agent || raw.agent === agent;
};
const parseLine = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
/** Les lignes de cette séance écrites dans `name` depuis `from` (texte brut). */
const myLogSlice = (name, from) =>
  logSlice(name, from).filter((t) => {
    const raw = parseLine(t);
    return raw ? isMine(raw) : !caseCtx.getStore()?.agent;
  });
/** Les lignes du journal du lecteur écrites depuis `from` pour cette séance, lues (une ligne coupée en cours d'écriture est ignorée). */
const playerLinesSince = (from) =>
  logSlice("player.log", from).flatMap((t) => {
    const raw = parseLine(t);
    return raw && isMine(raw) ? [raw] : [];
  });
/** Attend une ligne du journal depuis `from` qui satisfasse `pred` ; la rend, ou null au plafond. */
async function waitLogLine(from, pred, capMs) {
  const until = Date.now() + capMs;
  for (;;) {
    const hit = playerLinesSince(from).find(pred);
    if (hit) return hit;
    if (Date.now() >= until) return null;
    await sleep(POLL);
  }
}
/** Attend que les deux journaux ne reçoivent plus rien de cette séance pendant `quietMs` (au plus `capMs`). */
async function waitLogsQuiet(quietMs, capMs) {
  const from = caseCtx.getStore()?.logFrom ?? { player: logSize("player.log"), server: logSize("server.log") };
  const count = () => myLogSlice("player.log", from.player).length + myLogSlice("server.log", from.server).length;
  const until = Date.now() + capMs;
  let last = count();
  let since = Date.now();
  while (Date.now() < until) {
    await sleep(POLL);
    const now = count();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
}

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

/**
 * Attend que l'horloge du film avance (une image montrée et la lecture en cours) — ou que `giveUp`
 * dise l'issue déjà fixée (rend alors null sans attendre le plafond).
 */
async function waitPlaying(page, timeoutMs, minAdvance = 0.4, giveUp = null) {
  const until = Date.now() + timeoutMs;
  let first = null;
  while (Date.now() < until) {
    const v = await video(page);
    if (v && v.rs >= 2 && !v.seeking && !v.paused) {
      if (first === null) first = v.t;
      else if (v.t - first >= minAdvance) return v;
    } else first = null;
    if (giveUp && (await giveUp())) return null;
    await sleep(POLL);
  }
  return null;
}

/**
 * Un saut commandé : attend qu'il soit **parti** (l'élément dit `seeking`, ou sa position a quitté
 * celle d'avant), puis que la lecture reprenne et avance. Sans la première moitié, l'horloge qui
 * avançait encore à l'ancienne position passait pour le saut arrivé.
 */
async function waitSeek(page, fromT, timeoutMs) {
  const departUntil = Date.now() + 5000;
  let departed = false;
  while (!departed && Date.now() < departUntil) {
    const v = await video(page);
    departed = !!v && (v.seeking || Math.abs(v.t - fromT) > 3);
    if (!departed) await sleep(POLL / 2);
  }
  mark(departed ? "· saut parti" : "· saut non vu");
  return waitPlaying(page, timeoutMs);
}

/**
 * Laisse le film jouer `seconds` secondes **de film** (horloge de l'élément, pas la montre) : le
 * temps qu'une étape se pose avant la suivante — ce que remplit le lecteur derrière la tête, donc
 * le `buffered` du saut de −10 s, en dépend. À la montre, une machine chargée en jouait moins.
 */
async function settle(page, seconds, capMs = 30000) {
  const until = Date.now() + capMs;
  let from = null;
  let last = null;
  while (Date.now() < until) {
    const v = await video(page);
    if (v && v.rs >= 2 && !v.seeking && !v.paused) {
      // Un saut en route (position qui recule ou bondit) recommence le compte.
      if (from === null || last === null || v.t < last || v.t - last > 5) from = v.t;
      last = v.t;
      if (v.t - from >= seconds) return true;
    } else {
      from = null;
      last = null;
    }
    await sleep(POLL);
  }
  return false;
}

async function controlsShown(page) {
  return (await page.locator('[data-chrome="shown"]').count()) > 0;
}
async function waitControls(page, capMs) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    if (await controlsShown(page)) return true;
    await sleep(50);
  }
  return controlsShown(page);
}

async function showControls(page, profile) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.move(vp.width / 2 + 7, vp.height / 2 + 3);
  if (profile !== "iphone") {
    await waitControls(page, 1000);
    return;
  }
  // Au toucher, un appui sur des commandes visibles les cache : n'appuyer que si elles ne le sont pas.
  await sleep(150);
  if (!(await controlsShown(page))) {
    await page.touchscreen.tap(vp.width / 2, vp.height * 0.3);
    await waitControls(page, 1000);
  }
}

// Les heures de la séance en cours (étapes et repères intermédiaires), pour mesurer où part le temps.
const mark = (name) => {
  const cx = caseCtx.getStore();
  if (cx) cx.timings.push([name, Date.now() - cx.t0]);
};
async function press(page, profile, locator) {
  try {
    if (profile === "iphone") await locator.tap({ timeout: 10000 });
    else await locator.click({ timeout: 10000 });
  } catch (e) {
    // Le délai a pu tomber **après** le clic (WebKit chargé : 4,8 s à attendre l'élément immobile,
    // le clic, puis le plafond) — le journal d'appel de l'erreur le dit. Le renvoyer ouvrait le
    // lecteur deux fois (un `stop` « unmount » puis une ouverture « mémoire »).
    if (/performing (click|tap) action/.test(String(e.message))) return;
    // Firefox juge parfois instable une ligne de menu encore en mouvement (le verre, le défilement
    // de la liste) : le clic est alors envoyé à l'élément lui-même. Compté dans brut.json, pas comparé.
    if (!(await locator.isVisible().catch(() => false))) throw e;
    const cx = caseCtx.getStore();
    if (cx) cx.forcedClicks++;
    await locator.dispatchEvent("click");
  }
}

/** Un saut par la barre de progression, à une fraction du film — la souris, sur tous les profils. */
async function seekBar(page, profile, fraction) {
  await showControls(page, profile);
  const bar = page.locator('[data-chrome] input[type="range"]').last();
  // Les commandes apparaissent en glissant : la barre est cliquée une fois immobile (deux lectures
  // de sa boîte identiques), sinon le clic tombe ailleurs que la fraction voulue.
  let box = null;
  let prevBox = null;
  const boxUntil = Date.now() + 2000;
  while (Date.now() < boxUntil) {
    box = await bar.boundingBox().catch(() => null);
    if (box && prevBox && JSON.stringify(box) === JSON.stringify(prevBox)) break;
    prevBox = box;
    await sleep(50);
  }
  if (!box) return "barre absente";
  mark("· barre");
  const before = await video(page);
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  return (await waitSeek(page, before?.t ?? 0, SEEK_CAP_MS)) ? "fait" : "délai dépassé";
}

const OPTIONS = "button:has(> svg.lucide-check)";
/**
 * Les lignes visibles du menu ouvert, lues en un seul aller-retour (`i` : rang parmi toutes les
 * lignes, pour cliquer ensuite par le localisateur). Visible au sens de Playwright : une boîte non
 * vide et pas `visibility: hidden`. Ligne par ligne par le localisateur, la lecture d'une liste de
 * sous-titres coûtait plus d'une minute à Firefox.
 */
async function menuRows(page) {
  return page
    .evaluate((sel) =>
      [...document.querySelectorAll(sel)].flatMap((b, i) => {
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(b).visibility === "hidden") return [];
        return [{ i, on: b.querySelector("svg[data-option-on]") !== null, label: b.innerText.trim().replace(/\s+/g, " ") }];
      }), OPTIONS)
    .catch(() => []);
}

async function menuChoose(page, profile, nav, pick) {
  await showControls(page, profile);
  const btn = page.locator(`[data-player-nav="${nav}"]`);
  if ((await btn.count()) === 0 || !(await btn.first().isVisible())) return { outcome: "absent" };
  await press(page, profile, btn.first());
  // Le menu est ouvert quand ses lignes sont là ; leur nombre est noté, il doit être complet :
  // deux lectures de suite qui donnent les mêmes lignes.
  const until = Date.now() + 3000;
  let rows = [];
  let prev = null;
  while (Date.now() < until) {
    rows = await menuRows(page);
    const sig = JSON.stringify(rows);
    if (rows.length > 0 && sig === prev) break;
    prev = sig;
    await sleep(POLL);
  }
  mark(`· menu ${nav} lu (${rows.length})`);
  const choice = pick(rows);
  if (!choice) {
    // Un appui hors du menu le referme (`toggleControls` : menu ouvert → fermé, sans pause).
    // Échap ne le ferme pas, et le menu recouvre son propre bouton.
    // Seulement s'il est encore ouvert : refermé entre-temps (les commandes qui se masquent, sur une
    // machine chargée), ce clic à la souris sur l'image mettait le film en pause (§65).
    const vp = page.viewportSize();
    if ((await menuRows(page)).length > 0) {
      if (profile === "iphone") await page.touchscreen.tap(vp.width / 2, vp.height * 0.3);
      else await page.mouse.click(vp.width / 2, vp.height * 0.3);
    }
    const closeUntil = Date.now() + 2000;
    while (Date.now() < closeUntil && (await menuRows(page)).length > 0) await sleep(POLL);
    return { outcome: "rien à choisir", rows: rows.length };
  }
  // La ligne choisie est marquée puis désignée par sa marque : le moteur de sélecteurs de
  // Playwright met 2 à 3 s à résoudre `:has()` sur la page entière (l'accueil reste monté sous le
  // lecteur), le navigateur un instant.
  await page.evaluate(([sel, i]) => {
    for (const el of document.querySelectorAll("[data-regress-pick]")) el.removeAttribute("data-regress-pick");
    document.querySelectorAll(sel)[i]?.setAttribute("data-regress-pick", "");
  }, [OPTIONS, choice.i]);
  await press(page, profile, page.locator("[data-regress-pick]"));
  mark("· choix appuyé");
  // Le choix referme le menu : la suite attend qu'il soit parti (un menu encore en train de se
  // refermer serait relu comme ouvert par l'étape suivante).
  const goneUntil = Date.now() + 2000;
  while (Date.now() < goneUntil && (await menuRows(page)).length > 0) await sleep(POLL);
  mark(`· menu ${(await menuRows(page)).length ? "resté ouvert" : "refermé"}`);
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

/**
 * Le bouton qui lance la lecture du début dans la fiche ouverte : { button, how } ou null. Cherché
 * dans la page en un aller-retour et marqué (`data-regress-pick`) : `getByRole` calcule le nom
 * accessible de chaque bouton de l'accueil, monté sous la fiche, à chaque essai.
 */
async function findPlayButton(page) {
  const how = await page
    .evaluate(() => {
      for (const el of document.querySelectorAll("[data-regress-pick]")) el.removeAttribute("data-regress-pick");
      // Dans la fiche seulement (`data-sheet-morph-root`, ou un `dialog`) : tant qu'elle n'est pas
      // là, les « Lire » de l'accueil (la bannière, les cartes) ne sont pas les siens.
      const roots = document.querySelectorAll("[data-sheet-morph-root]");
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const scope = roots.length ? roots[roots.length - 1] : dialogs.length ? dialogs[dialogs.length - 1] : null;
      if (!scope) return null;
      const visible = (b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== "hidden";
      };
      const buttons = [...scope.querySelectorAll("button")].filter(visible);
      const name = (b) => (b.getAttribute("aria-label") || b.innerText || "").trim().replace(/\s+/g, " ");
      // « Recommencer depuis le début » quand le compte a une reprise, « Lire » sinon : le film part
      // toujours du début, quel que soit l'état laissé par un passage précédent.
      // Une série propose « À suivre S1 · É1 » (le prochain épisode du compte) ; jamais « Reprendre ».
      for (const [re, how] of [[/^Recommencer depuis le début/, "recommencer"], [/^À suivre S\d+/, "à suivre"], [/^Lire( |$)/, "lire"]]) {
        const hit = buttons.filter((b) => re.test(name(b))).pop();
        if (hit) {
          hit.setAttribute("data-regress-pick", "");
          return how;
        }
      }
      return null;
    })
    .catch(() => null);
  return how ? { button: page.locator("[data-regress-pick]"), how } : null;
}

async function playCase(browser, def, state, profile, title) {
  const cx = caseCtx.getStore();
  const logFrom = cx.logFrom.player;
  const steps = [];
  const t0 = cx.t0;
  // L'heure de chaque étape, à part : brut.json la garde pour mesurer, la comparaison l'ignore.
  const step = (name, outcome, extra) => {
    steps.push({ step: name, outcome, ...(extra || {}) });
    mark(name);
  };
  const ctx = await browser.newContext({ ...def.ctx, storageState: state, locale: "fr-FR", timezoneId: "Europe/Paris" });
  // L'accueil du compte se propose tant que son marqueur est allumé ; « Passer » ne fait qu'écrire
  // ceci dans sessionStorage (PlayerOnboarding). Posé d'avance, il ne s'affiche pas : rien à
  // attendre ni à fermer, et rien n'est enregistré côté serveur.
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem("cine:onboarding-skipped", String(Date.now()));
    } catch {}
  });
  const page = await ctx.newPage();
  cx.agent = await page.evaluate(() => navigator.userAgent).catch(() => null);
  // L'ouverture du cinéma est finie quand la page envoie sa ligne `ouverture` (startup.log). Le
  // départ de la requête suffit, et lui seul se voit partout : envoyée en `keepalive`, Chromium la
  // fait partir hors de la page et Playwright n'en voit jamais la fin (20 s perdues par séance).
  let startupSent = false;
  page.on("request", (r) => {
    if (r.url().includes("/api/startup-timing")) startupSent = true;
  });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e.message).split("\n")[0].slice(0, 200)));
  // Les fichiers de sous-titres demandés et finis (reçus, refusés ou abandonnés) : la condition de
  // l'étape « sous-titres ».
  const subtitleRequests = { asked: 0, ended: 0 };
  const isSubtitle = (r) => r.url().includes("/stream/subtitle/");
  page.on("request", (r) => isSubtitle(r) && subtitleRequests.asked++);
  page.on("requestfinished", (r) => isSubtitle(r) && subtitleRequests.ended++);
  page.on("requestfailed", (r) => isSubtitle(r) && subtitleRequests.ended++);
  const done = (how) => ({ steps, timings: cx.timings, consoleErrors, how, forcedClicks: cx.forcedClicks, ms: Date.now() - t0 });
  try {
    await page.goto(`${BASE}/${title.hash}`, { waitUntil: "load" });
    // L'ouverture du cinéma est finie quand la page a envoyé sa ligne `ouverture` (startup.log :
    // catalogue, « Reprendre », « À suivre » reçus). Appuyer sur « Lire » avant, c'est jouer contre
    // ce qui se monte encore.
    const startupUntil = Date.now() + 20000;
    while (!startupSent && Date.now() < startupUntil) await sleep(POLL);
    mark(startupSent ? "· ouverture écrite" : "· ouverture non vue");
    let found = null;
    const openUntil = Date.now() + 30000;
    while (!found && Date.now() < openUntil) {
      found = await findPlayButton(page);
      if (!found) await sleep(200);
    }
    if (!found) {
      step("ouvrir", "bouton absent");
      await page.screenshot({ path: `${OUT}/${profile}-${title.key}-ouvrir.png` });
      return done(null);
    }
    const { button: playBtn, how } = found;
    await press(page, profile, playBtn);
    step("ouvrir", "fait");

    // L'issue de la première image est fixée sans attendre le plafond quand l'instance a écrit une
    // ligne `error` pour cette séance (le lecteur serveur renonce à 20 s sans image), ou quand le
    // lecteur serveur n'a rien montré 40 s après sa dernière négociation — son propre chien de garde
    // est de 20 s, et une marche de l'échelle en relance une.
    const giveUpFirst = async () => {
      const lines = playerLinesSince(logFrom);
      if (lines.some((l) => l.kind === "error")) return true;
      const serverStarts = lines.filter((l) => l.kind === "start" && l.player === "serveur");
      if (serverStarts.length === 0) return false;
      return Date.now() - Date.parse(serverStarts[serverStarts.length - 1].timestamp) > 40000;
    };
    const first = await waitPlaying(page, 90000, 0.4, giveUpFirst);
    step("première image", first ? "fait" : "délai dépassé", first ? { source: first.src } : {});
    if (!first) {
      await waitLogsQuiet(1500, 5000);
      await page.screenshot({ path: `${OUT}/${profile}-${title.key}-premiere-image.png` });
      return done(how);
    }

    // Chaque étape laisse ensuite le film jouer un peu (`settle`) : la suivante part d'un lecteur posé.
    await settle(page, 2);
    step("saut 40 %", await seekBar(page, profile, 0.4));
    await settle(page, 1.5);
    step("saut 75 %", await seekBar(page, profile, 0.75));
    await settle(page, 1.5);
    await showControls(page, profile);
    const beforeBack = await video(page);
    await page.keyboard.press("ArrowLeft");
    step("saut −10 s", (await waitSeek(page, beforeBack?.t ?? 0, SEEK_CAP_MS)) ? "fait" : "délai dépassé");
    await settle(page, 1.5);

    // La pause : 3 s pleines une fois l'élément constaté arrêté (la durée est le geste).
    await page.keyboard.press("k");
    let pausedNow = null;
    const pauseUntil = Date.now() + 3000;
    while (Date.now() < pauseUntil) {
      pausedNow = await video(page);
      if (pausedNow?.paused) break;
      await sleep(POLL);
    }
    if (pausedNow?.paused) await sleep(3000);
    await page.keyboard.press("k");
    step("pause 3 s", pausedNow?.paused ? ((await waitPlaying(page, 20000)) ? "fait" : "reprise non vue") : "pas en pause");

    const audioFrom = logSize("player.log");
    const audio = await menuChoose(page, profile, "audio", (rows) => rows.find((r) => !r.on));
    if (audio.outcome === "choisi") {
      // Le changement est constaté dans le journal : `audio` (remux, appliqué ou refusé — écrit une
      // fois le nouveau son en place), la renégociation du lecteur serveur (`start`), ou un relais.
      // Ensuite seulement, l'horloge : avant, c'est encore l'ancienne piste qui avance.
      const seen = await waitLogLine(
        audioFrom,
        (l) => l.kind === "audio" || (l.kind === "start" && l.player === "serveur") || l.kind === "fallback" || l.kind === "error",
        15000,
      );
      mark(`· journal ${seen ? seen.kind : "rien"}`);
      step("piste son", (await waitPlaying(page, 60000)) ? "fait" : "délai dépassé", { pistes: audio.rows });
    } else step("piste son", audio.outcome, { pistes: audio.rows ?? 0 });
    await settle(page, 1.5);

    const subsAsked = subtitleRequests.asked;
    const subOn = await menuChoose(page, profile, "captions", (rows) => rows.find((r) => !r.on && !/^Aucun/.test(r.label)) ?? null);
    if (subOn.outcome === "choisi") {
      // Allumés : un fichier à côté du film est demandé au choix même (`chooseSubtitle`) ; on attend
      // qu'il soit arrivé. Une piste du film ne demande rien : ses lignes viennent avec les segments,
      // et aucune condition ne dit qu'elles sont prêtes — une seconde pour voir partir une demande.
      const askUntil = Date.now() + 1000;
      while (subtitleRequests.asked === subsAsked && Date.now() < askUntil) await sleep(50);
      const subUntil = Date.now() + 10000;
      while (subtitleRequests.ended < subtitleRequests.asked && Date.now() < subUntil) await sleep(POLL);
      mark(`· sous-titres ${subtitleRequests.asked === subsAsked ? "piste du film" : subtitleRequests.ended < subtitleRequests.asked ? "plafond" : "fichier reçu"}`);
      const subOff = await menuChoose(page, profile, "captions", (rows) => rows.find((r) => /^Aucun/.test(r.label)) ?? null);
      step("sous-titres", subOff.outcome === "choisi" ? "allumés puis éteints" : `allumés, ${subOff.outcome}`);
    } else step("sous-titres", subOn.outcome);
    await settle(page, 1.5);

    await setHidden(page, true);
    await sleep(6000); // l'arrière-plan : la durée est le geste
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
        const nextFrom = logSize("player.log");
        await press(page, profile, next.first());
        // L'épisode suivant est parti quand sa séance a écrit `start` ; l'horloge de l'ancien
        // épisode, encore à l'écran, ne compte pas.
        await waitLogLine(nextFrom, (l) => l.kind === "start", 20000);
        step("épisode suivant", (await waitPlaying(page, 90000)) ? "fait" : "délai dépassé");
      } else step("épisode suivant", "absent");
    } else {
      step("retour au début", await seekBar(page, profile, 0.003));
    }
    await settle(page, 1);

    await showControls(page, profile);
    const close = page.locator('[data-player-nav="close"]');
    if (await close.first().isVisible().catch(() => false)) {
      const closeFrom = logSize("player.log");
      await press(page, profile, close.first());
      step("fermer", "fait");
      // La ligne `stop` part à la fermeture ; puis ce qui la suit de près.
      await waitLogLine(closeFrom, (l) => l.kind === "stop", 10000);
      await waitLogsQuiet(500, 3000);
    } else step("fermer", "absent");
    return done(how);
  } catch (e) {
    // Revenu à l'écran de connexion : la session est tombée en route (vu une fois sur WebKit pour
    // Linux, une requête du flux refusée « due to access control checks »). Nommé à part, pour ne
    // pas le confondre avec une commande devenue introuvable.
    const lost = /\/login/.test(page.url());
    step(lost ? "session perdue" : "exception", lost ? "retour à l'écran de connexion" : String(e.message).split("\n")[0].slice(0, 160));
    await page.screenshot({ path: `${OUT}/${profile}-${title.key}-exception.png` }).catch(() => {});
    return done(null);
  } finally {
    await ctx.close().catch(() => {});
  }
}

const results = [];

async function runCase(browser, def, state, profile, version, title) {
  const cx = {
    t0: Date.now(),
    timings: [],
    forcedClicks: 0,
    agent: null,
    logFrom: { player: logSize("player.log"), server: logSize("server.log") },
  };
  return caseCtx.run(cx, async () => {
    const r = await playCase(browser, def, state, profile, title);
    // Ce que la fermeture de la page envoie encore (un `stop` de page fermée) : le journal au calme.
    await waitLogsQuiet(1000, 3000);
    const out = {
      profile,
      version,
      key: title.key,
      title: title.title,
      ...r,
      playerLines: myLogSlice("player.log", cx.logFrom.player),
      serverLines: myLogSlice("server.log", cx.logFrom.server),
    };
    console.log(`${profile} ${title.key} ${Math.round(r.ms / 1000)} s — ${r.steps.map((s) => `${s.step}: ${s.outcome}`).join(" · ")}`);
    return out;
  });
}

// Ce que ce passage doit jouer : la comparaison ne compte pas comme manquant ce qu'un passage
// partiel (mode rapide, REGRESS_ONLY, REGRESS_PROFILES) n'a jamais prévu de jouer.
const planned = PROFILES.flatMap((p) => TITLES.filter((t) => !ONLY.length || ONLY.includes(t.key)).map((t) => `${p}/${t.key}`));
fs.writeFileSync(`${OUT}/plan.json`, JSON.stringify(planned, null, 1));

// Les profils l'un après l'autre. Deux voies en parallèle (deux navigateurs en même temps sur la
// même instance) ont été essayées le 23/10/2026 et écartées : 25 % de temps gagné seulement, et
// 6 séances sur 36 sorties autrement que les passages à la file — décodage 4K de WebKit et
// transcodage de Jellyfin se disputant la machine (README, « Ce qui a été essayé »).
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
    results.push(await runCase(browser, def, state, profile, version, title));
    fs.writeFileSync(`${OUT}/brut.json`, JSON.stringify(results, null, 1));
  }
  await logout(browser, def, state);
  await browser.close();
}
fs.writeFileSync(`${OUT}/brut.json`, JSON.stringify(results, null, 1));
