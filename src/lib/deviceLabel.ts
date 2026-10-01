/**
 * Ce qu'on retient de l'appareil qui ouvre une session : « iPhone · Safari », pas plus.
 *
 * La liste des appareils connectés ne disait que des dates — « Ouverte le 22 sept., vue le 22
 * sept. » trois fois — et ne permettait pas de savoir lequel on s'apprêtait à déconnecter
 * (23/09/2026). La signature complète du navigateur n'est pas gardée : l'écran n'a besoin que de
 * ce libellé, et c'est donc tout ce qu'on écrit.
 *
 * Un iPad récent (iPadOS 13 et après) se déclare « Macintosh » : sa signature seule ne le
 * distingue pas d'un Mac, et un iPad s'est longtemps inscrit ici comme « Mac · Safari ». Le
 * navigateur, lui, le sait — un Mac n'a pas d'écran tactile, et `navigator.maxTouchPoints` y vaut
 * 0 — et le dit par l'indice `touch` (voir `TOUCH_HINT_HEADER`). Sans cet indice, un iPad reste un
 * Mac, comme avant.
 */
export function deviceLabel(userAgent: string | null | undefined, hints: { touch?: boolean } = {}): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const named = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const device = named === "Mac" && hints.touch === true ? "iPad" : named;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const label = [device, browser].filter(Boolean).join(" · ");
  return label || null;
}

/**
 * L'en-tête par lequel le navigateur dit s'il a un écran tactile — seulement pour distinguer
 * l'iPad du Mac, que la signature confond.
 *
 * Un en-tête explicite plutôt qu'un cookie posé au chargement : seuls deux appelants en ont
 * besoin (la connexion, et les rapports de lecture qui nomment l'appareil chez Jellyfin), un
 * cookie aurait voyagé avec chaque requête du site, et il aurait fallu qu'il soit posé avant le
 * premier envoi du formulaire de connexion — une course de plus. Les rapports de lecture partent
 * tous par `fetch` (`usePlaybackSession`, `keepalive` compris), jamais par `sendBeacon`, qui ne
 * sait pas poser d'en-tête.
 *
 * Il vient du client : on n'en accepte que « 1 » ou « 0 » (`readTouchHint`), jamais un texte qui
 * finirait dans un journal ou dans l'en-tête envoyé à Jellyfin.
 */
export const TOUCH_HINT_HEADER = "x-cine-touch";

/** Côté navigateur : l'indice à joindre à une requête. Vide hors navigateur. */
export function touchHintHeaders(): Record<string, string> {
  if (typeof navigator === "undefined") return {};
  // `> 1` et non `> 0` : c'est le test qu'utilisent les bibliothèques de détection pour l'iPad, et
  // un Mac ne rapporte jamais plus de 0.
  return { [TOUCH_HINT_HEADER]: navigator.maxTouchPoints > 1 ? "1" : "0" };
}

/**
 * Côté navigateur : un iPad qui se dit Mac — la seule signature que l'indice corrige.
 *
 * Pour les lignes du journal du lecteur, qui portent la signature (`agent`) et dont l'activité tire
 * le nom de l'appareil : l'iPad de Lucas y figurait en « Mac · Safari » (30/09/2026). Seulement
 * pour cette signature-là, pour ne pas ajouter un champ à chaque ligne d'un téléphone.
 */
export function isIPadPosingAsMac(): boolean {
  return typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/** Côté serveur : l'indice tel qu'on l'accepte — « 1 » ou « 0 », tout le reste ignoré. */
export function readTouchHint(value: string | null | undefined): boolean | undefined {
  return value === "1" ? true : value === "0" ? false : undefined;
}

/** Le libellé de l'appareil qui envoie cette requête, indice tactile compris. */
export function requestDeviceLabel(req: { headers: { get(name: string): string | null } }): string | null {
  return deviceLabel(req.headers.get("user-agent"), { touch: readTouchHint(req.headers.get(TOUCH_HINT_HEADER)) });
}

/**
 * Le nom sous lequel on s'annonce à Jellyfin (champ `Device` de l'en-tête MediaBrowser) : le
 * libellé de l'appareil, et « Navigateur » quand la signature ne permet pas d'en déduire un.
 *
 * La connexion s'annonçait « Server » et la lecture « Navigateur » : le tableau de bord de
 * Jellyfin montrait tous les comptes sur le même appareil anonyme, et comme Jellyfin renomme
 * l'appareil d'un jeton chaque fois qu'une requête l'annonce autrement, le nom basculait de l'un à
 * l'autre au premier film (29/09/2026).
 */
export function jellyfinDeviceName(label: string | null): string {
  return label ?? "Navigateur";
}
