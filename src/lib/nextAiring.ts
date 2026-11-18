import type { MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";

/**
 * « Prochain épisode jeudi » sur la fiche d'une série dont on a vu tout ce qui est sorti (18/11/2026, demandé
 * par le propriétaire) : la fiche ne proposait plus que « Revoir », sans dire que la suite arrive — *Les Anneaux
 * de pouvoir*, un épisode par semaine.
 *
 * La date vient de Sonarr, par la liste de ce qui manque à la série (`/api/player/series/[id]/missing`, déjà lue
 * par l'écran des épisodes) : le premier épisode **pas encore diffusé**, à date annoncée. Un épisode diffusé mais
 * pas encore arrivé n'est pas « à venir » (l'écran des épisodes dit déjà qu'il arrive), et une saison annoncée
 * sans date ne dit rien.
 */
export interface NextAiring {
  seasonNumber: number;
  episodeNumber: number;
  /** ms depuis l'époque. */
  at: number;
}

export function nextAiring(seasons: readonly MissingSeason[], now: number): NextAiring | null {
  let best: NextAiring | null = null;
  for (const season of seasons) {
    for (const ep of season.episodes) {
      if (ep.released || !ep.airDate) continue;
      const at = Date.parse(ep.airDate);
      if (!Number.isFinite(at) || at < now) continue;
      if (!best || at < best.at) best = { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber, at };
    }
  }
  return best;
}

const DAY_MS = 86_400_000;

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Quand, en mots : « aujourd'hui », « demain », le jour de la semaine dans les six jours (« jeudi »), sinon la date
 * (« le 4 décembre »). Pas d'heure : celle de Sonarr est l'heure de diffusion américaine, pas celle où l'épisode
 * sera là.
 */
export type NextAiringWhen =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "weekday"; text: string }
  | { kind: "date"; text: string };

export function nextAiringWhen(at: number, now: number, locale: string | undefined): NextAiringWhen {
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY_MS);
  if (days <= 0) return { kind: "today" };
  if (days === 1) return { kind: "tomorrow" };
  if (days < 7) return { kind: "weekday", text: new Date(at).toLocaleDateString(locale, { weekday: "long" }) };
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return {
    kind: "date",
    text: new Date(at).toLocaleDateString(locale, { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) }),
  };
}
