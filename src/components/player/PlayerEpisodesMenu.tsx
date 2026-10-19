"use client";

import { useLayoutEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Check } from "lucide-react";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { episodeResumeAt } from "@/lib/nextEpisode";
import { formatDurationShort, formatMinutes } from "@/lib/format";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import type { CinemaEpisodesPayload } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

/**
 * Le menu « Épisodes » du lecteur (19/10/2026, idée de l'administrateur d'une autre installation) :
 * la saison de l'épisode en cours, ouverte sur lui. Un bouton du casque qui fait passer à l'épisode
 * suivant par erreur, et l'épisode d'avant est la ligne juste au-dessus — à sa position.
 *
 * La liste est celle de la fiche série (`/api/cinema/series/{id}/episodes`, même clé, même cache) :
 * relue à l'ouverture du menu, pour la position d'un épisode quitté dans cette séance-ci. Demandée
 * pendant que le film a l'écran, d'où `playerBootstrapOptions`. Un épisode choisi part par
 * `onPick`, le même passage que « Épisode suivant » (`handlePlayEpisode` des deux lecteurs).
 */
export function PlayerEpisodesMenu({
  seriesId,
  currentItemId,
  onPick,
}: {
  seriesId: string;
  currentItemId: string;
  onPick: (episode: { itemId: string; title: string; resumeAt: number }) => void;
}) {
  const t = useT();
  const { data, error } = useSWR<CinemaEpisodesPayload>(`/api/cinema/series/${seriesId}/episodes`, fetcher, {
    ...playerBootstrapOptions,
    revalidateOnMount: true,
    revalidateOnFocus: false,
  });
  const seasons = data?.seasons ?? [];
  const currentSeason = seasons.find((s) => s.episodes.some((e) => e.jellyfinItemId === currentItemId))?.seasonNumber ?? null;
  // La saison choisie à la main, sinon celle de l'épisode en cours.
  const [picked, setPicked] = useState<number | null>(null);
  const shown = seasons.find((s) => s.seasonNumber === (picked ?? currentSeason)) ?? seasons[0];

  // Ouvert sur l'épisode en cours, au milieu de la liste plutôt qu'en haut : celui d'avant est visible.
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const centered = useRef(false);
  useLayoutEffect(() => {
    if (centered.current || !currentRef.current) return;
    centered.current = true;
    currentRef.current.scrollIntoView({ block: "center" });
  });

  if (!data) {
    return <p className="px-3 py-2 text-sm text-subtle">{error ? t("player.episodes.unavailable") : t("common.loading")}</p>;
  }

  return (
    <>
      {seasons.length > 1 && (
        <div data-episodes-seasons="" className="flex flex-wrap gap-1.5 border-b border-white/10 px-3 py-2">
          {seasons.map((s) => (
            <button
              key={s.seasonNumber}
              type="button"
              onClick={() => setPicked(s.seasonNumber)}
              aria-pressed={s.seasonNumber === shown?.seasonNumber}
              className={`rounded-full px-2.5 py-1 text-xs ring-1 ring-white/15 transition-colors ${
                s.seasonNumber === shown?.seasonNumber ? "bg-white font-semibold text-ink" : "text-white hover:bg-white/10"
              }`}
            >
              {s.seasonNumber === 0 ? t("cinema.specials") : t("cinema.season", { n: s.seasonNumber })}
            </button>
          ))}
        </div>
      )}
      {shown?.episodes.map((ep) => {
        const current = ep.jellyfinItemId === currentItemId;
        const started = !!ep.resumeTicks && !!ep.runtimeTicks && !ep.watched;
        return (
          <button
            key={ep.jellyfinItemId}
            ref={current ? currentRef : undefined}
            type="button"
            data-episode-row=""
            aria-current={current ? "true" : undefined}
            // L'épisode en cours n'a rien à relancer : la ligne le montre, et ne fait rien.
            onClick={() => {
              if (!current) onPick({ itemId: ep.jellyfinItemId, title: ep.title, resumeAt: episodeResumeAt(ep) });
            }}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white ${current ? "bg-white/10 font-semibold" : "hover:bg-white/10"}`}
          >
            <span className="relative block w-16 shrink-0 overflow-hidden rounded bg-black/40" style={{ aspectRatio: "16 / 9" }}>
              {ep.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- une vignette de 64 px, déjà servie en cache immuable
                <img src={ep.thumbnailUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              )}
              {ep.watched && (
                <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brand-strong">
                  <Check size={9} className="text-white" />
                </span>
              )}
              <CinemaEpisodeProgress resumeTicks={ep.resumeTicks} runtimeTicks={ep.runtimeTicks} watched={ep.watched} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 leading-snug">
                {ep.episodeNumber}. {ep.title}
              </span>
              <span className="block text-xs font-normal text-subtle">
                {current
                  ? t("player.episodes.current")
                  : started
                    ? t("cinema.timeRemaining", { time: formatDurationShort(ep.runtimeTicks! - ep.resumeTicks!) })
                    : formatMinutes(ep.runtimeMinutes)}
              </span>
            </span>
          </button>
        );
      })}
    </>
  );
}
