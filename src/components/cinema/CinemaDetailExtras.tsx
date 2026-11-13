"use client";

import { ArrowDown } from "lucide-react";
import { Children, useState, type ReactNode } from "react";
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
 * Ce qui n'arrive que par le réseau — l'accroche, la distribution, la bande-annonce — a sa place
 * dès l'ouverture de la fiche, et y apparaît en fondu.
 *
 * 25/09/2026, Louis : la fiche s'ouvrait, puis chaque ligne arrivait à son tour en poussant les
 * autres. Tout ce qui est gardé sur l'appareil est maintenant là d'emblée (`sheetFacts.ts`) ; ce
 * qui reste à venir tient sa place vide (`ReservedLine`) tant que la réponse n'est pas là, puis
 * s'y dépose en 150 ms — seulement si elle est arrivée après l'ouverture : une fiche dont tout
 * était déjà là ne clignote pas. Une réponse qui n'a rien pour cette place la rend (un film sans
 * accroche) : c'est le seul mouvement qui reste, et le plus rare.
 *
 * `settled` : la réponse est là, ou a échoué — une erreur libère la place comme une réponse vide.
 */
export function useLateArrival(settled: boolean): { pending: boolean; fade: string } {
  // Lu une seule fois, au montage : c'est l'état à l'ouverture qui décide du fondu.
  const [lateAtMount] = useState(() => !settled);
  return { pending: !settled, fade: lateAtMount ? LATE_FADE : "" };
}

/** Le fondu d'arrivée : celui de l'application, raccourci à 150 ms. */
export const LATE_FADE = "animate-fade-in [animation-duration:150ms]";

/** Une place tenue, vide, de la hauteur de ce qui va l'occuper. */
export function ReservedLine({ className }: { className: string }) {
  return <div aria-hidden="true" data-sheet-reserved="" className={className} />;
}

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
 * totale, c'est ce qu'engage un épisode. Dans la typographie de la langue de l'écran (« 50 min/ép. »,
 * « 2 h 47 » en français — `formatMinutes`, 13/11/2026).
 */
export function useRuntimeLabel() {
  const t = useT();
  const { locale } = useLocale();
  return (minutes: number | null | undefined, perEpisode: boolean): string | null => {
    const time = formatMinutes(minutes, locale);
    if (!time) return null;
    return perEpisode ? t("cinema.perEpisode", { time }) : time;
  };
}

/**
 * Les faits d'une ligne d'infos, séparés par « · » — la ligne sous le logo de la fiche du téléphone.
 *
 * Elle posait l'année, la note, « 4 saisons » et « 50min/ép. » côte à côte, sans rien entre eux, alors
 * que les genres au bout avaient leurs « · » : on lisait « 2015 [IMDb 8.5] 4 saisons 50min/ép. » d'un
 * seul tenant (relecture des fiches par le propriétaire, 13/11/2026). Un point entre chaque élément
 * présent, jamais en tête, en queue ni doublé : l'appelant ne passe que ce qui s'affiche (`false`,
 * `null` sont écartés), et une pièce qui peut se rendre vide doit être gardée par sa propre condition.
 * Le point est décoratif (`aria-hidden`).
 */
export function DottedFacts({ children, className = "" }: { children: ReactNode; className?: string }) {
  const items = Children.toArray(children);
  return (
    <div className={className}>
      {items.flatMap((item, i) =>
        i === 0
          ? [item]
          : [
              <span key={`dot-${i}`} aria-hidden="true" data-fact-dot="" className="text-subtle">
                ·
              </span>,
              item,
            ]
      )}
    </div>
  );
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
