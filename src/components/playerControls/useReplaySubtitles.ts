"use client";

/**
 * Les sous-titres d'un passage rejoué, côté commandes (DECISIONS.md §150) : le déclencheur, la fenêtre et la
 * pastille — communs aux trois lecteurs. Les règles sont dans `replaySubtitles.ts` ; chaque hôte ne fait
 * qu'afficher la piste qu'on lui donne (`show`), sur une voie à part de son choix à lui, puis l'éteindre.
 *
 * - L'hôte dit quelle piste montrerait l'aide **maintenant** (`track()`, `null` : aucune — un complet déjà à
 *   l'écran, une diffusion, rien dans une langue utile).
 * - Un recul pour réécouter, film en lecture, ouvre la fenêtre (ou l'allonge) ; la position d'avant le recul,
 *   plus deux secondes, en est la fin.
 * - Elle se ferme à cette fin, à tout autre saut, à un choix dans le menu des sous-titres, quand l'hôte n'a
 *   plus de piste à donner (une diffusion commence), et au démontage des commandes (une reconstruction, la
 *   fermeture) : `show(null)` rend l'affichage d'avant, rien n'a jamais été choisi.
 * - La pastille touchée : un vrai choix (`onChangeSubtitle`, compté comme tel), et l'aide se ferme.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { extendReplayWindow, isReplayRewind, noteReplayKept, noteReplayShown, type ReplayWindow } from "@/lib/replaySubtitles";
import { useLatest } from "@/components/playerControls/useLatest";

export interface ReplaySubtitleHost {
  /** La piste que l'aide montrerait maintenant, ou `null` — demandée au recul, puis à chaque `timeupdate` de l'aide. */
  track: () => number | null;
  /** Montre cette piste sur la voie de l'aide ; `null` l'éteint et rend l'affichage d'avant. */
  show: (track: number | null) => void;
}

export function useReplaySubtitles({
  itemId,
  videoRef,
  host,
  onChangeSubtitle,
}: {
  itemId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  host: ReplaySubtitleHost | undefined;
  onChangeSubtitle: (id: number | null) => void;
}) {
  const [open, setOpen] = useState<ReplayWindow | null>(null);
  // Lu par les écouteurs et par les gestes : l'état rendu peut avoir un tour de retard sur deux reculs d'affilée.
  const openRef = useRef<ReplayWindow | null>(null);
  const hostRef = useLatest(host);

  const end = useCallback(() => {
    if (!openRef.current) return;
    openRef.current = null;
    setOpen(null);
    hostRef.current?.show(null);
  }, [hostRef]);

  /** Un saut des commandes, de `from`, de `deltaSeconds` : un recul pour réécouter ouvre ou allonge, tout autre ferme. */
  const noteSkip = useCallback(
    (deltaSeconds: number, from: number) => {
      const video = videoRef.current;
      const current = openRef.current;
      if (!isReplayRewind(deltaSeconds)) {
        end();
        return;
      }
      // En pause, un recul n'ouvre rien (on revoit une image) ; une aide déjà ouverte s'allonge quand même.
      if (!current && (!video || video.paused)) return;
      const next = extendReplayWindow(current, hostRef.current?.track() ?? null, from);
      if (!next) return;
      openRef.current = next;
      setOpen(next);
      if (!current) {
        hostRef.current?.show(next.track);
        noteReplayShown(itemId);
      }
    },
    [videoRef, hostRef, end, itemId]
  );

  /** La pastille : les garder pour de bon — un vrai choix. */
  const keep = useCallback(() => {
    const current = openRef.current;
    if (!current) return;
    end();
    noteReplayKept(itemId);
    onChangeSubtitle(current.track);
  }, [end, itemId, onChangeSubtitle]);

  // La fin du passage, et la piste que l'hôte ne peut plus donner (une diffusion a commencé).
  useEffect(() => {
    const video = videoRef.current;
    if (!open || !video) return;
    const check = () => {
      const window = openRef.current;
      if (!window) return;
      if (video.currentTime > window.until || (hostRef.current?.track() ?? null) === null) end();
    };
    video.addEventListener("timeupdate", check);
    return () => video.removeEventListener("timeupdate", check);
  }, [open, videoRef, hostRef, end]);

  // Les commandes démontées (reconstruction, fermeture, passage de main) : l'hôte rend son affichage d'avant.
  useEffect(() => () => {
    if (!openRef.current) return;
    openRef.current = null;
    hostRef.current?.show(null);
  }, [hostRef]);

  return { active: open !== null, noteSkip, end, keep };
}
