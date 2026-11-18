/**
 * Le lecteur en paysage sur Android (18/11/2026, demandé par le propriétaire) : tant qu'un film occupe tout l'écran,
 * l'écran reste couché — dans un sens ou dans l'autre (`landscape`), comme les applications vidéo. Un téléphone
 * qu'on pose de biais ou qu'on tient au lit ne fait plus basculer le film en portrait, et la mise en page des
 * commandes avec lui.
 *
 * **On demande au navigateur**, sans liste : `screen.orientation.lock` n'aboutit que là où il le permet — Chrome
 * sur Android, en plein écran (ou dans l'application installée selon la version). Safari sur iPhone et iPad refuse
 * toujours (la fonction existe, la promesse échoue), un ordinateur aussi : le refus est attendu, et silencieux.
 * Refusé faute de plein écran, l'essai est refait à l'entrée en plein écran. Seulement sur un écran qu'on touche
 * sans le survoler : un ordinateur portable tactile n'a rien à verrouiller.
 *
 * Rendu dès que le film quitte le plein écran (mini-lecteur, fermeture) : `unlock` rend l'orientation au système.
 * Une seule appelante : l'effet de `PlaybackProvider` sur le mode `full`.
 */

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
  unlock?: () => void;
};

const TOUCH_ONLY = "(hover: none) and (pointer: coarse)";

function orientationOf(w: Window): LockableOrientation | null {
  const o = w.screen?.orientation as LockableOrientation | undefined;
  return o && typeof o.lock === "function" ? o : null;
}

/** Tient l'écran en paysage ; rend la fonction qui le relâche. Ne lève jamais. */
export function holdLandscape(w: Window = window): () => void {
  const orientation = orientationOf(w);
  if (!orientation || !w.matchMedia?.(TOUCH_ONLY).matches) return () => {};
  let held = false;
  let released = false;
  const attempt = () => {
    if (released || held) return;
    orientation.lock!("landscape").then(
      () => {
        if (released) orientation.unlock?.();
        else held = true;
      },
      () => {
        // Refusé (iPhone, iPad, pas encore en plein écran) : rien à faire, la mise en page suit l'appareil.
      }
    );
  };
  const onFullscreen = () => {
    if (w.document.fullscreenElement) attempt();
  };
  attempt();
  w.document.addEventListener("fullscreenchange", onFullscreen);
  return () => {
    released = true;
    w.document.removeEventListener("fullscreenchange", onFullscreen);
    if (held) {
      try {
        orientation.unlock?.();
      } catch {
        // Déjà rendu par le navigateur (sortie du plein écran) : rien à rendre.
      }
    }
  };
}
