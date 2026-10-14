"use client";

import { useState } from "react";
import useSWR from "swr";
import { MessageSquareQuote } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { dialogueResumeAt, dialogueSearchUrl, formatClock, highlightSegments, useDialogueSearch, type DialogueResponse } from "@/lib/dialogueSearch";
import { trickplayTileAt, type TrickplayInfo } from "@/lib/trickplayTile";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { DialogueFilm, DialogueLine } from "@/lib/repliques/search";

/**
 * La section « Répliques » de la recherche du cinéma (DECISIONS.md §88), sous les titres.
 *
 * Groupée par film : son affiche et son titre, puis quelques répliques — la vignette de la scène
 * quand le film a des vignettes, l'horodatage, le texte avec les mots trouvés mis en évidence. Un
 * appui lance le film cinq secondes avant la réplique (`dialogueResumeAt`). « Voir plus » demande
 * toutes les répliques de ce film qui répondent.
 *
 * Seuls les films du catalogue que l'appareil tient sont montrés : la route a déjà retiré ce que
 * les tags bloqués cachent au compte (§54), et un film absent du catalogue ne s'ouvrirait pas.
 */
export function DialogueResults({
  data,
  stale,
  loading,
  failed,
  query,
  moviesByItem,
}: {
  data: DialogueResponse | undefined;
  /** La réponse précédente, gardée (estompée) pendant que la nouvelle arrive : pas de clignotement. */
  stale?: DialogueResponse;
  loading: boolean;
  failed: boolean;
  query: string;
  moviesByItem: ReadonlyMap<string, CinemaMovie>;
}) {
  const t = useT();
  const shown = data ?? stale;
  const films = (shown?.films ?? []).filter((f) => moviesByItem.has(f.itemId));
  const waiting = loading && films.length === 0;
  return (
    <section className="mt-10" aria-labelledby="dialogue-results-title" aria-busy={loading}>
      <h2 id="dialogue-results-title" className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <MessageSquareQuote size={16} className="text-subtle" />
        {t("player.search.dialogue.title")}
      </h2>
      {waiting && <p className="text-sm text-subtle">{t("player.search.dialogue.loading")}</p>}
      {!loading && failed && <p className="text-sm text-warning/90">{t("player.search.dialogue.failed")}</p>}
      {/* Des mots tous parmi les plus courants ne sont pas cherchés : « aucune réplique » serait faux. */}
      {!loading && !failed && data?.tooCommon && <p className="text-sm text-subtle">{t("player.search.dialogue.tooCommon")}</p>}
      {!loading && !failed && !data?.tooCommon && films.length === 0 && <p className="text-sm text-subtle">{t("player.search.dialogue.none")}</p>}
      {shown?.approximate && films.length > 0 && <p className="-mt-2 mb-4 text-xs text-subtle">{t("player.search.dialogue.approximate")}</p>}
      {films.length > 0 && (
        <ul className={`space-y-6 transition-opacity duration-200 ${loading ? "opacity-50" : ""}`}>
          {films.map((film) => (
            <DialogueFilmRow
              // La question change la liste de répliques d'un film : « voir plus » repart replié.
              key={`${film.itemId}|${query}`}
              film={film}
              movie={moviesByItem.get(film.itemId)!}
              terms={shown?.terms ?? []}
              prefixes={shown?.prefixes ?? []}
              query={query}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DialogueFilmRow({ film, movie, terms, prefixes, query }: { film: DialogueFilm; movie: CinemaMovie; terms: string[]; prefixes: string[]; query: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const more = useDialogueSearch(expanded ? dialogueSearchUrl(query, film.itemId) : null);
  const lines = expanded && more.data?.films?.[0] ? more.data.films[0].lines : film.lines;
  return (
    <li className="flex gap-3">
      <div className="w-14 shrink-0 sm:w-16">
        <div className="overflow-hidden rounded-lg bg-white/5">
          <PosterImage src={movie.posterUrl} alt={movie.title} subtle unoptimized sizes="64px" className="w-full" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-white">
          {movie.title}
          {movie.year ? <span className="ml-1.5 font-normal text-subtle">{movie.year}</span> : null}
        </h3>
        <ul className="mt-1.5 space-y-1">
          {lines.map((line) => (
            <DialogueLineButton key={`${line.lang}:${line.startMs}`} itemId={film.itemId} title={movie.title} line={line} terms={terms} prefixes={prefixes} />
          ))}
        </ul>
        {!expanded && film.more > 0 && (
          <button type="button" data-nav-item onClick={() => setExpanded(true)} className="mt-1 text-xs font-medium text-muted transition-colors hover:text-white">
            {t("player.search.dialogue.more", { n: film.more })}
          </button>
        )}
        {expanded && more.loading && <p className="mt-1 text-xs text-subtle">{t("player.search.dialogue.loading")}</p>}
      </div>
    </li>
  );
}

function DialogueLineButton({ itemId, title, line, terms, prefixes }: { itemId: string; title: string; line: DialogueLine; terms: string[]; prefixes: string[] }) {
  const t = useT();
  const playback = usePlayback();
  const clock = formatClock(line.startMs);
  return (
    <li>
      <button
        type="button"
        data-nav-item
        // Une scène, pas une reprise (§91) : la position atteinte n'écrase pas « Reprendre » tant que la
        // scène n'a pas été regardée plus longtemps (`sceneMode.ts`).
        onClick={() => playback.play({ itemId, title, resumeAt: dialogueResumeAt(line.startMs), scene: true })}
        // Le nom lu par un lecteur d'écran porte la réplique : sans elle, chaque ligne s'annonçait
        // « Lire Matrix à 0:00:42 », et rien ne distinguait les trois répliques d'un film.
        aria-label={`${t("player.search.dialogue.playAt", { title, time: clock })} — ${line.text.replace(/\n/g, " ")}`}
        className="group flex w-full items-start gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
      >
        <SceneThumb itemId={itemId} seconds={line.startMs / 1000} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs tabular-nums text-subtle">{clock}</span>
          <span className="mt-0.5 line-clamp-3 whitespace-pre-line text-sm text-muted group-hover:text-white">
            {highlightSegments(line.text, terms, prefixes).map((part, i) =>
              part.hit ? (
                <mark key={i} className="rounded-sm bg-white/20 px-0.5 text-white">
                  {part.text}
                </mark>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** La largeur d'une vignette de scène dans la liste. */
const THUMB_WIDTH = 112;

/**
 * La vignette de la scène, tirée des vignettes de défilement de Jellyfin (trickplay) — les mêmes que
 * la barre de lecture montre. Le film n'en a pas : rien, la ligne garde sa place sans image.
 */
function SceneThumb({ itemId, seconds }: { itemId: string; seconds: number }) {
  const { data, error } = useSWR<TrickplayInfo>(`/api/jellyfin/trickplay/info?itemId=${itemId}`, fetcher, { revalidateOnFocus: false, shouldRetryOnError: false });
  const tile = data && typeof data.width === "number" ? trickplayTileAt(data, itemId, seconds) : null;
  const height = Math.round((THUMB_WIDTH * 9) / 16);
  // En attente de la réponse, la place est gardée partout ; sans vignettes, le téléphone la rend au
  // texte. Avant, la place n'existait pas au téléphone pendant l'attente : la vignette arrivée
  // poussait le texte d'un coup vers la droite.
  const pending = data === undefined && error === undefined;
  if (!tile || !data)
    return <span aria-hidden className={`${pending ? "block" : "hidden sm:block"} shrink-0 rounded-lg bg-white/5`} style={{ width: THUMB_WIDTH, height }} />;
  const scale = THUMB_WIDTH / data.width;
  return (
    <span aria-hidden className="block shrink-0 overflow-hidden rounded-lg bg-white/5" style={{ width: THUMB_WIDTH, height: Math.round(data.height * scale) }}>
      <span
        className="block"
        style={{
          width: data.width,
          height: data.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          backgroundImage: `url(${tile.url})`,
          backgroundPosition: `${tile.bgX}px ${tile.bgY}px`,
          backgroundSize: `${data.width * data.tileWidth}px ${data.height * data.tileHeight}px`,
        }}
      />
    </span>
  );
}
