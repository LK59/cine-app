// « Précédemment » (08/11/2026, DECISIONS.md §137) — les règles, sans réseau ni base : ce qui est
// envoyé au modèle, comment sa réponse est jugée, sous quelle clé elle est gardée.
//
// Choisies sur banc le 08/11/2026 (Haiku, une requête à la fois) : quatre séries de référence à
// une position fixée, puis dix séries réellement en cours sur les comptes, à leur vraie position.
// Ce qu'il a appris, et que chaque règle ci-dessous porte :
// - **Le résumé de l'épisode en cours n'est jamais envoyé.** Il raconte la suite de l'épisode :
//   l'envoyer, c'est gâcher ce qui reste à voir. Seuls partent les résumés d'épisodes *terminés*.
// - **Les dialogues ne disent pas qui parle.** Avec tout le début de l'épisode, le modèle prêtait des
//   répliques au mauvais personnage (Brienne pour Baelish, un mort qui gagne un procès). Avec les dix
//   minutes avant l'arrêt et la consigne de ne tirer que des faits nets, ces erreurs ont disparu.
// - **Le modèle sait des choses que les sources ne disent pas** — « Baelish », « Torfes », « Cokely »
//   sont sortis de sa mémoire. Tout nom absent des sources fait rejeter la réponse (`unknownNames`) :
//   pas de « Précédemment » plutôt qu'un faux.
// - **Un résumé officiel n'est pas toujours un résumé** : ceux de *The Boys* saison 5 sont des
//   publicités fictives de la série. Le prompt dit de les ignorer, et une réponse vide n'affiche rien.
// - **La longueur demandée n'est pas tenue** (jusqu'à 104 mots pour 60 demandés) : coupée ici.
// - Les sous-titres pour malentendants n'ont pas fait mieux en moyenne (trois pistes sur six n'en
//   avaient que l'étiquette) : la piste ordinaire de la langue du compte passe d'abord.

import type { Locale } from "@/lib/i18n";

/** Dialogues envoyés : les dix minutes qui précèdent l'arrêt. */
export const RECAP_WINDOW_S = 600;
/** Arrêté avant ça, l'épisode n'est pas commencé : seuls les résumés des épisodes finis comptent. */
export const RECAP_STARTED_S = 120;
/**
 * Préparé — et affiché — une fois la série laissée de côté depuis ce temps. Trois heures au départ,
 * dix minutes quelques heures plus tard, puis de nouveau trois heures le soir même (Louis, 08/11/2026) :
 * le texte sert après une vraie pause, pas entre deux épisodes enchaînés ; avant, la fiche garde son
 * synopsis, et rien n'est payé pour un texte que personne ne lirait.
 */
export const RECAP_IDLE_MS = 3 * 60 * 60 * 1000;
/** Un nouveau texte à chaque tranche de dix minutes avancée (Louis, 08/11/2026). */
export const RECAP_STEP_S = 600;
export const RECAP_MAX_PHRASES = 3;
export const RECAP_MAX_WORDS = 80;

/**
 * La tranche de l'arrêt dans l'épisode : 0 avant `RECAP_STARTED_S` (pas commencé), puis une par dix
 * minutes. Avancer d'une tranche demande un nouveau texte ; bouger dedans, non.
 */
export function recapStep(positionS: number): number {
  return positionS < RECAP_STARTED_S ? 0 : Math.floor(positionS / RECAP_STEP_S) + 1;
}

/**
 * La clé d'un « Précédemment » : l'épisode, la tranche d'arrêt, la langue. Partagée par tous les
 * comptes — deux personnes arrêtées au même endroit lisent le même texte, demandé une fois.
 */
export function recapKey(episodeId: string, positionS: number, locale: Locale): string {
  // `v2` (11/11/2026) : les textes d'avant coupaient à la position de l'arrêt du premier compte — voir `recapCutS`.
  return `${episodeId}:${recapStep(positionS)}:${locale}:v2`;
}

/**
 * Où s'arrêtent les dialogues envoyés : le **début** de la tranche, pas la position de l'arrêt (chasse aux défauts
 * du 11/11/2026). La clé est partagée par tous les comptes d'une même tranche : coupé à la position du premier
 * arrêté à 29:50, le texte servait jusqu'à 9 min 40 d'épisode à celui qui s'était arrêté à 20:10. Coupé au début
 * de la tranche, il ne dit rien que chacun des comptes qui le lisent n'ait vu.
 */
export function recapCutS(positionS: number): number {
  const step = recapStep(positionS);
  return step === 0 ? positionS : Math.max(RECAP_STARTED_S, (step - 1) * RECAP_STEP_S);
}

export interface Cue {
  /** La seconde entière du début (la coupe des questions et de « Précédemment » la compare). */
  startS: number;
  /**
   * Le début exact, millisecondes comprises (10.28.0) : « Jusqu'ici » coupe strictement avant le début d'une
   * scène et range chaque réplique dans sa scène — à la seconde entière, la première réplique de la scène
   * coupée passait (`startS ≤ coupe`). Absent (un double de test) : `startS`.
   */
  atS?: number;
  /** La fin exacte (10.30, « qui parle » : la voix doit couvrir la réplique). Absente : inconnue. */
  endS?: number;
  /**
   * Deux personnes dans la même réplique (10.30) : une ligne après la première commence par un tiret
   * (« - Tu viens ? / - Non. »). Jamais attribuée à une seule voix.
   */
  twoSpeakers?: boolean;
  /** Qui la dit, quand l'analyse des voix le sait avec assurance (`withSpeakers`, src/lib/ask/voices.ts). */
  speaker?: string;
  text: string;
}

/**
 * Les répliques d'un SRT (ce que Jellyfin rend pour toute piste texte, ASS compris), sans balises.
 * Les lignes d'une même réplique sont jointes : le tiret qui ouvre chacune marque un changement de
 * personne, et le modèle s'en sert.
 */
export function parseSrt(srt: string): Cue[] {
  const out: Cue[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const m = lines[at].match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const end = lines[at].match(/-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    const body = lines
      .slice(at + 1)
      .map((l) => l.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim())
      .filter(Boolean);
    const text = body.join(" ");
    if (text) {
      const startS = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      const cue: Cue = { startS, atS: startS + Number(m[4]) / 1000, text };
      if (end) cue.endS = Number(end[1]) * 3600 + Number(end[2]) * 60 + Number(end[3]) + Number(end[4]) / 1000;
      if (body.slice(1).some((l) => /^[-–—]/.test(l))) cue.twoSpeakers = true;
      out.push(cue);
    }
  }
  return out;
}

export interface SubtitleStream {
  Index: number;
  Type?: string;
  Language?: string | null;
  Title?: string | null;
  IsForced?: boolean;
  IsHearingImpaired?: boolean;
  IsTextSubtitleStream?: boolean;
}

const LANG_CODES: Record<Locale, readonly string[]> = {
  fr: ["fr", "fra", "fre"],
  en: ["en", "eng"],
  es: ["es", "spa"],
  de: ["de", "deu", "ger"],
};

const isForced = (s: SubtitleStream) => !!s.IsForced || /forc/i.test(s.Title ?? "");
const isSdh = (s: SubtitleStream) => !!s.IsHearingImpaired || /sdh|malentend|\bcc\b/i.test(s.Title ?? "");
const inLang = (s: SubtitleStream, locale: Locale) => LANG_CODES[locale].includes((s.Language ?? "").toLowerCase());

/**
 * La piste dont on lit les dialogues : texte, jamais forcée (quelques répliques étrangères, rien de
 * l'intrigue) — l'ordinaire de la langue du compte, sinon celle pour malentendants, sinon l'anglais
 * (le modèle écrit dans la langue du compte quelle que soit celle des dialogues). Aucune : `null`,
 * et le « Précédemment » se fait sur les seuls résumés.
 */
export function pickSubtitleStream(streams: readonly SubtitleStream[], locale: Locale): SubtitleStream | null {
  const usable = streams.filter((s) => s.Type === "Subtitle" && s.IsTextSubtitleStream && !isForced(s));
  for (const lang of locale === "en" ? (["en"] as const) : ([locale, "en"] as const)) {
    const own = usable.filter((s) => inLang(s, lang));
    const pick = own.find((s) => !isSdh(s)) ?? own[0];
    if (pick) return pick;
  }
  return null;
}

export interface DoneEpisode {
  code: string;
  title: string;
  overview: string;
}

export interface RecapInput {
  series: string;
  current: { code: string; title: string };
  positionS: number;
  /** Les épisodes terminés avant celui-ci, dans l'ordre, au moins le dernier. */
  done: readonly DoneEpisode[];
  /** Les répliques de l'épisode en cours, toutes : la fenêtre est choisie ici. */
  cues: readonly Cue[];
  /** Le texte que ce compte avait, plus tôt dans l'histoire — le modèle peut le garder. */
  previous?: string | null;
}

/** Ce qui part au modèle, et le texte des sources contre lequel sa réponse est vérifiée. */
export function recapSources(input: RecapInput): { message: string; sources: string; usedDialogue: boolean } {
  const started = input.positionS >= RECAP_STARTED_S;
  const cut = recapCutS(input.positionS);
  const lines = started ? input.cues.filter((c) => c.startS <= cut && c.startS >= cut - RECAP_WINDOW_S).map((c) => c.text) : [];
  // Avec des dialogues, le dernier épisode fini suffit — le banc remontait sinon un épisode trop loin.
  const done = input.done.filter((e) => e.overview.trim()).slice(lines.length ? -1 : -2);
  const parts = done.map((e) => `### ${e.code} « ${e.title} » — résumé officiel\n${e.overview.trim()}`);
  const minutes = Math.floor(cut / 60);
  if (lines.length) {
    parts.push(`### ${input.current.code} « ${input.current.title} » — épisode EN COURS, dialogues des 10 minutes avant l'arrêt à ${minutes} min\n${lines.join("\n")}`);
  }
  const sources = parts.join("\n\n");
  const where = started ? `à ${minutes} min` : "depuis le début";
  const previous = input.previous?.trim() ? `\n\n### « Précédemment » actuel, écrit un peu plus tôt dans l'histoire\n${input.previous.trim()}` : "";
  // Le texte précédent compte parmi les sources : il a été vérifié contre les siennes, et le garder
  // ou en reprendre un nom ne doit pas faire rejeter la réponse.
  return { message: `Série : ${input.series}\nReprise de ${input.current.code} ${where}.\n\n${sources}${previous}`, sources: `${input.series}\n${sources}${previous}`, usedDialogue: lines.length > 0 };
}

const LANGUAGE_NAME: Record<Locale, string> = { fr: "français", en: "anglais", es: "espagnol", de: "allemand" };

/** Le prompt retenu au banc du 08/11/2026 (« v5 »), plus la langue du compte et les faux résumés. */
export function recapSystem(locale: Locale): string {
  return `Tu écris le « Précédemment » d'une série : deux ou trois phrases lues juste avant de reprendre.

But : rappeler les DERNIERS faits, là où en est l'intrigue quand le spectateur s'est arrêté. Pas un résumé de la saison.

Structure imposée, dans l'ordre de l'histoire :
- S'il y a des dialogues de l'épisode en cours : une phrase sur le dernier épisode terminé, tirée de son résumé officiel, puis une ou deux phrases sur ce qui se passe juste avant l'arrêt.
- Sinon : une phrase sur l'avant-dernier épisode terminé, puis une sur le dernier.
Au total 3 phrases au plus et 55 mots au plus, au présent, écrites en ${LANGUAGE_NAME[locale]}.

Sources et confiance :
- Les résumés officiels sont la trame fiable. Un résumé qui ne raconte pas l'intrigue (publicité, slogan, texte promotionnel) est à ignorer. S'il ne reste rien d'utilisable, ne rends aucune phrase.
- Les dialogues peuvent être dans une autre langue : écris quand même en ${LANGUAGE_NAME[locale]}.
- Dans les dialogues, un tiret en début de segment marque un changement de personne. Dans les sous-titres pour malentendants, un NOM suivi de « : » ou entre crochets désigne qui parle, et les crochets décrivent aussi des sons : sers-t'en pour savoir qui parle et ce qui se passe.
- Sans nom indiqué, on ne sait PAS qui parle : n'attribue une réplique que si le nom de la personne qui parle est indiqué ou dit dans la même réplique. N'en tire que des faits nets (une décision, une révélation, un lieu, un affrontement). Un souvenir ou un fait ancien évoqué n'est pas un fait présent. Dans le doute, rien.
- N'utilise QUE ces sources : tu ne connais pas cette série. Aucun nom ni événement absent des sources, même si tu crois le connaître.
- Rien après l'arrêt.

Si un « Précédemment » actuel est fourni : réponds « inchange » à vrai (et aucune phrase) quand les nouvelles sources n'apportent rien d'important à ce qu'il dit déjà ; sinon « inchange » à faux et un nouveau texte complet.

Style : phrases simples, noms exactement comme dans les sources, ni « spectateur », ni « vous », ni code d'épisode, ni « dans cet épisode », ni jugement, ni teaser, pas de vulgarité reprise des dialogues. Pour chaque phrase, les codes d'épisodes (ex. S02E03) d'où elle vient. Dans « noms », chaque nom propre (personne, lieu, groupe) que tes phrases emploient, écrit comme dans tes phrases.`;
}

/** Le schéma imposé à la réponse (`output_config.format`). */
export const RECAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["inchange", "phrases", "noms"],
  properties: {
    inchange: { type: "boolean" },
    noms: { type: "array", items: { type: "string" } },
    phrases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["texte", "episodes"],
        properties: { texte: { type: "string" }, episodes: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

/**
 * Les abréviations de titre devant un nom, en fr/en/es/de (chasse aux défauts du 11/11/2026) : leur point
 * n'est pas une fin de phrase. Le filet le prenait pour tel — « M. Kurtz », « Dr. Wilson », « Sra. García » —, et
 * le nom qui suit passait pour un début de phrase, que la règle des majuscules ne regarde jamais. Seulement avec
 * une majuscule (« M. », « Mme », « Dr. ») : « follow me. » ou « the end. » restent des fins de phrase.
 */
const TITLE_ABBREVIATIONS = new Set([
  "m", "mm", "mme", "mmes", "mlle", "mlles", "me", "mgr", "dr", "pr", "prof", "st", "ste",
  "mr", "mrs", "ms", "messrs", "drs", "sr", "sra", "srta", "sres", "dra", "dña", "hr", "hrn", "fr", "frl",
]);

/** « M. », « Dr. », « Sra. » — un mot (guillemet ouvrant permis) qui n'est qu'une abréviation de titre suivie d'un point. */
export function isTitleAbbreviation(word: string): boolean {
  const m = /^[«"“(]*(\p{Lu}\p{L}{0,5})\.$/u.exec(word);
  return !!m && TITLE_ABBREVIATIONS.has(m[1].toLowerCase());
}

/**
 * La règle des majuscules vaut-elle dans cette langue ? Pas en allemand (chasse aux défauts du 11/11/2026) : tous
 * les noms communs y prennent une majuscule (« Der Mann verlässt das Haus »), chacun passait pour un nom propre
 * absent des sources, et presque toute réponse allemande était rejetée — chaque rejet payé. En allemand, seul le
 * filet des noms déclarés par le modèle (`NOMS:`, `noms`) reste ; une réponse qui n'en déclare pas est rejetée.
 */
export function capitalsRuleApplies(locale: Locale | null | undefined): boolean {
  return locale !== "de";
}

/**
 * Les noms que les sources ne contiennent pas — venus de la mémoire du modèle. Deux filets : les mots
 * à majuscule hors début de phrase, et les noms que le modèle déclare lui-même (`noms`) — un nom en
 * tête de phrase (« Sansa refuse… », la forme la plus courante) échappe au premier, et ne peut pas
 * être distingué d'un « Pendant » sans liste de mots par langue. Comparé sans casse, mot à mot, à
 * l'intérieur des sources (« Greyjoy » dans « Yara Greyjoy »). `locale` : la langue de la réponse — en
 * allemand, le premier filet n'est pas tendu (`capitalsRuleApplies`).
 */
export function unknownNames(text: string, sources: string, declared: readonly string[] = [], locale?: Locale | null): string[] {
  const low = sources.toLowerCase();
  const capitals = capitalsRuleApplies(locale);
  const inner: string[] = capitals ? (text.match(/(?<![.!?]\s|^)\b\p{Lu}[\p{L}'’-]{2,}/gu) ?? []) : [];
  // Le nom qui suit une abréviation de titre (« M. Kurtz ») : la règle ci-dessus le croit en tête de phrase.
  if (capitals) {
    for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}\p{L}{0,5})\.\s(?=(\p{Lu}[\p{L}'’-]{2,}))/gu)) {
      if (TITLE_ABBREVIATIONS.has(m[1].toLowerCase())) inner.push(m[2]);
    }
  }
  const named = declared.flatMap((n) => n.match(/\p{Lu}[\p{L}'’-]{2,}/gu) ?? []);
  // Le titre lui-même (« Mme », « Mrs », « Prof ») n'est pas un nom : seul celui qui le suit l'est.
  return [...new Set([...inner.filter((w) => !TITLE_ABBREVIATIONS.has(w.toLowerCase())), ...named].filter((w) => !containsWord(low, w.toLowerCase().replace(/['’]s$/, ""))))];
}

/**
 * Le mot entier, pas une suite de lettres (chasse aux défauts du 11/11/2026) : « Anne » passait parce que les
 * sous-titres disaient « année », « Ned » dans « turned », « Paul » dans « épaule ». Une lettre ou un chiffre de
 * part et d'autre, et ce n'est pas le nom ; une apostrophe, un tiret, une espace ou la ponctuation le bordent
 * (« d'Anne », « Yara Greyjoy », « Jean-Luc »).
 */
function containsWord(haystack: string, word: string): boolean {
  if (!word) return true;
  for (let at = haystack.indexOf(word); at >= 0; at = haystack.indexOf(word, at + 1)) {
    const before = at > 0 ? haystack[at - 1] : "";
    // Un pluriel des sources (« les Stark » / « the Starks ») vaut le nom.
    const end = haystack[at + word.length] === "s" ? at + word.length + 1 : at + word.length;
    const after = haystack[end] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

export type RecapVerdict = { status: "ok"; text: string; kept?: true } | { status: "rejeté"; names: string[] } | { status: "vide" };

/**
 * Le jugement d'une réponse : nettoyée, coupée, et rejetée au moindre nom inconnu. « Inchangé » rend
 * le texte précédent tel quel — le modèle juge que les dix minutes de plus n'ont rien changé.
 */
export function judgeRecap(raw: unknown, sources: string, previous?: string | null, locale?: Locale | null): RecapVerdict {
  if ((raw as { inchange?: unknown } | null)?.inchange === true && previous?.trim()) return { status: "ok", text: previous.trim(), kept: true };
  const list = (raw as { phrases?: unknown } | null)?.phrases;
  const phrases = (Array.isArray(list) ? list : [])
    .map((p) => (typeof (p as { texte?: unknown })?.texte === "string" ? (p as { texte: string }).texte : ""))
    // « Dans S02E04, … » / « Dans l'épisode 6, … » : le prompt l'interdit, le modèle l'écrit quand même.
    .map((t) => t.trim().replace(/^(dans|in|en|im)\s+(S\d+E\d+|l['’]épisode\s+\d+|episode\s+\d+|el episodio\s+\d+|folge\s+\d+)\s*,\s*/i, ""))
    .map((t) => t.replace(/\s*\[?S\d{1,2}E\d{1,3}(?:\s*,\s*S\d{1,2}E\d{1,3})*\]?\s*$/i, "").trim())
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  const kept: string[] = [];
  let words = 0;
  for (const p of phrases.slice(0, RECAP_MAX_PHRASES)) {
    const n = p.split(/\s+/).length;
    if (kept.length && words + n > RECAP_MAX_WORDS) break;
    kept.push(p);
    words += n;
  }
  if (!kept.length) return { status: "vide" };
  const text = kept.join(" ");
  const declaredRaw = (raw as { noms?: unknown } | null)?.noms;
  // En allemand, les noms déclarés sont le seul filet (`capitalsRuleApplies`) : sans eux, rien n'est vérifié — rejeté.
  if (!Array.isArray(declaredRaw) && !capitalsRuleApplies(locale)) return { status: "rejeté", names: ["noms"] };
  const declared = Array.isArray(declaredRaw) ? declaredRaw.filter((n): n is string => typeof n === "string") : [];
  const names = unknownNames(text, sources, declared, locale);
  return names.length ? { status: "rejeté", names } : { status: "ok", text };
}
