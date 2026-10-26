/**
 * Ce que le lecteur serveur fait de l'élément et de la page quand il doit repartir de zéro :
 * couper la session HLS de l'élément, et écrire l'intention qu'une page rechargée relira.
 */
import { PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import type { PlayerReloadIntent, ReloadCarry } from "@/lib/serverReload";

/**
 * Couper l'élément : pause, plus de source, `load()` pour que le navigateur lâche la session HLS.
 * Écrit à l'identique à quatre endroits jusqu'au 22/10/2026 ; chaque appelant garde sa propre garde
 * (`try`) et ce qui suit (rechargement ou non). Peut lever sur un élément déjà démonté.
 */
export function releaseHlsElement(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/**
 * L'adresse du flux pour Safari (HLS natif), avec la position de départ en fragment (`#t=`, Media
 * Fragments) quand la séance reprend au milieu (26/10/2026).
 *
 * Sur Safari, ce n'est pas nous qui demandons les segments : il commençait par le segment 0, Jellyfin
 * lançait ffmpeg au début du film, puis — le saut de reprise posé au `loadeddata` — le relançait à la
 * position (17 reprises sur 20 du 18 au 26/10, image à la reprise en 8,6 s médiane contre 3,9 s pour
 * la première image). hls.js part déjà du bon segment depuis le 15/10 (`warmSegmentAt`). Le fragment
 * ne quitte pas l'appareil (il n'est jamais envoyé au serveur) ; s'il est ignoré, le saut du
 * `loadeddata` reste en place, et c'est l'ouverture d'avant. Jamais pour une diffusion : l'adresse
 * part au téléviseur, qui a sa propre reprise (`castResume`).
 */
export function withStartFragment(url: string, resumeAt: number | undefined): string {
  if (typeof resumeAt !== "number" || !Number.isFinite(resumeAt) || resumeAt <= 0 || url.includes("#")) return url;
  return `${url}#t=${Math.floor(resumeAt * 1000) / 1000}`;
}

/**
 * Écrit l'intention que la page rechargée relira (`PlaybackProvider`). Faux si le stockage la refuse :
 * l'appelant garde alors son chemin d'avant (la lecture dans la page, ou l'écran d'erreur).
 */
export function reloadIntoServerPlayer(intent: PlayerReloadIntent): boolean {
  try {
    sessionStorage.setItem(PLAYER_RELOAD_INTENT_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

/*
 * Les intentions des trois rechargements (23/10/2026, DECISIONS.md §115) : le relais natif → serveur
 * (`directReloadIntent`, `serverReload.ts`), le changement de piste sur WebKit (`audioReloadIntent`) et
 * la fin de l'échelle du son (`ladderReloadIntent`). Chacune garde l'ordre de ses clés d'avant : il
 * est figé par l'empreinte (`storage session set …`).
 */

/**
 * Le changement de piste sur WebKit (`changeAudio`, `PlayerHost.tsx`). `server` : la page rechargée
 * revient au lecteur serveur — voir `reloadedOnServer`. `carry.lighter` : le palier en cours voyage
 * avec la piste, pas par la mémoire des deux minutes (qui pouvait avoir expiré : la séance repartait
 * en pleine qualité, 12/10/2026).
 */
export function audioReloadIntent(input: {
  itemId: string;
  title: string;
  audioStreamIndex: number;
  resumeAt: number;
  carry: ReloadCarry;
}): PlayerReloadIntent {
  const { itemId, title, audioStreamIndex, resumeAt, carry } = input;
  return { itemId, title, audioStreamIndex, resumeAt, server: true, carry };
}

/**
 * La fin de l'échelle du son sur WebKit (`useElementErrorLadder`) : `attempt` borne les rechargements
 * (deux échelles épuisées ne bouclent jamais), la piste seulement si la séance en demandait une.
 */
export function ladderReloadIntent(input: {
  itemId: string;
  title: string;
  resumeAt: number;
  attempt: number;
  audioStreamIndex: number | undefined;
  carry: ReloadCarry;
}): PlayerReloadIntent {
  const { itemId, title, resumeAt, attempt, audioStreamIndex, carry } = input;
  return {
    itemId,
    title,
    resumeAt,
    attempt,
    server: true,
    ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
    carry,
  };
}

/**
 * Recharger la page sur le lecteur serveur depuis une page qui le lit déjà : l'intention écrite,
 * l'élément coupé, la page rechargée — le tout sous une seule garde. Faux si quoi que ce soit lève
 * (stockage refusé, élément démonté) : l'appelant garde son chemin d'avant (le changement en place,
 * ou l'écran d'erreur). Couper l'élément *avant* de recharger, et pas seulement en laissant la page
 * mourir : le démon média d'iOS (mediaserverd) libère les sessions HLS de façon asynchrone et
 * indépendante de la page — un rechargement lancé pendant que l'ancien flux joue encore peut faire
 * monter la nouvelle page avant que l'ancienne session soit partie ; commencer la coupure ici lui
 * donne autant d'avance que possible.
 *
 * `intentOf` est appelée sous la garde, comme l'intention l'était dans le `try` de chaque site.
 * `window.location.reload()` et non `reloadPage()` : c'est ce que ces deux sites ont toujours appelé,
 * et l'empreinte du lecteur serveur simule `reloadPage` (une ligne de plus sinon).
 */
export function reloadServerPage(intentOf: () => PlayerReloadIntent, video: HTMLVideoElement): boolean {
  try {
    if (!reloadIntoServerPlayer(intentOf())) return false;
    releaseHlsElement(video);
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}
