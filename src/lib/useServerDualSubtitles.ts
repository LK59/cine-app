"use client";

import { useEffect, useState, type RefObject } from "react";
import { simultaneousText, stripSubtitleMarkup } from "@/lib/webcodecs/subtitleMarkup";

/**
 * « Deux sous-titres » dans le lecteur serveur (DECISIONS.md §87).
 *
 * D'ordinaire ce lecteur laisse le navigateur dessiner son sous-titre : une piste `<track>` en
 * `showing`, placée et stylée par `::cue`. Mais `::cue` n'accepte aucune propriété de placement, et
 * l'on ne sait pas où le navigateur pose sa ligne : impossible d'y loger un second juste au-dessus.
 * En mode deux sous-titres, les deux pistes passent donc en `hidden` — le navigateur les charge et
 * tient leurs répliques actives (`activeCues`), sans rien dessiner — et c'est la page qui dessine les
 * deux, au même calque que le lecteur natif (`SubtitleLayer`). Un seul sous-titre : rien ne change,
 * le navigateur dessine comme avant.
 *
 * Pendant une diffusion (AirPlay), rien de tout cela : le principal redevient une piste ordinaire et
 * le second n'est pas dessiné — la télévision ne reçoit que le principal.
 *
 * Les décalages (`PlayerControls.shiftCues`) déplacent les répliques des pistes elles-mêmes : ils
 * valent ici sans rien de plus, `activeCues` suivant les nouveaux temps.
 */
export function useServerDualSubtitles({
  videoRef,
  trackIds,
  primaryNow,
  primary,
  second,
  enabled,
  videoKey,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Les numéros des pistes dans l'ordre des `<track>` — l'ordre de `video.textTracks`. */
  trackIds: readonly number[];
  /** Le principal à l'instant de la sortie du mode — lu à ce moment-là : c'est lui qui redevient `showing`. */
  primaryNow: () => number | null;
  primary: number | null;
  second: number | null;
  /** Faux pendant une diffusion. */
  enabled: boolean;
  /** Le `<video>` remonté (bascule de piste WebKit) : tout est à rebrancher. */
  videoKey: unknown;
}): { primary: string | null; second: string | null; active: boolean } {
  const [texts, setTexts] = useState<{ primary: string | null; second: string | null }>({ primary: null, second: null });
  const active = enabled && primary !== null && second !== null;

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video || !video.textTracks) return;
    const tracks = video.textTracks;
    const primaryAt = trackIds.indexOf(primary!);
    const secondAt = trackIds.indexOf(second!);
    const modes = () => {
      for (let i = 0; i < tracks.length; i++) {
        const wanted = i === primaryAt || i === secondAt ? "hidden" : "disabled";
        if (tracks[i].mode !== wanted) tracks[i].mode = wanted;
      }
    };
    const textOf = (at: number): string | null => {
      const cues = at >= 0 ? tracks[at]?.activeCues : null;
      if (!cues || cues.length === 0) return null;
      const covering: { startSeconds: number; text: string }[] = [];
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i] as TextTrackCue & { text?: string };
        const text = stripSubtitleMarkup(cue.text ?? "").trim();
        if (text) covering.push({ startSeconds: cue.startTime, text });
      }
      return simultaneousText(covering);
    };
    const read = () => setTexts({ primary: textOf(primaryAt), second: textOf(secondAt) });
    modes();
    const watched = [primaryAt, secondAt].map((at) => tracks[at]).filter((track): track is TextTrack => !!track);
    for (const track of watched) track.addEventListener("cuechange", read);
    // `cuechange` ne vient pas pour un décalage pendant une pause, ni toujours à l'entrée dans le
    // mode : la position et le chargement relisent aussi.
    video.addEventListener("timeupdate", read);
    video.addEventListener("seeked", read);
    // Un chargement peut remettre les modes à zéro (nouvelle source, pistes rechargées).
    const reload = () => {
      modes();
      read();
    };
    video.addEventListener("loadeddata", reload);
    const first = setTimeout(read, 0);
    return () => {
      clearTimeout(first);
      for (const track of watched) track.removeEventListener("cuechange", read);
      video.removeEventListener("timeupdate", read);
      video.removeEventListener("seeked", read);
      video.removeEventListener("loadeddata", reload);
      // Sortie du mode (ou changement de l'une des deux) : le navigateur redessine le principal du
      // moment. Si le mode continue, l'effet suivant remet tout en `hidden` dans la même validation,
      // avant toute peinture.
      const now = primaryNow();
      const nowAt = now === null ? -1 : trackIds.indexOf(now);
      for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === nowAt ? "showing" : "disabled";
    };
  }, [active, videoRef, trackIds, primaryNow, primary, second, videoKey]);

  return active ? { ...texts, active } : { primary: null, second: null, active };
}
