"use client";

/**
 * L'image dans l'image du système (28/10/2026) — à ne pas confondre avec « Réduire », le
 * mini-lecteur de l'app, qui reste dans la page.
 *
 * Proposée seulement là où le système l'accepte vraiment : Chrome et Edge (ordinateur, Android,
 * app installée comprise), Safari sur Mac et dans un onglet sur iPhone et iPad. **Pas dans l'app
 * installée depuis Safari sur iPhone et iPad** : WebKit y répond `pictureInPictureEnabled = true`,
 * mais `requestPictureInPicture()` y échoue (`NotSupportedError`) ou ne fait rien — défaut connu
 * d'Apple, toujours ouvert en iOS 27.2 (WebKit 303885 et 280627, rdar://121964774). Seule
 * `webkitSupportsPresentationMode("picture-in-picture")` y dit la vérité (`false`) : c'est elle qui
 * décide sur WebKit. Le jour où Apple corrige, elle répondra oui et le bouton apparaîtra seul.
 * Firefox n'a pas l'API (il pose son propre bouton sur la vidéo) : rien ici.
 */

import { useCallback, useEffect, useState, type RefObject } from "react";

interface PipVideoElement extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
}

/** Le système acceptera-t-il cet élément en image dans l'image ? */
export function systemPipAvailable(video: HTMLVideoElement): boolean {
  if (typeof document === "undefined" || document.pictureInPictureEnabled !== true) return false;
  if (typeof video.requestPictureInPicture !== "function" || video.disablePictureInPicture) return false;
  const probe = (video as PipVideoElement).webkitSupportsPresentationMode;
  if (typeof probe === "function") {
    try {
      return probe.call(video, "picture-in-picture") === true;
    } catch {
      return false;
    }
  }
  return true;
}

export function useSystemPip(videoRef: RefObject<HTMLVideoElement | null>) {
  const [pipSupported, setPipSupported] = useState(false);
  const [pipActive, setPipActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const check = () => setPipSupported(systemPipAvailable(video));
    const enter = () => setPipActive(true);
    const leave = () => setPipActive(false);
    check();
    // Une source qui change (une reconstruction, le lecteur serveur) peut changer la réponse.
    video.addEventListener("loadedmetadata", check);
    video.addEventListener("enterpictureinpicture", enter);
    video.addEventListener("leavepictureinpicture", leave);
    setPipActive(document.pictureInPictureElement === video);
    return () => {
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("enterpictureinpicture", enter);
      video.removeEventListener("leavepictureinpicture", leave);
    };
  }, [videoRef]);

  /** À appeler dans le geste lui-même : le système refuse une demande qui n'en vient pas. */
  const togglePip = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const request = document.pictureInPictureElement === video ? document.exitPictureInPicture() : video.requestPictureInPicture();
    // Un refus (pas encore de métadonnées, système qui dit non malgré tout) laisse le lecteur tel quel.
    request.catch(() => setPipSupported(systemPipAvailable(video)));
  }, [videoRef]);

  return { pipSupported, pipActive, togglePip };
}
