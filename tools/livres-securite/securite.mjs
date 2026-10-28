// Banc de sécurité du lecteur de livres (DECISIONS.md §127), en vrais navigateurs — voir README.md.
//
// Ouvre l'EPUB piégé (`make-epub.py`) dans le lecteur de Chromium, Firefox et WebKit, et vérifie :
// aucun script du livre ne s'est exécuté, rien n'est sorti de l'application (requêtes vues par le
// navigateur ; l'espion, à côté, compte ce qui l'aurait atteint), un lien `javascript:` ou externe
// touché ne fait rien. Puis il éprouve les barrières une à une, sans le nettoyage : le chapitre brut
// dans un cadre comme celui du lecteur (`allow-same-origin` seul), puis comme celui de foliate-js
// d'origine (`allow-same-origin allow-scripts`) — ce dernier pour montrer ce que le correctif retire.
//
// Variables : BASE (l'instance), CREDS (fichier user=/password=), BOOK (identifiant du livre piégé),
// RAW (le chapitre brut), SPY (l'origine de l'espion), OUT (dossier des résultats).
import { chromium, firefox, webkit } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE;
const BOOK = process.env.BOOK;
const SPY = process.env.SPY;
const OUT = process.env.OUT ?? "/out";
const RAW = fs.readFileSync(process.env.RAW, "utf8");
const cred = Object.fromEntries(
  fs.readFileSync(process.env.CREDS, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, engine) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "fr-FR" });
  const login = await ctx.request.post(`${BASE}/api/auth/jellyfin`, { data: { username: cred.user, password: cred.password }, headers: { Origin: BASE } });
  if (!login.ok()) throw new Error(`connexion refusée (${login.status()})`);
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

  await page.goto(`${BASE}/livres#livre=${BOOK}&lire`);
  // Le chapitre piégé est affiché quand son texte est lisible dans le cadre.
  await page.waitForFunction(() => {
    const v = document.querySelector("foliate-view");
    return v?.renderer?.getContents?.()?.some((c) => c.doc?.body?.textContent?.includes("Chapitre piégé"));
  }, null, { timeout: 30000 });
  await sleep(3500); // le rafraîchissement du chapitre est à 2 s

  const inReader = await page.evaluate(() => {
    const v = document.querySelector("foliate-view");
    const { doc } = v.renderer.getContents()[0];
    const frame = doc.defaultView.frameElement;
    const handlers = [...doc.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.localName}@${a.name}`));
    const rect = (sel) => {
      const el = doc.querySelector(sel);
      if (!el) return null;
      const f = frame.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2, href: el.getAttribute("href") };
    };
    return {
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

  // Toucher les deux liens, là où ils sont affichés.
  const urlBefore = page.url();
  for (const link of [inReader.jsLink, inReader.externalLink]) {
    if (link) {
      await page.mouse.click(link.x, link.y);
      await sleep(800);
    }
  }
  const afterClicks = { url: page.url(), sameUrl: page.url() === urlBefore, pwned: await page.evaluate(() => document.documentElement.getAttribute("data-pwned")), popups: [...popups] };
  await page.screenshot({ path: `${OUT}/${name}-lecteur.png` });

  // Les barrières sans le nettoyage : le chapitre brut, dans un cadre de la page.
  const layer = async (sandbox) =>
    page.evaluate(
      async ({ raw, sandbox }) => {
        document.documentElement.removeAttribute("data-pwned");
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
        frame.remove();
        return { sandbox, pwned, frameTitle, violations: violations.length };
      },
      { raw: RAW, sandbox }
    );
  const isOutside = (u) => !u.startsWith(BASE) && !u.startsWith("blob:") && !u.startsWith("data:");
  // Une requête vers l'extérieur que le navigateur a annoncée doit avoir échoué (politique de la page).
  const notBlocked = (urls) => urls.filter((u) => isOutside(u) && !failed.has(u));
  const beforeRaw = requests.length;
  const rawSandboxed = await layer("allow-same-origin");
  rawSandboxed.outsideAttempts = requests.slice(beforeRaw).filter(isOutside).length;
  rawSandboxed.outsideNotBlocked = notBlocked(requests.slice(beforeRaw));
  // Ce qui suit exécute volontairement le script du chapitre (cadre de foliate-js d'origine) : ses
  // requêtes sont comptées à part, et seule la politique de la page doit les arrêter hors de l'application.
  const beforeUpstream = requests.length;
  const rawUpstream = await layer("allow-same-origin allow-scripts");
  rawUpstream.sameOriginRequests = requests.slice(beforeUpstream).filter((u) => /pwned/.test(u));
  rawUpstream.outsideAttempts = requests.slice(beforeUpstream).filter(isOutside).length;
  rawUpstream.outsideNotBlocked = notBlocked(requests.slice(beforeUpstream));
  rawUpstream.blockedReasons = [...new Set(requests.slice(beforeUpstream).filter(isOutside).map((u) => failed.get(u)))];
  // Le lecteur lui-même (contenu nettoyé) : rien ne doit même être tenté vers l'extérieur.
  const checked = requests.slice(0, beforeRaw);

  const outside = checked.filter(isOutside);
  const result = {
    browser: name,
    inReader,
    afterClicks,
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
    afterClicks.popups.length === 0 &&
    rawSandboxed.pwned === null &&
    rawSandboxed.frameTitle !== "PWNED" &&
    rawSandboxed.outsideNotBlocked.length === 0 &&
    rawUpstream.outsideNotBlocked.length === 0 &&
    outside.length === 0 &&
    result.pwnedRequests.length === 0
      ? "OK"
      : "ÉCHEC";
  fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(result, null, 2));
  console.log(`${name}: ${result.verdict}`);
  await browser.close();
  return result;
}

const results = [];
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  try {
    results.push(await run(name, engine));
  } catch (err) {
    console.log(`${name}: ERREUR ${err.message}`);
    results.push({ browser: name, verdict: "ERREUR", error: err.message });
  }
}
fs.writeFileSync(`${OUT}/resume.json`, JSON.stringify(results.map((r) => ({ browser: r.browser, verdict: r.verdict, upstreamScriptRan: r.rawUpstream?.pwned ?? null })), null, 2));
process.exit(results.every((r) => r.verdict === "OK") ? 0 : 1);
