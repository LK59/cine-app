"use client";

// Les sous-titres de Lumen serveur dessinés par la page (DECISIONS.md §190), comme ceux du lecteur natif : notre calque
// (`SubtitleLayer`), notre style (`subtitleStyleStore`), la rangée qui s'écarte des commandes affichées (`chromeEdges`).
//
// Avant, la piste choisie était un `<track>` en `showing` : Safari la dessinait lui-même, collée au bas de l'image,
// dans son style, sous les commandes. Les `<track>` restent — ils chargent les répliques, et ne sont posés qu'après la
// première image de l'élément (`tracksFor`, sinon Safari refuse l'élément) —, mais en `hidden` : le navigateur les
// charge et ne dessine rien. La page lit la réplique à l'instant `currentTime − décalage` (`cueLookupTime`, la règle du
// lecteur natif) et l'écrit dans le calque. Un seul chemin pour un sous-titre, deux sous-titres (§87) et le passage
// rejoué (§150) : l'hôte dit quelle piste tient chaque voie, ce module en tient les modes et les lignes.
//
// Ce que ce module ne fait pas : les lignes d'une génération en cours (§187), qui n'ont pas encore de piste —
// `useLumenSubtitleGeneration` les donne, l'hôte choisit laquelle des deux voies s'écrit.
import { useEffect, useState, type RefObject } from "react";
import { cueLookupTime } from "@/lib/subtitleSync";
import { nextCueChange, textTrackCues, textTrackTextAt } from "@/lib/textTrackCues";

/** Une voie : la piste (son numéro, `null` : rien) et son décalage, en secondes (le menu ±0,5 s). */
export interface LumenSubtitleLane {
  id: number | null;
  offset: number;
}

/** Une relecture programmée tombe un peu après la borne, pour que la réplique finie ne soit plus « à l'écran ». */
const BOUNDARY_SLACK_S = 0.02;

export function useLumenSubtitleLines({
  videoRef,
  videoKey,
  ready,
  trackIds,
  primary,
  second,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Le `<video>` remonté (relance, réouverture pour une piste son) : tout est à rebrancher. */
  videoKey: unknown;
  /** Les `<track>` de cet élément sont posés (après sa première image) : on peut régler leurs modes. */
  ready: boolean;
  /** Les numéros des pistes dans l'ordre des `<track>` — l'ordre de `video.textTracks`. */
  trackIds: readonly number[];
  primary: LumenSubtitleLane;
  second: LumenSubtitleLane;
}): { primary: string | null; second: string | null } {
  // Les lignes, marquées de ce qui les a produites : une ligne d'une autre piste (ou d'un autre élément) ne s'affiche
  // jamais le temps que l'effet relise — elle est écartée au rendu.
  const key = `${videoKey}:${primary.id}:${second.id}`;
  const [lines, setLines] = useState<{ key: string; primary: string | null; second: string | null }>({ key: "", primary: null, second: null });

  const primaryId = primary.id;
  const secondId = second.id;
  const primaryOffset = primary.offset;
  const secondOffset = second.offset;
  useEffect(() => {
    const video = videoRef.current;
    if (!ready || !video || !video.textTracks) return;
    const tracks = video.textTracks;
    const primaryAt = primaryId === null ? -1 : trackIds.indexOf(primaryId);
    const secondAt = secondId === null ? -1 : trackIds.indexOf(secondId);
    // `hidden` : chargée, tenue à jour, jamais dessinée par le navigateur ; les autres éteintes.
    const modes = () => {
      for (let i = 0; i < tracks.length; i++) {
        const wanted = i === primaryAt || i === secondAt ? "hidden" : "disabled";
        if (tracks[i].mode !== wanted) tracks[i].mode = wanted;
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const now = video.currentTime;
      // Les pistes de `<track>` sont datées sur l'horloge de l'élément (comme une piste du conteneur) : sans écart de
      // fichier ni échelle — la correction d'une piste recalée (§141) est déjà dans le WebVTT (`&sync=`).
      const lane = (at: number, offset: number) => {
        if (at < 0) return { text: null, next: null };
        const cues = textTrackCues(tracks[at]);
        const seconds = cueLookupTime(now, 0, offset, 1, false);
        const next = nextCueChange(cues, seconds);
        return { text: textTrackTextAt(cues, seconds), next: next === null ? null : next - seconds };
      };
      const p = lane(primaryAt, primaryOffset);
      const s = lane(secondAt, secondOffset);
      setLines((prev) => (prev.key === key && prev.primary === p.text && prev.second === s.text ? prev : { key, primary: p.text, second: s.text }));
      // La prochaine borne, relue à temps pendant la lecture : décalées, les répliques changent entre deux
      // `timeupdate`, et `cuechange` ne vient qu'aux bornes d'origine.
      const waits = [p.next, s.next].filter((n): n is number => n !== null);
      if (!video.paused && waits.length > 0) {
        const rate = video.playbackRate > 0 ? video.playbackRate : 1;
        const wait = (Math.min(...waits) + BOUNDARY_SLACK_S) / rate;
        if (wait < 30) timer = setTimeout(read, Math.max(0, wait * 1000));
      }
    };
    modes();
    const watched = [primaryAt, secondAt].map((at) => (at >= 0 ? tracks[at] : undefined)).filter((track): track is TextTrack => !!track);
    for (const track of watched) track.addEventListener("cuechange", read);
    // `cuechange` ne vient ni pour un décalage, ni toujours à l'entrée en `hidden` ; la fin du chargement d'un
    // `<track>` (`load`, qui ne remonte pas : écouté à la capture) apporte les répliques d'un coup, même en pause.
    video.addEventListener("timeupdate", read);
    video.addEventListener("seeked", read);
    video.addEventListener("play", read);
    video.addEventListener("pause", read);
    video.addEventListener("ratechange", read);
    video.addEventListener("load", read, true);
    // Un chargement peut remettre les modes à zéro (nouvelle source, pistes rechargées).
    const reload = () => {
      modes();
      read();
    };
    video.addEventListener("loadeddata", reload);
    // Le premier tour hors du corps de l'effet (la règle du compilateur React) — et tout de suite pour un décalage.
    const first = setTimeout(read, 0);
    return () => {
      clearTimeout(first);
      if (timer !== null) clearTimeout(timer);
      for (const track of watched) track.removeEventListener("cuechange", read);
      video.removeEventListener("timeupdate", read);
      video.removeEventListener("seeked", read);
      video.removeEventListener("play", read);
      video.removeEventListener("pause", read);
      video.removeEventListener("ratechange", read);
      video.removeEventListener("load", read, true);
      video.removeEventListener("loadeddata", reload);
    };
  }, [ready, videoRef, videoKey, trackIds, primaryId, secondId, primaryOffset, secondOffset, key]);

  return lines.key === key ? { primary: lines.primary, second: lines.second } : { primary: null, second: null };
}
