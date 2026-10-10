/**
 * L'interface au repos : personne ne touche l'écran, ne fait défiler, ni ne navigue depuis un instant.
 *
 * Le travail d'arrière-plan qui tient le fil principal — l'enregistrement des ouvertures sur l'appareil
 * (`resumeCache`), qui lit l'en-tête et l'index d'un fichier Matroska en JavaScript, 100 à 270 ms
 * d'un tenant sur un téléphone ralenti — partait « au repos » au sens de `requestIdleCallback`, qui ne
 * sait rien d'un geste : un appui sur une affiche tombait en plein milieu, et l'animation d'ouverture
 * de la fiche démarrait derrière. Mesuré le 10/10/2026 (Chromium, iPhone 13, processeur ×4) : la plus
 * longue tâche pendant une ouverture du Top 10 était cette lecture, pas la fiche. Ce module dit quand
 * l'interface a été laissée tranquille assez longtemps pour qu'on puisse s'en servir.
 */

/** Sans geste depuis tout ce temps, l'interface est au repos. Couvre une ouverture ou une fermeture de fiche. */
export const UI_QUIET_MS = 1500;

let lastActivity = Number.NEGATIVE_INFINITY;
let installed = false;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function note(): void {
  lastActivity = now();
}

/** Écoute les gestes une fois, en capture : un défilement de rangée ne remonte pas jusqu'à la page autrement. */
export function watchUiActivity(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const options = { capture: true, passive: true } as const;
  for (const type of ["pointerdown", "pointerup", "touchstart", "keydown", "wheel", "popstate", "hashchange"]) {
    window.addEventListener(type, note, options);
  }
  document.addEventListener("scroll", note, options);
}

/** Une animation que rien ne doit gêner, pendant `ms` à partir de maintenant. */
export function noteUiMotion(ms: number): void {
  lastActivity = Math.max(lastActivity, now() + ms - UI_QUIET_MS);
}

export function uiBusy(): boolean {
  watchUiActivity();
  return now() - lastActivity < UI_QUIET_MS;
}

/**
 * Attend que l'interface soit au repos. Résolu aussitôt si elle l'est déjà, ou si `signal` est annulé
 * (l'appelant vérifie lui-même s'il doit s'arrêter).
 */
export function whenUiQuiet(signal?: AbortSignal): Promise<void> {
  watchUiActivity();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (signal?.aborted) return done();
      const wait = UI_QUIET_MS - (now() - lastActivity);
      if (wait <= 0) return done();
      timer = setTimeout(check, wait + 20);
    };
    // Une annulation n'attend pas la prochaine vérification : l'appelant s'arrête aussitôt.
    signal?.addEventListener("abort", done, { once: true });
    check();
  });
}

/** Pour les tests. */
export const uiQuietForTests = {
  reset(): void {
    lastActivity = Number.NEGATIVE_INFINITY;
  },
  touch: note,
};
