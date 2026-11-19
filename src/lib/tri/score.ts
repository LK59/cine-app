// Les scores du tri (DECISIONS.md §198) — des fonctions pures, testées, lisibles part par part.
//
// Deux échelles, toutes deux sur 100 :
// - un TITRE à examiner : plus le score est haut, plus il mérite un regard (jamais ouvert, vieux,
//   loin des goûts de qui l'a demandé, catégorie signalée, mal noté, demandé par un compte qui
//   regarde peu, lourd) ;
// - un COMPTE : plus le score est haut, mieux il demande (ce qu'il demande, il le regarde ; ses
//   demandes sont bien notées ; peu de place perdue ; pas de rafales ; peu de partage ; un volume
//   raisonnable).
// Chaque part est rendue avec son nombre de points : un score se conteste, il ne s'impose pas.
import type { TriFlag, TriKind } from "./types";

const DAY_MS = 86_400_000;
const GB = 1e9;

/** Les catégories signalées, lues dans les genres de Radarr et Sonarr (en anglais, quelle que soit la langue). */
export function flagsOf(kind: TriKind, genres: readonly string[], rating: number | null): TriFlag[] {
  const has = (re: RegExp) => genres.some((g) => re.test(g));
  const flags: TriFlag[] = [];
  if (has(/^documentar(y|io)|^documentaire/i)) flags.push("documentary");
  if (has(/^animation$/i)) flags.push(kind === "movie" ? "animationMovie" : "animationSeries");
  if (has(/^tv movie$|^téléfilm$/i)) flags.push("tvMovie");
  if (rating !== null && rating > 0 && rating < 6) flags.push("lowRating");
  return flags;
}

/**
 * L'éloignement d'un titre et des goûts d'un profil, de 0 (son genre de prédilection) à 1 (rien en
 * commun). `null` quand le profil a trop peu regardé pour qu'on en dise quelque chose.
 */
export function genreDistance(titleGenres: readonly string[], watched: ReadonlyMap<string, number>, minOpened = 5): number | null {
  const total = [...watched.values()].reduce((a, b) => a + b, 0);
  if (total < minOpened || titleGenres.length === 0) return null;
  const top = Math.max(...watched.values());
  // La part du genre le mieux représenté du titre, rapportée à celle du genre favori du profil.
  const best = Math.max(...titleGenres.map((g) => watched.get(g) ?? 0));
  return Math.round((1 - best / top) * 100) / 100;
}

export interface TitleScoreInput {
  neverOpened: boolean;
  /** Ouvert, mais plus depuis au moins six mois. */
  stale: boolean;
  /** Le plus ancien de la demande ou de l'ajout. */
  since: number | null;
  flags: readonly TriFlag[];
  rating: number | null;
  distance: number | null;
  /** Score du compte qui l'a demandé (le plus bas s'ils sont plusieurs) ; `null` sans demande. */
  requesterScore: number | null;
  sizeBytes: number;
  now: number;
}

export function titleScore(input: TitleScoreInput): { score: number; reasons: { key: string; points: number }[] } {
  const reasons: { key: string; points: number }[] = [];
  const add = (key: string, points: number) => {
    const p = Math.round(points);
    if (p > 0) reasons.push({ key, points: p });
  };
  if (input.neverOpened) add("neverOpened", 35);
  else if (input.stale) add("stale", 10);
  if (input.since !== null) add("age", Math.min(1, Math.max(0, (input.now - input.since) / (365 * DAY_MS))) * 15);
  const categories = input.flags.filter((f) => f !== "lowRating").length;
  if (categories > 0) add("category", Math.min(15, categories * 10));
  if (input.rating !== null && input.rating > 0) add("rating", input.rating < 5 ? 15 : input.rating < 6 ? 8 : input.rating < 6.5 ? 3 : 0);
  if (input.distance !== null) add("distance", input.distance * 10);
  if (input.requesterScore !== null) add("requester", ((100 - input.requesterScore) / 100) * 10);
  add("size", Math.min(1, input.sizeBytes / (50 * GB)) * 5);
  return { score: Math.min(100, reasons.reduce((a, r) => a + r.points, 0)), reasons };
}

export interface AccountScoreInput {
  requests: number;
  available: number;
  opened: number;
  avgRating: number | null;
  neverOpenedBytes: number;
  burstShare: number;
  profiles: number;
  last90Days: number;
}

/** Le score d'un compte, sur 100, et ses six parts (points obtenus sur points possibles). */
export function accountScore(a: AccountScoreInput): { score: number; parts: { key: string; points: number; max: number }[] } {
  const part = (key: string, max: number, ratio: number) => ({ key, max, points: Math.round(max * Math.min(1, Math.max(0, ratio))) });
  const parts = [
    // Ce qu'il demande, il le regarde — l'essentiel. Sans titre disponible, rien à reprocher.
    part("openRate", 40, a.available > 0 ? a.opened / a.available : 1),
    // Des demandes bien notées : 5/10 ne rapporte rien, 8/10 et plus tout.
    part("rating", 20, a.avgRating === null ? 0.5 : (a.avgRating - 5) / 3),
    // La place prise par ce qu'il n'a jamais ouvert : 500 Go et plus, plus rien.
    part("space", 15, 1 - a.neverOpenedBytes / (500 * GB)),
    // Pas de rafales (cinq demandes ou plus le même jour).
    part("bursts", 10, 1 - a.burstShare),
    // Peu de partage : un ou deux types d'appareils, c'est une personne ; cinq, c'est une famille.
    part("sharing", 10, 1 - (a.profiles - 2) / 3),
    // Un volume raisonnable : 60 demandes en trois mois et plus, plus rien.
    part("volume", 5, 1 - a.last90Days / 60),
  ];
  return { score: parts.reduce((s, p) => s + p.points, 0), parts };
}

/** Part des demandes faites un jour où le compte en a fait au moins `threshold`. */
export function burstShare(dates: readonly string[], threshold = 5): number {
  if (dates.length === 0) return 0;
  const perDay = new Map<string, number>();
  for (const d of dates) perDay.set(d.slice(0, 10), (perDay.get(d.slice(0, 10)) ?? 0) + 1);
  let inBursts = 0;
  for (const n of perDay.values()) if (n >= threshold) inBursts += n;
  return Math.round((inBursts / dates.length) * 100) / 100;
}

/** Le type d'appareil d'une ligne de journal : son champ `device` (« iPhone · Safari ») ou son agent. */
export function deviceOf(device: string | undefined, agent: string | undefined): string | null {
  const d = device ?? "";
  if (d) {
    const first = d.split("·")[0].trim();
    return first || null;
  }
  const a = agent ?? "";
  if (!a) return null;
  if (/iPhone/.test(a)) return "iPhone";
  if (/iPad/.test(a)) return "iPad";
  // Safari sur iPad se présente comme un Mac : sans `device`, on ne peut pas trancher.
  if (/Macintosh/.test(a)) return /Chrome|Firefox|Edg/.test(a) ? "Mac" : "iPad ou Mac";
  if (/Android/.test(a)) return /AFT|Silk/.test(a) ? "Fire TV" : "Android";
  if (/Windows/.test(a)) return "Windows";
  if (/Linux/.test(a)) return "Linux";
  return null;
}
