/**
 * Une image que le navigateur a déjà s'affiche sans refaire son fondu d'arrivée.
 *
 * Le fondu dit « cette image vient d'arriver ». Il se rejouait à chaque remontage d'une image que
 * le navigateur avait déjà — chaque retour sur une page, chaque rangée revenue à l'écran —, une
 * demi-seconde de gris pour une image disponible (23/09/2026). Une image que le navigateur a déjà
 * est `complete` dès son insertion : elle s'affiche sans transition.
 *
 * À passer comme `ref`, tel quel : une fonction de module, donc stable, que React n'appelle qu'au
 * montage — un rendu du parent pendant un vrai fondu ne vient pas le couper. Elle note aussi
 * l'instant du montage, que `revealLoaded` relit : voir plus bas.
 */
export function showIfAlreadyLoaded(img: HTMLImageElement | null): void {
  if (!img) return;
  img.dataset.mountedAt = String(now());
  if (img.complete && img.naturalWidth > 0) {
    img.style.transition = "none";
    img.style.opacity = "1";
  }
}

/**
 * En dessous, l'image n'est pas « arrivée » : elle était là.
 *
 * `complete` au montage ne couvrait qu'une partie des images prêtes. Une affiche en cache HTTP, ou
 * chauffée d'avance par le décodage anticipé des rangées, n'est souvent `complete` qu'un instant
 * après son insertion — le temps de la relire et de la décoder — et passait donc par le fondu de
 * 500 ms comme une vraie arrivée réseau. C'est ce qui faisait dire, le 25/09/2026, que « l'app
 * doit aller chercher les images » et que les affiches « se génèrent au fur et à mesure » : elles
 * étaient là, mais chacune s'annonçait en fondu, l'une après l'autre.
 *
 * 100 ms : bien au-dessus de ce que coûte une relecture en cache et un décodage d'affiche (quelques
 * dizaines de millisecondes sur un iPhone), bien en dessous d'un aller-retour réel vers le serveur
 * depuis un téléphone — et c'est l'ordre de grandeur sous lequel un changement ne se perçoit pas
 * comme une arrivée. Une image plus lente que ça est une vraie arrivée : elle garde son fondu.
 */
export const FAST_REVEAL_MS = 100;

/**
 * Les adresses que le décodage anticipé a déjà chauffées (`useDecodeAhead`). Bornées : ce n'est
 * qu'un indice, et un indice perdu ne coûte qu'un fondu.
 */
const warmed = new Set<string>();
const WARMED_LIMIT = 400;

export function noteWarmed(url: string): void {
  if (!url) return;
  warmed.delete(url);
  warmed.add(url);
  if (warmed.size > WARMED_LIMIT) warmed.delete(warmed.values().next().value!);
}

export function wasWarmed(url: string): boolean {
  return warmed.has(url);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Combien de temps le navigateur a mis à obtenir cette image, s'il l'a noté.
 *
 * La durée seule, et pas `transferSize` : pour une image d'un autre site (TMDB, sur le téléphone),
 * les détails sont masqués sans en-tête d'autorisation, mais la durée reste lisible. Absente quand
 * le navigateur n'a rien noté — souvent le cas d'une image servie depuis sa mémoire.
 */
function fetchDuration(url: string): number | null {
  try {
    const entries = performance.getEntriesByName(url);
    const last = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
    return last ? last.duration : null;
  } catch {
    return null;
  }
}

/**
 * Une image qui vient de finir de charger : prête d'emblée, ou vraiment arrivée ?
 *
 * Prête si le décodage anticipé l'a chauffée, si le navigateur l'a obtenue en moins de
 * `FAST_REVEAL_MS`, ou — faute de mesure — si elle a fini de charger moins de `FAST_REVEAL_MS`
 * après son montage. Une image paresseuse, qui ne commence à charger qu'en approchant de l'écran,
 * est jugée sur la durée de son chargement, pas sur le temps écoulé depuis son montage.
 */
export function arrivedReady(img: HTMLImageElement): boolean {
  const url = img.currentSrc || img.src;
  if (url && wasWarmed(url)) return true;
  const duration = url ? fetchDuration(url) : null;
  if (duration !== null) return duration < FAST_REVEAL_MS;
  const mountedAt = Number(img.dataset.mountedAt);
  return Number.isFinite(mountedAt) && now() - mountedAt < FAST_REVEAL_MS;
}

/** À appeler depuis `onLoad` : l'image apparaît, en fondu seulement si elle vient d'arriver. */
/**
 * Une image déjà prête s'affiche sans fondu ; seule une vraie arrivée réseau en garde un.
 *
 * Essayé le 25/09/2026 : un fondu de 180 ms sur les affiches prêtes donnait l'impression d'une
 * attente (« un effet plus lent encore »). Le mouvement est porté par la carte, qui monte à sa
 * place en entrant dans l'écran — voir `riseIn.ts`.
 */
export const READY_REVEAL = "none";

export function revealLoaded(img: HTMLImageElement): void {
  if (arrivedReady(img)) img.style.transition = READY_REVEAL;
  img.style.opacity = "1";
}
