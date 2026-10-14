/**
 * Ce que le lecteur serveur doit savoir de la récupération d'hls.js 1.7 — DECISIONS.md §67.
 *
 * Deux faits lus dans les sources d'hls.js 1.7.3, qui changent ce que nos écouteurs d'erreur doivent
 * faire après la montée depuis 1.5.17 (14/10/2026) :
 *
 * 1. **hls.js récupère parfois lui-même, avant nous.** L'erreur `MEDIA_SOURCE_REQUIRES_RESET` (nouvelle
 *    en 1.7 : un ajout refusé alors que la MediaSource est fermée ou que l'élément porte déjà une
 *    erreur, ou un `sourceclose` en pleine lecture) reçoit le drapeau `ResetMediaSource`, et
 *    `ErrorController.onErrorOut` appelle alors `recoverMediaError()` — puis, si aucune variante SDR
 *    ne peut prendre le relais (un seul niveau HDR, ou aucun niveau), la déclare fatale et appelle
 *    `stopLoad()`. Nos écouteurs, posés après la construction, passent après le sien : ils voyaient
 *    une erreur média fatale et rappelaient `recoverMediaError()` — un second détachement de la même
 *    MediaSource neuve, et deux tentatives de notre budget de trois pour un seul incident.
 *
 * 2. **Une récupération après une erreur fatale ne recharge rien d'elle-même — ou repart du point de
 *    départ.** `recoverMediaError()` ne relance le chargement que si hls.js chargeait encore ; après une
 *    fatale, `stopLoad()` est déjà passé. C'est alors le rattachement (`onMediaAttached`) qui relance,
 *    à `config.startPosition` : la position de reprise d'origine quand la séance est partie d'un
 *    préchauffage (§78, `startPosition: resumeAt`) — le spectateur revenait au point d'ouverture.
 *    Le défaut existait déjà en 1.5.17 (même `onMediaAttached`), il ne se voyait que sur une séance
 *    préchauffée. D'où un `startLoad(position)` explicite, comme hls.js le fait dans sa propre
 *    récupération quand il charge encore.
 */

/**
 * `ErrorActionFlags.ResetMediaSource` d'hls.js 1.7. Le type est exporté en `const enum`, que
 * `isolatedModules` interdit de lire : la valeur est recopiée ici, et `hls-contrat.test.ts` la compare
 * à celle que la bibliothèque exporte vraiment — une montée qui la changerait fait échouer le test.
 */
export const HLS_RESET_MEDIA_SOURCE_FLAG = 16;

/**
 * hls.js a-t-il déjà appelé `recoverMediaError()` pour cette erreur ? La condition même de
 * `onErrorOut` (`errorAction.flags & ResetMediaSource`), lue sur l'objet que tous les écouteurs
 * partagent — le nôtre passe après le sien.
 */
export function hlsResetItself(data: { errorAction?: { flags?: number } | null } | null | undefined): boolean {
  const flags = data?.errorAction?.flags;
  return typeof flags === "number" && (flags & HLS_RESET_MEDIA_SOURCE_FLAG) !== 0;
}

/**
 * La position d'où relancer hls.js après une récupération : l'élément s'il lit encore quelque chose
 * (ses métadonnées sont là — pendant un saut, c'est la cible du saut), sinon celle relevée juste avant
 * le dernier détachement (celui qu'hls.js vient de faire lui-même remet l'élément à zéro), sinon la
 * dernière position connue du lecteur (semée par la position de reprise à l'ouverture). `null` :
 * rien de connu, hls.js garde son propre départ.
 */
export function hlsRecoveryPosition(
  element: { readyState: number; currentTime: number } | null | undefined,
  detachedAt: number | null,
  lastKnown: number | null | undefined
): number | null {
  const live = livePosition(element);
  if (live !== null) return live;
  if (detachedAt !== null && detachedAt > 0) return detachedAt;
  if (typeof lastKnown === "number" && Number.isFinite(lastKnown) && lastKnown > 0) return lastKnown;
  return null;
}

/** La position de l'élément, s'il a de quoi en avoir une (`HAVE_METADATA`) et qu'elle n'est pas le début. */
export function livePosition(element: { readyState: number; currentTime: number } | null | undefined): number | null {
  if (!element || element.readyState < 1) return null;
  const t = element.currentTime;
  return Number.isFinite(t) && t > 0 ? t : null;
}
