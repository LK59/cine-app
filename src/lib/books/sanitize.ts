/**
 * Le contenu d'un EPUB, nettoyé avant d'être montré (DECISIONS.md §127).
 *
 * Un livre est du XHTML venu d'ailleurs : n'importe qui peut y glisser un `<script>`, un `onload=`,
 * un lien `javascript:`, une image ou une feuille de style chargées depuis un serveur tiers (qui
 * apprendrait ainsi qui lit quoi, et quand). Trois barrières indépendantes l'arrêtent, et celle-ci
 * est la première :
 *
 * 1. ici, chaque document et chaque feuille de style du livre est réécrit avant d'exister comme page —
 *    plus de script, plus d'attribut `on…`, plus d'adresse qui sorte du livre ;
 * 2. le cadre qui l'affiche n'a pas `allow-scripts` (correctif local de foliate-js, README.md) ;
 * 3. la page `/livres` porte sa propre politique de sécurité (`next.config.js`), dont héritent les
 *    documents `blob:` du livre : ni script venu d'un `blob:`, ni image ou police hors de l'application.
 *
 * Une seule des trois suffirait le plus souvent ; elles sont là ensemble parce que chacune a ses
 * trous connus (un navigateur qui n'hérite pas la politique, un attribut oublié ici).
 *
 * Ce qui reste permis : les adresses que foliate-js a déjà converties vers les ressources du livre
 * (`blob:` de la même origine), les ancres internes (`#…`), les chemins relatifs qu'il n'a pas su
 * résoudre (relatifs à un `blob:`, ils ne mènent nulle part), et les images `data:`.
 */

/** Les éléments retirés avec tout leur contenu. */
const REMOVED_ELEMENTS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "portal",
  "handler",
  "listener",
  "meta[http-equiv]",
];

/** Les attributs qui désignent une ressource ou une destination. */
const URL_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "poster",
  "data",
  "action",
  "formaction",
  "background",
  "lowsrc",
  "dynsrc",
  "ping",
  "manifest",
  "codebase",
  "archive",
  "longdesc",
  "usemap",
  "srcdoc",
]);

/** Une valeur d'attribut qui exécuterait du code, une fois débarrassée des blancs et caractères de contrôle. */
function isScriptUrl(value: string): boolean {
  // Les navigateurs ignorent ces caractères dans un schéma : « java\tscript: » s'exécute.
  const compact = value.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
  return compact.startsWith("javascript:") || compact.startsWith("vbscript:") || compact.startsWith("livescript:") || compact.startsWith("data:text/html") || compact.startsWith("data:application/xhtml") || compact.startsWith("data:image/svg");
}

/**
 * L'adresse reste-t-elle dans le livre ? `blob:` de cette origine (ce que foliate-js a fabriqué),
 * une ancre, un chemin relatif ; et une image `data:` (une image incrustée ne charge rien).
 */
export function staysInBook(raw: string, origin: string | null): boolean {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) return true;
  if (isScriptUrl(value)) return false;
  // Protocole implicite : `//hôte/…` sort du livre comme `https://hôte/…`.
  if (value.startsWith("//") || value.startsWith("\\\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (scheme === "blob") return origin === null || value.slice(5).startsWith(origin + "/");
  if (scheme === "data") return /^data:(image\/(png|jpe?g|gif|webp|avif|bmp)|font\/|application\/(font|x-font))/i.test(value);
  return false;
}

/** Une liste `srcset` dont chaque adresse reste dans le livre. */
function srcsetStaysInBook(value: string, origin: string | null): boolean {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .every((url) => staysInBook(url, origin));
}

/**
 * Une feuille de style sans rien qui sorte du livre : `@import` et `url(…)` vers ailleurs, et les
 * vieilles portes vers du code (`expression()`, `-moz-binding`, `behavior`).
 */
export function sanitizeCss(css: string, origin: string | null = currentOrigin()): string {
  return (
    css
      // `@import` : la règle entière part si sa cible sort du livre.
      .replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]*)\1\s*\)?[^;]*;?/gi, (rule, _q: string, url: string) => (staysInBook(url, origin) ? rule : ""))
      .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (whole, _q: string, url: string) => (staysInBook(url, origin) ? whole : "none"))
      .replace(/expression\s*\(/gi, "invalid(")
      .replace(/-moz-binding\s*:/gi, "-invalid-binding:")
      .replace(/(^|[;{\s])behavior\s*:/gi, "$1-invalid-behavior:")
  );
}

function currentOrigin(): string | null {
  try {
    return typeof location === "undefined" ? null : location.origin;
  } catch {
    return null;
  }
}

/** Nettoie un document déjà analysé, sur place. */
export function sanitizeDocument(doc: Document, origin: string | null = currentOrigin()): void {
  for (const selector of REMOVED_ELEMENTS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) el.remove();
  }
  // Une animation SVG qui réécrit un lien (`<set attributeName="href" to="javascript:…">`).
  for (const el of Array.from(doc.querySelectorAll("set, animate, animateTransform, animateMotion"))) {
    if (/href|on/i.test(el.getAttribute("attributeName") ?? "") || isScriptUrl(el.getAttribute("to") ?? "") || isScriptUrl(el.getAttribute("values") ?? "")) el.remove();
  }
  // Les liens d'en-tête autres que les feuilles de style : préchargements et connexions anticipées
  // sortiraient du livre sans qu'aucune adresse ne s'affiche.
  for (const link of Array.from(doc.querySelectorAll("link"))) {
    if (!/(^|\s)stylesheet(\s|$)/i.test(link.getAttribute("rel") ?? "")) link.remove();
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    if (style.textContent) style.textContent = sanitizeCss(style.textContent, origin);
  }
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on")) {
        el.removeAttributeNode(attr);
        continue;
      }
      if (name === "style") {
        const clean = sanitizeCss(value, origin);
        if (clean !== value) el.setAttribute(attr.name, clean);
        continue;
      }
      if (isScriptUrl(value)) {
        el.removeAttributeNode(attr);
        continue;
      }
      const local = name.includes(":") ? name : attr.localName.toLowerCase();
      if (URL_ATTRIBUTES.has(name) || URL_ATTRIBUTES.has(local)) {
        const ok = local === "srcset" ? srcsetStaysInBook(value, origin) : local === "srcdoc" ? false : staysInBook(value, origin);
        if (!ok) el.removeAttributeNode(attr);
      }
    }
  }
}

const MARKUP_TYPES = new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]);

/**
 * Le texte d'une ressource du livre, nettoyé selon son type ; tout autre type est rendu tel quel
 * (les images et les polices sont des octets, elles n'exécutent rien).
 *
 * Un XHTML mal formé est relu en HTML, comme foliate-js le fait lui-même — sinon le navigateur
 * l'afficherait comme une page d'erreur de syntaxe au lieu du chapitre.
 */
export function sanitizeResource(text: string, type: string, origin: string | null = currentOrigin()): string {
  if (type === "text/css") return sanitizeCss(text, origin);
  if (!MARKUP_TYPES.has(type)) return text;
  const parser = new DOMParser();
  let doc = parser.parseFromString(text, type as DOMParserSupportedType);
  if (type !== "text/html" && doc.querySelector("parsererror")) doc = parser.parseFromString(text, "text/html");
  sanitizeDocument(doc, origin);
  return new XMLSerializer().serializeToString(doc);
}

/** Les types que `sanitizeResource` réécrit. */
export function isSanitizedType(type: string): boolean {
  return type === "text/css" || MARKUP_TYPES.has(type);
}
