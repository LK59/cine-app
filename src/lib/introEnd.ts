"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Quand l'ouverture de la lecture (DECISIONS.md §60) laisse la place au film — les deux règles, une par
 * lecteur, écrites ici plutôt que dans chacun d'eux pour être éprouvées sans monter un lecteur entier.
 *
 * Ce qu'il faut à chacune, c'est ce qu'un `HTMLVideoElement` dit de lui-même.
 */
export type IntroMedia = Pick<HTMLVideoElement, "paused" | "seeking" | "readyState" | "currentTime"> &
  Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Toutes les combien de temps relire un état que rien n'annonce (un refus de lecture automatique). */
const RECHECK_MS = 500;

/** Combien de temps un élément doit rester « refusé » pour l'être — voir `useIntroPlaybackStarted`. */
export const REFUSAL_CONFIRM_MS = 1000;

/** Combien de temps un élément serveur arrêté sur une image l'est vraiment — voir `useServerIntroPicture`. */
export const PAUSED_PICTURE_MS = 2500;

/**
 * Lecteur natif : la lecture refusée par le navigateur, et non une ouverture qui attend son média.
 *
 * Un élément arrêté sans attente armée ne suffit pas : à l'ouverture, l'élément est aussi arrêté quand
 * rien n'est encore sous la tête — une reprise dont le média arrive (`pendingStart`), un démarrage qui
 * renonce faute de média et que la garde relancera. L'ouverture s'effaçait alors au bout d'une seconde
 * et demie sur un écran noir, sans roue (l'attente n'étant pas armée), jusqu'à ce que le film parte de
 * lui-même — sur une reprise en réseau lent, le cas de Louis en itinérance. Un refus, lui, laisse un
 * élément arrêté *sur une image* : `readyState` ≥ 2, aucun saut en cours.
 */
export function playbackRefused(media: IntroMedia, waitArmed: boolean): boolean {
  return media.paused && !media.seeking && media.readyState >= 2 && !waitArmed;
}

/**
 * Lecteur natif : vrai quand l'horloge avance vraiment, ou quand la lecture a été refusée et que le
 * bouton Lecture des commandes doit se voir. `active` : le lecteur est prêt (`announced`).
 *
 * Mesuré depuis le dernier placement de la tête : l'atterrissage de l'ouverture (0 → 0,27 s) et la
 * poussée d'une horloge figée sont des sauts, pas de la lecture (`PlaybackGuard.headPlaced`).
 */
export function useIntroPlaybackStarted(
  active: boolean,
  mediaRef: RefObject<IntroMedia | null>,
  waitArmedRef: RefObject<boolean>
): boolean {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!active || started) return;
    const media = mediaRef.current;
    if (!media) return;
    let from = media.currentTime;
    const onSeek = () => {
      from = media.currentTime;
    };
    const onTime = () => {
      if (!media.paused && !media.seeking && media.currentTime > from + 0.1) setStarted(true);
    };
    // Un refus se confirme sur la durée : l'élément passe par « arrêté sur une image » entre l'arrivée
    // du média et l'appel à `play()`, et ce passage-là n'en est pas un.
    let refusedSince: number | null = null;
    const recheck = window.setInterval(() => {
      if (!playbackRefused(media, waitArmedRef.current)) {
        refusedSince = null;
        return;
      }
      refusedSince ??= Date.now();
      if (Date.now() - refusedSince >= REFUSAL_CONFIRM_MS) setStarted(true);
    }, RECHECK_MS);
    media.addEventListener("timeupdate", onTime);
    media.addEventListener("seeking", onSeek);
    media.addEventListener("seeked", onSeek);
    return () => {
      window.clearInterval(recheck);
      media.removeEventListener("timeupdate", onTime);
      media.removeEventListener("seeking", onSeek);
      media.removeEventListener("seeked", onSeek);
    };
  }, [active, started, mediaRef, waitArmedRef]);
  return started;
}


/**
 * Lecteur serveur : l'élément a de quoi avancer à sa position — plus de saut en cours, `readyState`
 * ≥ 3. À 2, la roue des commandes prenait encore la suite le temps de remplir ; et `loadeddata`, où
 * tombe `loading`, précède le saut vers la position de reprise (Forrest Gump repris à 21 min,
 * 10/10/2026 : ~3 s d'écran noir).
 */
export function serverPictureReady(media: IntroMedia): boolean {
  return !media.seeking && media.readyState >= 3;
}

/**
 * Lecteur serveur : vrai quand l'image est là (`serverPictureReady`) — ou quand l'élément reste arrêté
 * sur une image sans jamais aller plus loin : la lecture automatique refusée (iOS sans geste récent,
 * `NotAllowedError`), qu'aucun événement n'annonce et où Safari, à l'arrêt, ne remplit pas forcément
 * jusqu'à `readyState` 3. L'ouverture restait alors posée pour toujours sur le bouton Lecture.
 *
 * Confirmé sur `PAUSED_PICTURE_MS` : avec l'attribut `autoplay` (hls.js), l'élément est aussi arrêté,
 * sur une image, le temps de remplir assez pour partir — et ce passage-là n'est pas un refus.
 */
export function useServerIntroPicture(loading: boolean, mediaRef: RefObject<IntroMedia | null>): boolean {
  const [pictured, setPictured] = useState(false);
  useEffect(() => {
    if (loading || pictured) return;
    const media = mediaRef.current;
    let live = true;
    let pausedSince: number | null = null;
    const check = () => {
      if (!live) return;
      if (!media || serverPictureReady(media)) {
        setPictured(true);
        return;
      }
      if (media.paused && !media.seeking && media.readyState >= 2) {
        pausedSince ??= Date.now();
        if (Date.now() - pausedSince >= PAUSED_PICTURE_MS) setPictured(true);
      } else {
        pausedSince = null;
      }
    };
    // Déjà là le plus souvent (un départ du début) : lu au tour suivant plutôt que dans le corps de
    // l'effet, où le compilateur React refuse un `setState`.
    queueMicrotask(check);
    const recheck = window.setInterval(check, RECHECK_MS);
    const events = ["seeked", "canplay", "canplaythrough", "playing"] as const;
    for (const e of events) media?.addEventListener(e, check);
    return () => {
      live = false;
      window.clearInterval(recheck);
      for (const e of events) media?.removeEventListener(e, check);
    };
  }, [loading, pictured, mediaRef]);
  return pictured;
}
