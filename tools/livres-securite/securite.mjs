// Banc de sécurité du lecteur de livres (DECISIONS.md §127 et §128), en vrais navigateurs — voir README.md.
//
// Ouvre l'EPUB piégé (`make-epub.py`) dans le lecteur de Chromium, Firefox et WebKit, deux fois : sur la
// page `/livres` seule, et dans le cadre que le cinéma pose sur lui-même (`/#livres=1&livre=…&lire=1`,
// `ReaderFrame`). Vérifie : aucun script du livre ne s'est exécuté — ni dans la page du lecteur, ni dans
// la fenêtre du cinéma au-dessus —, rien n'est sorti de l'application (requêtes vues par le navigateur ;
// l'espion, à côté, compte ce qui l'aurait atteint), un lien `javascript:` ou externe touché ne fait rien
// et ne déplace aucune des deux fenêtres. Puis il éprouve les barrières une à une, sans le nettoyage : le
// chapitre brut dans un cadre comme celui du lecteur (`allow-same-origin` seul), puis comme celui de
// foliate-js d'origine (`allow-same-origin allow-scripts`) — ce dernier pour montrer ce que le correctif
// retire. Dans le cadre, le chapitre brut vise aussi `top` : la fenêtre du cinéma.
//
// Variables : BASE (l'instance), CREDS (fichier user=/password=), BOOK (identifiant du livre), RAW (le
// chapitre brut), SPY (l'origine de l'espion), OUT (dossier des résultats). Avec EPUB (le fichier piégé),
// le livre n'a pas besoin d'être dans Jellyfin : le navigateur reçoit ce fichier à la place de celui du
// livre BOOK (ou d'un livre jamais ouvert de l'accueil) quand il le demande au relais
// (`/api/books/<id>/file`) — le même chemin, depuis la réponse jusqu'aux chapitres. Le service worker est
// alors tenu à l'écart, pour que la substitution voie toutes les requêtes.
import { chromium, firefox, webkit } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE;
const SPY = process.env.SPY;
const OUT = process.env.OUT ?? "/out";
const RAW = fs.readFileSync(process.env.RAW, "utf8");
// Le même chapitre, ses scripts tournés vers la fenêtre du dessus.
const RAW_TOP = RAW.replaceAll("parent.document", "top.document");
const EPUB = process.env.EPUB ? fs.readFileSync(process.env.EPUB) : null;
const cred = Object.fromEntries(
  fs.readFileSync(process.env.CREDS, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickBook(ctx) {
  if (process.env.BOOK) return process.env.BOOK;
  // Un livre sans position : celle d'un autre fichier ne voudrait rien dire dans le livre piégé.
  const home = await (await ctx.request.get(`${BASE}/api/books/home`)).json();
  const all = [...(home.recent ?? []), ...(home.rows ?? []).flatMap((r) => r.books)];
  const id = all.find((b) => !b.progress)?.id;
  if (!id) throw new Error("aucun livre sans position dans l'accueil");
  return id;
}

async function run(name, engine, mode) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "fr-FR", ...(EPUB ? { serviceWorkers: "block" } : {}) });
  const login = await ctx.request.post(`${BASE}/api/auth/jellyfin`, { data: { username: cred.user, password: cred.password }, headers: { Origin: BASE } });
  if (!login.ok()) throw new Error(`connexion refusée (${login.status()})`);
  // L'écran de passage du cinéma (une fois par compte) ne doit pas recouvrir le lecteur.
  await ctx.request.post(`${BASE}/api/onboarding`, { headers: { Origin: BASE } }).catch(() => {});
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("cine-install-prompt-dismissed-until", "9999999999999");
    } catch {}
  });
  const book = await pickBook(ctx);
  if (EPUB) await ctx.route(`**/api/books/${book}/file`, (route) => route.fulfill({ status: 200, contentType: "application/epub+zip", body: EPUB }));
  const page = await ctx.newPage();
  const requests = [];
  const popups = [];
  const consoleLines = [];
  page.on("request", (r) => requests.push(r.url()));
  // Chromium annonce aussi les requêtes que la politique de la page arrête (`net::ERR_BLOCKED_BY_CSP`) :
  // elles sont comptées à part, l'espion dit si l'une d'elles est vraiment partie.
  const failed = new Map();
  page.on("requestfailed", (r) => failed.set(r.url(), r.failure()?.errorText ?? "?"));
  page.on("console", (m) => consoleLines.push(m.text()));
  ctx.on("page", (p) => popups.push(p.url()));

  await page.goto(mode === "cadre" ? `${BASE}/#livres=1&livre=${book}&lire=1` : `${BASE}/livres#livre=${book}&lire=1`);
  // Le document du lecteur : la page elle-même, ou le cadre posé sur le cinéma.
  let reader = page.mainFrame();
  if (mode === "cadre") {
    await page.waitForSelector("[data-reader-frame] iframe", { timeout: 30000 });
    const handle = await page.$("[data-reader-frame] iframe");
    reader = await handle.contentFrame();
  }
  // Le chapitre piégé est affiché quand son texte est lisible dans le cadre.
  await reader.waitForFunction(() => {
    const v = document.querySelector("foliate-view");
    return v?.renderer?.getContents?.()?.some((c) => c.doc?.body?.textContent?.includes("Chapitre piégé"));
  }, null, { timeout: 30000 });
  await sleep(3500); // le rafraîchissement du chapitre est à 2 s

  // La fenêtre du dessus : une marque posée dans son document dit qu'elle n'a pas été rechargée ni remplacée.
  const topMarks = () =>
    page.evaluate(() => ({ pwned: document.documentElement.getAttribute("data-pwned"), title: document.title, href: location.href, marker: window.__banc ?? null, timeOrigin: performance.timeOrigin }));
  await page.evaluate(() => (window.__banc = "intact"));
  const topBefore = await topMarks();
  const inReader = await reader.evaluate(() => {
    const v = document.querySelector("foliate-view");
    const { doc } = v.renderer.getContents()[0];
    const frame = doc.defaultView.frameElement;
    const handlers = [...doc.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.localName}@${a.name}`));
    // Le cadre du lecteur est à l'origine de la fenêtre du cinéma (posé plein écran en 0,0) : mêmes coordonnées.
    const rect = (sel) => {
      const el = doc.querySelector(sel);
      if (!el) return null;
      const f = frame.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2, href: el.getAttribute("href") };
    };
    return {
      framed: window.top !== window,
      sandbox: frame.getAttribute("sandbox"),
      frameSrcScheme: (frame.getAttribute("src") ?? "").split(":")[0],
      pwned: document.documentElement.getAttribute("data-pwned"),
      frameTitle: doc.title,
      scripts: doc.querySelectorAll("script").length,
      handlers,
      jsLink: rect("#lien-js"),
      externalLink: rect("#lien-externe"),
      bodyHasText: doc.body.textContent.includes("Fin du chapitre piégé"),
    };
  });
  if (mode === "cadre" && !inReader.framed) throw new Error("le lecteur n'est pas dans un cadre");

  // Toucher les deux liens, là où ils sont affichés.
  const urlBefore = page.url();
  const readerUrlBefore = reader.url();
  for (const link of [inReader.jsLink, inReader.externalLink]) {
    if (link) {
      await page.mouse.click(link.x, link.y);
      await sleep(800);
    }
  }
  const afterClicks = {
    url: page.url(),
    sameUrl: page.url() === urlBefore,
    readerSameUrl: reader.url() === readerUrlBefore,
    pwned: await reader.evaluate(() => document.documentElement.getAttribute("data-pwned")),
    popups: [...popups],
  };
  const topAfter = await topMarks();
  await page.screenshot({ path: `${OUT}/${name}-${mode}-lecteur.png` });

  // Les barrières sans le nettoyage : le chapitre brut, dans un cadre du document du lecteur.
  const layer = async (sandbox, raw) =>
    reader.evaluate(
      async ({ raw, sandbox }) => {
        document.documentElement.removeAttribute("data-pwned");
        window.top.document.documentElement.removeAttribute("data-pwned");
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", sandbox);
        frame.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;opacity:0.01";
        frame.src = URL.createObjectURL(new Blob([raw], { type: "application/xhtml+xml" }));
        const violations = [];
        document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
        document.body.append(frame);
        await new Promise((r) => setTimeout(r, 3500));
        let frameTitle = null;
        try {
          frameTitle = frame.contentDocument?.title ?? null;
        } catch {
          frameTitle = "(inaccessible)";
        }
        const pwned = document.documentElement.getAttribute("data-pwned");
        const pwnedTop = window.top === window ? null : window.top.document.documentElement.getAttribute("data-pwned");
        frame.remove();
        return { sandbox, pwned, pwnedTop, frameTitle, violations: violations.length };
      },
      { raw, sandbox }
    );
  const isOutside = (u) => !u.startsWith(BASE) && !u.startsWith("blob:") && !u.startsWith("data:") && !u.startsWith("about:");
  // Une requête vers l'extérieur que le navigateur a annoncée doit avoir échoué (politique de la page).
  const notBlocked = (urls) => urls.filter((u) => isOutside(u) && !failed.has(u));
  const raw = mode === "cadre" ? RAW_TOP : RAW;
  const beforeRaw = requests.length;
  const rawSandboxed = await layer("allow-same-origin", raw);
  rawSandboxed.outsideAttempts = requests.slice(beforeRaw).filter(isOutside).length;
  rawSandboxed.outsideNotBlocked = notBlocked(requests.slice(beforeRaw));
  // Ce qui suit exécute volontairement le script du chapitre (cadre de foliate-js d'origine) : ses
  // requêtes sont comptées à part, et seule la politique de la page doit les arrêter hors de l'application.
  const beforeUpstream = requests.length;
  const rawUpstream = await layer("allow-same-origin allow-scripts", raw);
  rawUpstream.sameOriginRequests = requests.slice(beforeUpstream).filter((u) => /pwned/.test(u));
  rawUpstream.outsideAttempts = requests.slice(beforeUpstream).filter(isOutside).length;
  rawUpstream.outsideNotBlocked = notBlocked(requests.slice(beforeUpstream));
  rawUpstream.blockedReasons = [...new Set(requests.slice(beforeUpstream).filter(isOutside).map((u) => failed.get(u)))];
  // Le lecteur lui-même (contenu nettoyé) : rien ne doit même être tenté vers l'extérieur.
  const checked = requests.slice(0, beforeRaw);

  const outside = checked.filter(isOutside);
  const result = {
    browser: name,
    mode,
    book,
    planted: !!EPUB,
    inReader,
    afterClicks,
    top: { before: topBefore, after: topAfter },
    rawSandboxed,
    rawUpstream,
    outsideRequests: outside,
    spyRequestsSeenByBrowser: checked.filter((u) => u.startsWith(SPY)),
    pwnedRequests: checked.filter((u) => /pwned/.test(u)),
    cspConsoleLines: consoleLines.filter((l) => /Content Security Policy|CSP|Refused|blocked/i.test(l)).length,
  };
  result.verdict =
    inReader.sandbox === "allow-same-origin" &&
    inReader.pwned === null &&
    inReader.frameTitle !== "PWNED" &&
    inReader.scripts === 0 &&
    inReader.handlers.length === 0 &&
    inReader.bodyHasText &&
    afterClicks.pwned === null &&
    afterClicks.sameUrl &&
    afterClicks.readerSameUrl &&
    afterClicks.popups.length === 0 &&
    // La fenêtre du dessus (le cinéma, en mode cadre) : rien n'y est écrit, elle n'a pas bougé.
    topAfter.pwned === null &&
    topAfter.href === topBefore.href &&
    topAfter.marker === "intact" &&
    topAfter.timeOrigin === topBefore.timeOrigin &&
    rawSandboxed.pwned === null &&
    rawSandboxed.pwnedTop === null &&
    rawSandboxed.frameTitle !== "PWNED" &&
    rawSandboxed.outsideNotBlocked.length === 0 &&
    rawUpstream.outsideNotBlocked.length === 0 &&
    outside.length === 0 &&
    result.pwnedRequests.length === 0
      ? "OK"
      : "ÉCHEC";
  fs.writeFileSync(`${OUT}/${name}-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(`${name} (${mode}): ${result.verdict}`);
  await browser.close();
  return result;
}

const MODES = (process.env.MODES ?? "page,cadre").split(",");
const results = [];
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  for (const mode of MODES) {
    try {
      results.push(await run(name, engine, mode));
    } catch (err) {
      console.log(`${name} (${mode}): ERREUR ${err.message}`);
      results.push({ browser: name, mode, verdict: "ERREUR", error: err.message });
    }
  }
}
fs.writeFileSync(
  `${OUT}/resume.json`,
  JSON.stringify(
    results.map((r) => ({ browser: r.browser, mode: r.mode, verdict: r.verdict, upstreamScriptRan: r.rawUpstream?.pwned ?? null, upstreamReachedTop: r.rawUpstream?.pwnedTop ?? null })),
    null,
    2
  )
);
process.exit(results.every((r) => r.verdict === "OK") ? 0 : 1);
