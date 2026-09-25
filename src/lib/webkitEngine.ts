/**
 * Le moteur du navigateur, quand c'est bien lui qu'on veut savoir.
 *
 * Deux endroits demandaient « ce navigateur lit-il le HLS nativement ? » pour en déduire « est-ce
 * WebKit ? ». Les deux questions ont la même réponse sur un ordinateur, et des réponses opposées
 * sur un téléphone Android : Chrome y répond oui à la première et non à la seconde.
 *
 * Le prix de la confusion, observé : changer de piste audio rechargeait la page entière. C'est un
 * contournement légitime — WebKit refuse d'ouvrir une seconde session HLS dans la même page, et
 * seul un rechargement la libère — mais Chrome Android n'a pas ce défaut, et se retrouvait éjecté
 * de son film vers l'écran d'où il venait, au milieu du chargement.
 *
 * Alors la question est posée telle qu'elle est pensée. C'est un test d'agent utilisateur, ce qui
 * se justifie mal d'ordinaire : ici le comportement à détecter est un défaut d'implémentation, pas
 * une capacité, et aucune capacité ne le trahit — c'est précisément l'erreur qu'on répare.
 */
export function isWebKitEngine(userAgent: string): boolean {
  // Chromium sous Android annonce « AppleWebKit » et « Safari » dans le même agent : les deux
  // mots sont là pour la compatibilité et ne veulent plus rien dire depuis quinze ans.
  if (/Android/i.test(userAgent)) return false;
  // Sur iOS et iPadOS, tout navigateur est WebKit — Chrome et Firefox compris.
  if (/iP(hone|ad|od)/i.test(userAgent)) return true;
  return /Safari/i.test(userAgent) && !/Chrom(e|ium)|Edg\//i.test(userAgent);
}

/** Le même, posé au navigateur courant. Faux hors du navigateur, où rien ne joue. */
export function isWebKit(): boolean {
  return typeof navigator !== "undefined" && isWebKitEngine(navigator.userAgent);
}

/**
 * Ce lecteur donnera-t-il le flux HLS au pipeline du navigateur, plutôt qu'à hls.js ?
 *
 * WebKit seulement, même quand un autre moteur répond oui à `canPlayType` : Chromium 151 le fait
 * désormais sur ordinateur, et Opera sous Windows (25/09/2026) a été envoyé ainsi sur le lecteur
 * HLS intégré de Chromium. Il a refusé la playlist maître quatre fois — aucune variante, aucun
 * segment demandés, aucun ffmpeg lancé — et le film n'a jamais démarré. Pendant ce temps, la sonde
 * des codecs avait interrogé MediaSource, c'est-à-dire hls.js : le profil négocié décrivait un
 * pipeline, la lecture en empruntait un autre.
 *
 * Une seule fonction pour la sonde (`codecSupport.ts`) et pour l'hôte (`PlayerHost.tsx`), pour
 * que les deux ne décrivent plus jamais deux navigateurs différents. Voir DECISIONS.md.
 */
export function playsHlsNatively(video?: HTMLVideoElement | null): boolean {
  if (!isWebKit()) return false;
  const element = video ?? (typeof document !== "undefined" ? document.createElement("video") : null);
  return !!element?.canPlayType("application/vnd.apple.mpegurl");
}
