"use client";

import { ArrowDown } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { useT, useLocale } from "@/components/TranslationProvider";
import type { MdbRatings } from "@/app/api/mdblist/[imdbId]/route";
import { formatMinutes } from "@/lib/format";
import { useTweenedNumber } from "@/lib/useTweenedNumber";

/**
 * Trois détails légers, repris de la gestion le 21/09/2026 — et écrits une fois pour toutes les
 * fiches (film, série, téléphone, découverte), parce que ce sont exactement les petites décisions
 * qui dérivent quand chaque écran les écrit à sa façon. Louis voulait des détails « très légers,
 * nécessaires et discrets » : une ligne, un mot, un pourcentage — rien qui fasse une section.
 */

/**
 * L'accroche du film (« In space no one can hear you scream »), sous les métadonnées.
 *
 * Elle était déjà dans la charge de chaque fiche et n'était jamais montrée. En italique et
 * atténuée : elle donne le ton sans rien disputer au synopsis juste en dessous.
 */
export function CinemaTagline({ text, className = "" }: { text: string | null | undefined; className?: string }) {
  if (!text?.trim()) return null;
  return <p className={`text-sm italic leading-snug text-subtle ${className}`}>{text.trim()}</p>;
}

/**
 * La durée telle qu'on la dit : celle du film, ou celle d'un épisode pour une série
 * (« 45min/ép. ») — la question qu'on se pose avant de commencer une série n'est pas sa durée
 * totale, c'est ce qu'engage un épisode.
 */
export function useRuntimeLabel() {
  const t = useT();
  return (minutes: number | null | undefined, perEpisode: boolean): string | null => {
    const time = formatMinutes(minutes);
    if (!time) return null;
    return perEpisode ? t("cinema.perEpisode", { time }) : time;
  };
}

/**
 * « Arrive · 63 % » — un titre ou un épisode demandé, en train de se télécharger.
 *
 * Un pourcentage entier, arrondi vers le bas : « 100 % » n'est dit qu'une fois vraiment fini, ce
 * qui n'arrive jamais ici puisqu'un fichier importé quitte la file.
 */
export function downloadPercent(progress: number): number {
  return Math.min(99, Math.max(0, Math.floor(progress * 100)));
}

export function CinemaDownloading({ progress, className = "" }: { progress: number; className?: string }) {
  const t = useT();
  // Défile d'une relecture à la suivante au lieu d'y sauter — voir `useTweenedNumber`.
  const pct = Math.round(useTweenedNumber(downloadPercent(progress)));
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums text-accent-400 ${className}`}>
      <ArrowDown size={12} className="shrink-0" />
      {t("cinema.downloading", { pct })}
    </span>
  );
}

/** Tant que quelque chose arrive, la fiche se relit toute seule ; sinon, jamais. */
export const DOWNLOAD_REFRESH_MS = 15_000;

/**
 * Les notes critiques, en une ligne de texte — dans la fenêtre « Voir plus », sur grand écran.
 *
 * Le choix de Louis le 21/09/2026 : pas sur la fiche, où tout afficher ferait fouillis, et pas du
 * tout sur téléphone. Ici, on ne la voit que si on la cherche. Du texte simple, sans logos de
 * couleur : « IMDb 7,8 · Rotten Tomatoes 92 % (public 88 %) · Metacritic 81 · Letterboxd 4,1 ».
 * Une source absente est tue, et rien du tout ne s'affiche quand aucune ne répond.
 */
export function CinemaRatingsLine({ imdbId }: { imdbId: string | null | undefined }) {
  const t = useT();
  const { locale } = useLocale();
  const { data } = useSWR<{ ratings: MdbRatings | null }>(imdbId ? `/api/mdblist/${imdbId}` : null, fetcher, {
    revalidateOnFocus: false,
  });
  const parts = ratingParts(data?.ratings ?? null, locale, (pct) => t("cinema.ratingsAudience", { pct }));
  if (parts.length === 0) return null;
  return <p className="mt-4 border-t border-white/10 pt-3 text-sm text-muted">{parts.join(" · ")}</p>;
}

/** Les morceaux de la ligne, dans cet ordre — exportée pour être testée sans réseau. */
export function ratingParts(r: MdbRatings | null, locale: string, audience: (pct: number) => string): string[] {
  if (!r) return [];
  const one = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const parts: string[] = [];
  if (r.imdb) parts.push(`IMDb ${one.format(r.imdb / 10)}`);
  if (r.tomatoes) parts.push(`Rotten Tomatoes ${r.tomatoes} %${r.tomatoesAudience ? ` (${audience(r.tomatoesAudience)})` : ""}`);
  if (r.metacritic) parts.push(`Metacritic ${r.metacritic}`);
  if (r.letterboxd) parts.push(`Letterboxd ${one.format(r.letterboxd / 20)}`);
  return parts;
}

/**
 * L'année — ou, pour un titre pas encore sorti, sa date : « Sortie le 12 mars 2026 ».
 *
 * À la place de l'année, pas à côté : la même ligne, le même poids, une information plus précise
 * là où elle compte. « Pas encore sorti » ne disait pas la moitié de ce qu'on voulait savoir.
 * Une date qui n'a que l'année (TMDB en donne parfois) reste une année.
 */
export function useReleaseLabel() {
  const t = useT();
  const { locale } = useLocale();
  return (releaseDate: string | null | undefined, year: number | null | undefined, now = Date.now()): string | null => {
    if (releaseDate && /^\d{4}-\d{2}-\d{2}/.test(releaseDate)) {
      const at = Date.parse(`${releaseDate.slice(0, 10)}T00:00:00`);
      if (Number.isFinite(at) && at > now) {
        const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(at);
        return t("cinema.releasesOn", { date });
      }
    }
    return year ? String(year) : null;
  };
}
