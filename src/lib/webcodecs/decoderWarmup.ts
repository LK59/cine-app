"use client";

// Le préchauffage des décodeurs du lecteur — un module à part, et atteint seulement derrière une
// frontière `ssr: false` (`DecoderWarmup`, `PlayerOnboarding`).
//
// Il vivait dans cinemaWarmup.ts ; le 21/09/2026, y ajouter libFLAC a cassé le build de
// production : `PlayerShell` est aussi rendu côté serveur, donc tout ce qu'il importe — imports
// dynamiques compris — est empaqueté pour Node, et la variante Node du worker de
// @wasm-audio-decoders n'est pas empaquetable. Les vérifications (typecheck, lint, tests) ne
// construisent pas l'application et n'ont rien vu. Ici, rien de ce module n'entre dans le graphe
// du serveur.

/**
 * Les décodeurs du lecteur, avant le premier film : mediabunny et ses extensions AC-3 et DTS,
 * libFLAC et le TrueHD de FFmpeg depuis le 21/09/2026 — ~900 Ko compressés, que le premier « Lire » d'un fichier au
 * son exotique téléchargeait sinon, pendant que le spectateur attendait.
 *
 * Tous les trois, sur tous les appareils, même l'iPhone qui lit l'AC-3 tel quel : un fichier qui
 * mêle DTS et AC-3 fait tout ré-encoder (Warrior, 20/09/2026, « E-AC3 → AC3, décodé puis
 * ré-encodé » sur iPhone), et c'est alors le décodeur AC-3 qui sert.
 *
 * Chaque module embarque son worker et son WebAssembly dans un seul fichier : l'importer suffit à
 * tout télécharger, et le service worker le garde (voir `STATIC_PREFIX` dans sw.js). Leur nom ne
 * change qu'avec leur contenu, donc une fois suffit, et un déploiement qui n'y touche pas ne coûte
 * rien. Pas en mode économie de données. Un échec ne coûte rien — le lecteur les chargera lui-même.
 */
export function warmPlayerDecoders(): void {
  try {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;
    void import("mediabunny").catch(() => {});
    void import("@mediabunny/ac3").catch(() => {});
    void import("@mediabunny/dts").catch(() => {});
    void import("@/lib/webcodecs/flacDecoder").catch(() => {});
    void import("@wasm-audio-decoders/flac").catch(() => {});
    // Le module TrueHD, téléchargé et non instancié : le premier film en TrueHD le trouve en cache.
    void import("@/lib/webcodecs/truehd/truehdDecoder").then((m) => m.warmTrueHd()).catch(() => {});
  } catch {
    // Un préchauffage n'a jamais le droit de devenir une panne.
  }
}

/**
 * Le même préchauffage, différé jusqu'à ce que le navigateur soit libre.
 *
 * Deux appelants, un seul geste : le démarrage de l'application (`PlayerShell`), pour les comptes
 * qui ne verront jamais l'écran d'accueil et pour le premier lancement après un déploiement qui
 * a changé un décodeur ; et l'écran d'accueil lui-même, plus tôt, puisqu'on y attend de toute
 * façon. Jamais avant `delayMs` : le catalogue et les affiches du premier écran passent d'abord.
 */
export function scheduleDecoderWarmup(delayMs: number): () => void {
  let idle: number | undefined;
  const timer = setTimeout(() => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) idle = ric(warmPlayerDecoders, { timeout: 5000 });
    else warmPlayerDecoders();
  }, delayMs);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined) (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idle);
  };
}
