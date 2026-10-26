"use client";

import { useEffect, type RefObject } from "react";
import useSWR from "swr";
import { Play } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import type { CinemaEpisode, CinemaEpisodesPayload } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

/**
 * L'écran de l'épisode suivant, au générique (26/10/2026, souhait du propriétaire : « la vidéo réduite,
 * l'épisode suivant mis en avant, et de quoi revenir au générique »).
 *
 * La vidéo n'est pas redessinée : la surface de l'image (`data-player-picture` dans le lecteur natif,
 * l'élément lui-même dans le lecteur serveur) reçoit une classe, et `globals.css` la réduit par un
 * `transform` — le compositeur s'en charge, l'image continue sans un à-coup, et la retirer la rend
 * entière. Rien d'autre du lecteur ne change : le décompte, « Vous êtes toujours là ? », la minuterie
 * de veille et `requestAdvance` restent ceux de `PlayerControls`.
 *
 * Ce qui est montré de l'épisode vient de la liste du menu « Épisodes » (même clé SWR, déjà chargée
 * après la première image par `usePrewarmEpisodes`, miniatures décodées) ; sans elle, le titre seul.
 * Jamais pendant une diffusion : l'image est sur le téléviseur, la petite carte reste.
 */
export function PlayerNextUp({
  videoRef,
  seriesId,
  nextEpisode,
  countdown,
  total,
  running,
  onPlay,
  onWatchCredits,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  seriesId: string | null;
  nextEpisode: { itemId: string; title: string };
  countdown: number;
  total: number;
  running: boolean;
  onPlay: () => void;
  onWatchCredits: () => void;
}) {
  const t = useT();
  useSqueezedPicture(videoRef);
  const episode = useEpisodeFacts(seriesId, nextEpisode.itemId);
  const { series, name } = splitEpisodeTitle(nextEpisode.title);
  const code = episode ? `S${episode.seasonNumber}E${episode.episodeNumber}` : null;
  const heading = episode?.title ?? name;
  // L'anneau se vide d'une seconde à chaque pas, en une seconde : il suit le décompte sans le devancer.
  const progress = total > 0 ? Math.max(0, Math.min(1, countdown / total)) : 0;
  const RING = 2 * Math.PI * 9;

  return (
    <div data-player-surface-ignore data-player-next-up="" className="player-next-up pointer-events-none absolute inset-0 z-30">
      {/* Toucher la vidéo réduite : revenir au générique, comme le bouton. */}
      <button
        type="button"
        aria-label={t("player.nextUp.watchCredits")}
        onClick={(e) => {
          e.stopPropagation();
          onWatchCredits();
        }}
        className="player-next-up-picture pointer-events-auto absolute cursor-pointer rounded-xl"
      />
      <div onClick={(e) => e.stopPropagation()} className="player-next-up-panel pointer-events-auto absolute flex flex-col">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/60">{t("player.nextUp.label")}</p>
        {episode?.thumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- miniature déjà décodée par le menu « Épisodes » (`episodeThumbs.ts`) : la même adresse, sans passer par l'optimiseur.
          <img src={episode.thumbnailUrl} alt="" className="player-next-up-thumb mt-3 aspect-video w-full rounded-2xl object-cover shadow-2xl ring-1 ring-white/10" />
        )}
        <div className="mt-3 min-w-0">
          {series && <p className="truncate text-sm text-white/60">{series}</p>}
          <p className="font-display text-xl font-semibold leading-tight text-white">
            {code && <span className="mr-2 text-white/60">{code}</span>}
            {heading}
          </p>
          {episode?.overview && <p className="player-next-up-overview mt-2 text-sm leading-snug text-white/75">{episode.overview}</p>}
          {episode?.runtimeMinutes ? <p className="mt-1.5 text-xs text-white/50">{t("player.nextUp.runtime", { n: episode.runtimeMinutes })}</p> : null}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onPlay}
            data-player-next-up-play=""
            className="flex items-center gap-2.5 rounded-full bg-white py-2.5 pl-4 pr-2.5 text-sm font-semibold text-black transition-transform active:scale-95"
          >
            <Play size={16} fill="currentColor" aria-hidden />
            {t("player.nextUp.play")}
            <span className="relative flex h-6 w-6 items-center justify-center" aria-label={t("player.nextEpisodeIn", { n: countdown })}>
              <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90" aria-hidden>
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={RING}
                  strokeDashoffset={RING * (1 - progress)}
                  style={{ transition: running ? "stroke-dashoffset 1s linear" : "none" }}
                />
              </svg>
              <span className="text-[10px] font-bold tabular-nums">{countdown}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={onWatchCredits}
            data-player-next-up-credits=""
            className="player-pill px-4 py-2.5 text-sm font-medium text-white"
          >
            {t("player.nextUp.watchCredits")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * La surface de l'image réduite tant que l'écran est là. Une classe sur un nœud que React ne rend pas
 * d'ici — posée et retirée dans un effet, jamais pendant le rendu. Retirée au démontage : un épisode
 * suivant, une fermeture, un retour au générique rendent l'image entière, en glissant.
 */
function useSqueezedPicture(videoRef: RefObject<HTMLVideoElement | null>) {
  useEffect(() => {
    const video = videoRef.current;
    const surface = (video?.closest("[data-player-picture]") as HTMLElement | null) ?? video;
    if (!surface) return;
    surface.classList.add("player-squeezable");
    // Le cadre d'abord, la réduction au rendu suivant : sans cela, la transition n'a pas d'état de départ.
    const frame = requestAnimationFrame(() => surface.classList.add("player-squeezed"));
    return () => {
      cancelAnimationFrame(frame);
      surface.classList.remove("player-squeezed");
      // La transition de retour a besoin de sa classe le temps de jouer.
      const done = () => {
        if (!surface.classList.contains("player-squeezed")) surface.classList.remove("player-squeezable");
      };
      surface.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 900);
    };
  }, [videoRef]);
}

function useEpisodeFacts(seriesId: string | null, itemId: string): CinemaEpisode | null {
  const { data } = useSWR<CinemaEpisodesPayload>(seriesId ? `/api/cinema/series/${seriesId}/episodes` : null, fetcher, {
    ...playerBootstrapOptions,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  if (!data) return null;
  for (const season of data.seasons) {
    const found = season.episodes.find((e) => e.jellyfinItemId === itemId);
    if (found) return found;
  }
  return null;
}

/** « Série — S02E10 · Titre » : la série, puis le nom de l'épisode (le titre entier si la forme diffère). */
export function splitEpisodeTitle(title: string): { series: string | null; name: string } {
  const dash = title.indexOf(" — ");
  if (dash < 0) return { series: null, name: title };
  const series = title.slice(0, dash);
  const rest = title.slice(dash + 3);
  const dot = rest.indexOf(" · ");
  return { series, name: dot >= 0 ? rest.slice(dot + 3) : rest };
}
