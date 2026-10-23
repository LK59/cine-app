/**
 * Les « Nouveautés » — ce qu'une page contient, et comment on la lit (DECISIONS.md §73).
 *
 * Partagé par le serveur (stockage, validation, traduction) et le navigateur (fenêtre, page Compte,
 * éditeur de l'administrateur) : rien ici ne touche au disque ni au réseau.
 *
 * Une page = une version annoncée (« 8.44 ») et, par langue, des sections d'entrées courtes
 * (icône, titre, phrase) plus la liste « Optimisations et corrections de bugs ». Le titre de la
 * section Améliorations et de son entrée viennent du dictionnaire : ce sont des mots de
 * l'interface, toujours les mêmes, et non du contenu à retaper à chaque page.
 */

export const NEWS_LANGS = ["fr", "en", "es", "de"] as const;
export type NewsLang = (typeof NEWS_LANGS)[number];

/**
 * Les icônes qu'une entrée peut porter — une courte liste, choisie dans l'éditeur. Des noms à nous
 * plutôt que ceux de lucide : la base ne doit pas dépendre du nom d'un composant qu'une mise à
 * jour de la bibliothèque renommerait.
 */
export const NEWS_ICONS = [
  "sparkles",
  "audio",
  "subtitles",
  "next",
  "cast",
  "logo",
  "captions",
  "sheets",
  "speed",
  "battery",
  "shield",
  "tv",
  "phone",
  "bell",
  "search",
  "palette",
  "wrench",
  "heart",
] as const;
export type NewsIcon = (typeof NEWS_ICONS)[number];

export interface NewsEntry {
  icon: NewsIcon;
  /** En gras. */
  title: string;
  /**
   * La phrase qui suit. Commençant par une minuscule ou une ponctuation, elle *continue* le titre
   * sur la même ligne (« **Le logo du titre dans le lecteur**, en bas à gauche. ») ; sinon elle
   * passe dessous, en plus discret (« **Épisode suivant** / Passer le récap… »).
   */
  text: string;
  /** Une pastille après le titre (« bêta »), vide sinon. */
  badge: string;
  /**
   * Une adresse https que l'entrée cite (23/10/2026, la page Laterna) : là où son hôte paraît dans le
   * titre ou la phrase, il devient un lien qui l'ouvre. Absente sinon.
   */
  link?: string;
}

/** Une adresse https sans identifiants, bornée — sinon rien : le contenu vient aussi de l'éditeur. */
export function newsLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 200) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export interface NewsSection {
  /** Affiché en petites capitales (« Nouveau », « Design »). */
  title: string;
  entries: NewsEntry[];
}

export interface NewsFixGroup {
  /** « Lecture », « Accueil et fiches »… */
  title: string;
  items: string[];
}

export interface NewsContent {
  sections: NewsSection[];
  /** La phrase de l'entrée « Optimisations et corrections de bugs » (« Plus rapide, plus fiable. »). */
  fixesSummary: string;
  /** La liste complète, montrée en entier dans Compte → Nouveautés. */
  fixes: NewsFixGroup[];
}

/** Le français est obligatoire ; une autre langue absente ou vide retombe sur lui. */
export type NewsContentByLang = { fr: NewsContent } & Partial<Record<Exclude<NewsLang, "fr">, NewsContent | null>>;

/** Une page publiée telle que le navigateur la reçoit. */
export interface NewsPageView {
  id: number;
  /** L'ordre de publication — c'est lui que « dernière page vue » compare, pas l'identifiant. */
  seq: number;
  version: string;
  publishedAt: number;
  content: NewsContentByLang;
}

/** Ce que `/api/release-notes` répond au compte connecté. */
export interface NewsPayload {
  /** Les pages publiées, de la plus récente à la plus ancienne. */
  pages: NewsPageView[];
  /** Les identifiants des pages que ce compte n'a pas encore vues, même ordre. */
  unseen: number[];
  /** Vrai quand l'administrateur a relancé la fenêtre pour ce compte depuis son dernier affichage. */
  relaunched: boolean;
}

export const EMPTY_CONTENT: NewsContent = { sections: [], fixesSummary: "", fixes: [] };

/** Les bornes : une page se lit en trente secondes, et la base ne reçoit jamais un roman. */
export const NEWS_LIMITS = {
  version: 20,
  sections: 8,
  entries: 12,
  sectionTitle: 40,
  entryTitle: 90,
  entryText: 240,
  badge: 16,
  fixesSummary: 160,
  fixGroups: 10,
  fixItems: 40,
  fixItem: 240,
} as const;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function isNewsIcon(v: unknown): v is NewsIcon {
  return typeof v === "string" && (NEWS_ICONS as readonly string[]).includes(v);
}

/**
 * Ce qu'un corps de requête dit d'un contenu, nettoyé et borné. Les entrées sans titre et les
 * sections sans entrée tombent : un champ laissé vide dans l'éditeur n'est pas une entrée.
 */
export function sanitizeContent(raw: unknown): NewsContent {
  const o = obj(raw);
  const sections = arr(o.sections)
    .slice(0, NEWS_LIMITS.sections)
    .map((s) => {
      const so = obj(s);
      const entries = arr(so.entries)
        .slice(0, NEWS_LIMITS.entries)
        .map((e) => {
          const eo = obj(e);
          const link = newsLink(eo.link);
          return {
            icon: isNewsIcon(eo.icon) ? eo.icon : "sparkles",
            title: str(eo.title, NEWS_LIMITS.entryTitle),
            text: str(eo.text, NEWS_LIMITS.entryText),
            badge: str(eo.badge, NEWS_LIMITS.badge),
            ...(link ? { link } : {}),
          } satisfies NewsEntry;
        })
        .filter((e) => e.title !== "");
      return { title: str(so.title, NEWS_LIMITS.sectionTitle), entries };
    })
    .filter((s) => s.entries.length > 0);
  const fixes = arr(o.fixes)
    .slice(0, NEWS_LIMITS.fixGroups)
    .map((g) => {
      const go = obj(g);
      return {
        title: str(go.title, NEWS_LIMITS.sectionTitle),
        items: arr(go.items)
          .slice(0, NEWS_LIMITS.fixItems)
          .map((i) => str(i, NEWS_LIMITS.fixItem))
          .filter((i) => i !== ""),
      };
    })
    .filter((g) => g.items.length > 0);
  return { sections, fixesSummary: str(o.fixesSummary, NEWS_LIMITS.fixesSummary), fixes };
}

/** Rien à montrer : ni entrée, ni liste de corrections. */
export function isEmptyContent(c: NewsContent | null | undefined): boolean {
  return !c || (c.sections.length === 0 && c.fixes.length === 0 && c.fixesSummary === "");
}

/** Le contenu par langue d'un corps de requête : le français toujours, les autres s'ils disent quelque chose. */
export function sanitizeByLang(raw: unknown): NewsContentByLang {
  const o = obj(raw);
  const out: NewsContentByLang = { fr: sanitizeContent(o.fr) };
  for (const lang of NEWS_LANGS) {
    if (lang === "fr") continue;
    const c = sanitizeContent(o[lang]);
    out[lang] = isEmptyContent(c) ? null : c;
  }
  return out;
}

/** La langue de l'interface, ou le français quand la page n'a rien dans cette langue. */
export function contentFor(byLang: NewsContentByLang, locale: string): NewsContent {
  const lang = (NEWS_LANGS as readonly string[]).includes(locale) ? (locale as NewsLang) : "fr";
  const c = lang === "fr" ? byLang.fr : byLang[lang];
  return c && !isEmptyContent(c) ? c : byLang.fr;
}

/** La section Améliorations existe-t-elle sur cette page ? */
export function hasFixes(c: NewsContent): boolean {
  return c.fixes.length > 0 || c.fixesSummary !== "";
}

/**
 * La phrase continue-t-elle le titre sur la même ligne ? Une minuscule, une virgule, un tiret, un
 * point-virgule : c'est la suite de la phrase en gras, pas une phrase à elle.
 */
export function continuesTitle(text: string): boolean {
  const first = text.trimStart().charAt(0);
  if (first === "") return false;
  if (/[,;:)\-–—]/.test(first)) return true;
  return first !== first.toLocaleUpperCase() && first === first.toLocaleLowerCase();
}

/** Comment la suite se colle au titre : sans espace devant une ponctuation, avec un espace sinon. */
export function joinContinuation(text: string): string {
  const t = text.trimStart();
  return /^[,;:)]/.test(t) ? t : ` ${t}`;
}
