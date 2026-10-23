"use client";

import { missingCount, openingSeason, orderSeasons } from "@/lib/seasonOrder";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, Check } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import { episodeRowFacts } from "@/lib/episodeRow";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useSheetKeys } from "@/lib/useSheetKeys";
import { useSheetBehind, arrivedByBack } from "@/lib/cinemaRoute";
import { usePlayerSeriesRequests } from "@/lib/usePlayerSeriesRequests";
import { CinemaMissingEpisodes } from "@/components/cinema/CinemaMissingEpisodes";
import { useT } from "@/components/TranslationProvider";
import { SheetBackButton } from "@/components/cinema/DesktopSheetShell";
import { usePlayback } from "@/components/PlaybackProvider";
import { playerHoldsKeyboard } from "@/lib/playerKeyboard";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import type { CinemaSeason, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { OfflineEpisodeButton, OfflineSeasonDownload } from "@/components/offline/OfflineEpisodeDownload";

// "Plus d'épisodes" — Netflix's own TV-app episode browser: seasons as a vertical list on the
// left, that season's episodes (thumbnail/title/duration/synopsis) on the right. Opened from
// CinemaSeriesDetail's menu, portaled to document.body for the same containing-block reason
// every other Cinema Mode fixed layer is (see CinemaClient's own doc comment) — and sits one
// z-index above it (48 vs 46) so it visually replaces the detail sheet rather than stacking
// under/beside it.
export function CinemaEpisodeBrowser({
  title,
  seasons,
  sonarrId,
  seriesItemId,
  posterUrl,
  nextEpisodeId,
  onClose,
  onPlayEpisode,
}: {
  title: string;
  seasons: CinemaSeason[];
  /** Ce qui permet de savoir ce qui manque, et de le demander. */
  sonarrId?: number;
  /**
   * La série chez Jellyfin — ce qui ouvre le téléchargement hors ligne des épisodes (bêta, §109) :
   * le bouton de chaque ligne et « Télécharger la saison ». Absent, aucun des deux n'est rendu.
   */
  seriesItemId?: string;
  posterUrl?: string | null;
  // The series' own "Lire"/"Reprendre" target (CinemaSeriesDetail's nextEpisode) — badged here
  // too so it's obvious at a glance which episode picking "Plus d'épisodes" would have landed on
  // anyway, without having to cross-reference against the detail sheet underneath.
  nextEpisodeId?: string;
  onClose: () => void;
  onPlayEpisode: (episode: CinemaEpisode) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const missing = usePlayerSeriesRequests(sonarrId);
  // Lecture intégrée fermée (`PLAYER_ENABLED=false`) : la liste reste lisible, mais une ligne ne
  // lance plus rien et ne montre plus de bouton de lecture. Elle appelait `onPlayEpisode` quoi qu'il
  // arrive, et menait à « Lecteur intégré désactivé » (29/09/2026) — même garde que `PlayButton`,
  // et « non » tant qu'on ne sait pas.
  const playerEnabled = usePlayerEnabled();

  // La liste des saisons vient de Jellyfin, donc de ce qu'on possède : une saison entière absente
  // n'y figurait pas du tout. On voyait quatre saisons d'une série qui en compte cinq, sans rien
  // qui le dise. Les deux listes sont réunies ici.
  const seasonNumbers = useMemo(() => {
    const all = new Set<number>(seasons.map((s) => s.seasonNumber));
    for (const s of missing.seasons) all.add(s.seasonNumber);
    // Les spéciaux en dernier — voir `orderSeasons`.
    return orderSeasons(all);
  }, [seasons, missing.seasons]);

  // Figée au montage, par la même règle que le téléphone — voir `openingSeason`.
  const [selectedSeason, setSelectedSeason] = useState(
    () =>
      openingSeason(
        seasons.map((s) => s.seasonNumber),
        missing.seasons.map((s) => s.seasonNumber)
      ) ?? 0
  );

  // Same debounce-before-crossfade pattern CinemaClient's own hero backdrop uses (see its doc
  // comment on "ghosting") — selectedSeason changes on every arrow-key press while scrubbing
  // through the season list (onFocus fires per row passed through), and the episode pane below
  // is keyed by season number to crossfade on a change; without debouncing, holding Up/Down would
  // restart that fade on every intermediate season instead of settling once on the one landed on.
  const [displayedSeason, setDisplayedSeason] = useState(selectedSeason);
  useEffect(() => {
    const timer = setTimeout(() => setDisplayedSeason(selectedSeason), 150);
    return () => clearTimeout(timer);
  }, [selectedSeason]);
  const episodes = seasons.find((s) => s.seasonNumber === displayedSeason)?.episodes ?? [];
  // Le téléchargement hors ligne des épisodes (§109).
  const offlineSeries = useMemo(
    () => (seriesItemId ? { seriesItemId, sonarrId: sonarrId ?? null, seriesTitle: title } : null),
    [seriesItemId, sonarrId, title]
  );

  // "Going deeper" from the detail sheet — see the hook's own doc comment and globals.css's note
  // on slide-in-right/slide-out-right for why this gets a slide instead of every other Cinema
  // Mode overlay's plain fade: this is the one place a full screen genuinely replaces another
  // rather than layering on top of it.
  // Pas d'animation de sortie quand c'est une autre fiche qui attend derrière : la sortie
  // découvrirait l'accueil deux dixièmes de seconde avant que la précédente n'entre par-dessus.
  // Voir `useSheetBehind`.
  // Monté parce qu'on revient dessus, et non parce qu'on l'ouvre : pas d'animation d'entrée. Il
  // n'ouvre rien, il se découvre — voir `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());
  const sheetBehind = useSheetBehind();
  const { closing, requestClose } = useDelayedClose(onClose, sheetBehind ? 0 : 220);

  // Le focus va sur la saison ouverte, et non sur la première de la liste : poser le focus la
  // choisit (`onFocus`), et la première est une saison manquante dès que Sonarr a déjà répondu —
  // la fiche ouvrait alors la saison 1, vide, d'une série dont seule la 15 est là (29/09/2026).
  // Au montage seulement : la saison choisie ensuite suit déjà le focus.
  const [openedOn] = useState(selectedSeason);
  useEffect(() => {
    const list = containerRef.current;
    (
      list?.querySelector<HTMLButtonElement>(`[data-episode-season="true"][data-season="${openedOn}"]`) ??
      list?.querySelector<HTMLButtonElement>('[data-episode-season="true"]')
    )?.focus();
  }, [openedOn]);

  // The episode pane is keyed by displayedSeason, so changing season unmounts every button in it
  // — including the focused one if focus was over there (hovering the season list with the mouse
  // while navigating episodes by keyboard does exactly that). Focus then falls to <body>, where
  // the key handler below matches neither list and arrow keys go dead until something is clicked.
  // Same "menu closed and took focus with it" class of bug as elsewhere in Cinema Mode; catching
  // it here keeps keyboard control alive through a mouse-driven season change.
  useEffect(() => {
    if (document.activeElement !== document.body) return;
    containerRef.current?.querySelector<HTMLButtonElement>('[data-episode-item="true"]')?.focus();
  }, [displayedSeason]);

  // Stays open under the player once an episode starts, so closing the player comes back to the
  // season you launched it from — and stands down from the keyboard while it's up there, or both
  // handlers would run on every arrow press (see CinemaMovieDetail's own note).
  const playback = usePlayback();
  const playerOwnsKeyboard = playerHoldsKeyboard(playback);

  // Left/Right move between the season list and the episode list; Up/Down cycle within
  // whichever one currently has focus — same roving-focus convention as the player's own
  // directional nav and CinemaMovieDetail's vertical menu.
  // Échap et Retour arrière referment ; une feuille ouverte depuis une ligne (téléchargement hors
  // ligne) a ses touches — Échap la referme, elle, pas cet écran derrière elle (règle 2 des fiches).
  // La règle de toutes les fiches : `useSheetKeys`.
  useSheetKeys({
    listening: !playerOwnsKeyboard,
    onClose: requestClose,
    onKey: (e) => {
      const active = document.activeElement as HTMLElement | null;
      const inSeasons = active?.getAttribute("data-episode-season") === "true";
      const inEpisodes = active?.getAttribute("data-episode-item") === "true";
      // Le bouton de téléchargement d'une ligne, à sa droite : → depuis l'épisode, ← pour y revenir,
      // ↑/↓ d'un bouton de téléchargement à l'autre — une troisième colonne, comme celle des saisons.
      const inDownloads = active?.getAttribute("data-episode-download") === "true";
      if (!inSeasons && !inEpisodes && !inDownloads) return;

      if (e.key === "ArrowRight" && inSeasons) {
        e.preventDefault();
        containerRef.current?.querySelector<HTMLButtonElement>('[data-episode-item="true"]:not(:disabled)')?.focus();
        return;
      }
      if (e.key === "ArrowRight" && inEpisodes) {
        const download = active?.closest("[data-episode-row]")?.querySelector<HTMLButtonElement>('[data-episode-download="true"]');
        if (download) {
          e.preventDefault();
          download.focus();
        }
        return;
      }
      if (e.key === "ArrowLeft" && inDownloads) {
        e.preventDefault();
        active?.closest("[data-episode-row]")?.querySelector<HTMLButtonElement>('[data-episode-item="true"]')?.focus();
        return;
      }
      if (e.key === "ArrowLeft" && inEpisodes) {
        e.preventDefault();
        containerRef.current?.querySelector<HTMLButtonElement>(`[data-episode-season="true"][data-season="${selectedSeason}"]`)?.focus();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        // Un bouton désactivé — une demande déjà faite — ne prend pas le focus : le sauter.
        const selector = inSeasons ? '[data-episode-season="true"]' : inDownloads ? '[data-episode-download="true"]' : '[data-episode-item="true"]:not(:disabled)';
        const items = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>(selector) ?? []);
        const idx = items.indexOf(active as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? items[Math.min(idx + 1, items.length - 1)] : items[Math.max(idx - 1, 0)];
        next?.focus();
      }
    },
  });

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={containerRef}
      className={`fixed inset-0 overflow-hidden bg-ink ${closing ? "animate-fade-out" : revealed ? "" : "animate-fade-in"}`}
      // Le rail du lecteur est posé sur le bord gauche de l'écran, au-dessus de cette fiche :
      // sans ce retrait, la colonne de texte et le bouton Retour passeraient dessous. La variable
      // vaut 0 partout ailleurs, donc rien ne bouge hors du lecteur.
      style={{ zIndex: 49, paddingLeft: "var(--player-rail, 0px)" }}
    >
      <SheetBackButton onClick={requestClose} />

      {/* No position:fixed descendants here (the back button above is a sibling) — safe to
          transform, unlike the outer root (see globals.css's own note on this pitfall). */}
      <div className={`flex h-full pt-20 ${closing ? "animate-slide-out-right" : revealed ? "" : "animate-slide-in-right"}`}>
        {/* Une colonne flottante, dans le matériau du rail sans son ombre (26/09/2026, `float-surface`) : elle était collée au bord
            gauche sur toute la hauteur, séparée des épisodes par un filet. Décollée d'un
            trois-quarts de rem, comme la fenêtre des panneaux ; opaque, parce que la liste d'à côté
            défile. Le fond seul est arrondi, et c'est une zone intérieure, retirée des coins, qui
            défile : un arrondi qui découpe ce qui défile se recalcule à chaque image (même leçon
            que la fenêtre des panneaux). À la hauteur de ses saisons (Louis, 19/10/2026) : étirée sur
            toute la page, elle laissait un grand cadre vide sous quatre saisons ; plafonnée à la page,
            elle défile au-delà. */}
        <div className="float-surface mb-3 ml-3 flex max-h-[calc(100%-0.75rem)] w-56 shrink-0 self-start rounded-2xl sm:w-64">
        <div className="scrollbar-thin my-1.5 min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1.5">
          <p className="mb-3 truncate px-2 text-sm font-medium text-muted">{title}</p>
          {seasonNumbers.map((seasonNumber) => {
            const active = seasonNumber === selectedSeason;
            const gap = missingCount(missing.seasonOf(seasonNumber));
            return (
              <button
                key={seasonNumber}
                data-episode-season="true"
                data-season={seasonNumber}
                onFocus={() => setSelectedSeason(seasonNumber)}
                onMouseEnter={() => setSelectedSeason(seasonNumber)}
                className={`mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none ${
                  active ? "bg-accent-600/25 text-white ring-1 ring-accent-500/50" : "text-muted hover:bg-white/10"
                }`}
              >
                <span className="truncate">
                  {seasonNumber === 0 ? t("cinema.specials") : t("cinema.season", { n: seasonNumber })}
                </span>
                {/* Le compte de ce qui manque, à côté de la saison : c'est ce qu'on cherche à
                    savoir en parcourant cette colonne. */}
                {gap > 0 && (
                  <span className="shrink-0 rounded-full bg-white/10 px-1.5 text-[11px] tabular-nums text-subtle">
                    {gap}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 pb-16 pt-1 sm:px-10">
          {/* Keyed by the debounced season, not the live one — remounting (and re-fading) this
              on every intermediate season while scrubbing would be exactly the "ghosting" bug
              CinemaClient's own hero backdrop hit; see displayedSeason's own doc comment above. */}
          <div key={displayedSeason} className="mx-auto flex max-w-3xl animate-fade-in flex-col gap-2">
            {/* « Télécharger la saison », en tête de la saison affichée (§109) : la taille estimée
                sur le bouton, la question posée une fois pour tous ses épisodes. */}
            {offlineSeries && episodes.length > 0 && (
              <div className="flex justify-end px-3">
                <OfflineSeasonDownload series={offlineSeries} seasons={seasons} seasonNumber={displayedSeason} posterUrl={posterUrl} size="desktop" />
              </div>
            )}
            {episodes.map((ep) => {
              // Le temps restant ou la durée, et « À suivre » : la règle des trois listes (`episodeRowFacts`).
              const row = episodeRowFacts(ep, nextEpisodeId);
              return (
              // La ligne est un conteneur, et non plus un bouton : le bouton de téléchargement est à
              // côté de celui de l'épisode, jamais dedans (un bouton dans un bouton n'est pas du HTML
              // valide). L'épisode garde `data-episode-item` et tout ce que les flèches en attendent.
              <div key={ep.jellyfinItemId} data-episode-row="" className="flex items-center gap-1">
              <button
                data-episode-item="true"
                // Focalisable quand même : les flèches parcourent la liste et font défiler le synopsis.
                aria-disabled={!playerEnabled || undefined}
                onClick={() => {
                  if (playerEnabled) onPlayEpisode(ep);
                }}
                className="flex min-w-0 flex-1 items-start gap-4 rounded-lg p-3 text-left transition-colors hover:bg-white/10 active:transform-none active:bg-white/15 active:delay-75 focus-visible:bg-white/10 focus-visible:outline-none"
              >
                <div className="relative w-40 shrink-0 sm:w-48">
                  <PosterImage src={ep.thumbnailUrl} alt={ep.title} aspectRatio="aspect-video" unoptimized subtle />
                  {playerEnabled && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity hover:bg-black/30 hover:opacity-100">
                      <Play size={28} className="text-white drop-shadow-lg" fill="currentColor" />
                    </span>
                  )}
                  {ep.watched && (
                    <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand-strong">
                      <Check size={12} className="text-white" />
                    </span>
                  )}
                  <CinemaEpisodeProgress resumeTicks={ep.resumeTicks} runtimeTicks={ep.runtimeTicks} watched={ep.watched} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-white">
                      {ep.episodeNumber}. {ep.title}
                    </span>
                    {row.isNext && (
                      <span className="shrink-0 rounded-full bg-accent-600/25 px-2 py-0.5 text-xs font-medium text-accent-400 ring-1 ring-accent-500/40">
                        {t("cinema.nextUpBadge")}
                      </span>
                    )}
                    {/* A started episode says what's LEFT, not how long it is — the number you
                        actually want before pressing play. Untouched ones keep the runtime. */}
                    {row.remaining !== null ? (
                      <span className="shrink-0 text-xs text-accent-400">{t("cinema.timeRemaining", { time: row.remaining })}</span>
                    ) : (
                      row.runtime !== null && <span className="shrink-0 text-xs text-subtle">{row.runtime}</span>
                    )}
                  </div>
                  {ep.overview && <p className="mt-1 line-clamp-2 text-xs text-muted">{ep.overview}</p>}
                </div>
              </button>
              {offlineSeries && <OfflineEpisodeButton series={offlineSeries} seasons={seasons} episode={ep} posterUrl={posterUrl} size="desktop" />}
              </div>
              );
            })}

            <CinemaMissingEpisodes
              season={missing.seasonOf(displayedSeason)}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
