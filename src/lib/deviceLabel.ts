/**
 * Ce qu'on retient de l'appareil qui ouvre une session : « iPhone · Safari », pas plus.
 *
 * La liste des appareils connectés ne disait que des dates — « Ouverte le 22 sept., vue le 22
 * sept. » trois fois — et ne permettait pas de savoir lequel on s'apprêtait à déconnecter
 * (23/09/2026). La signature complète du navigateur n'est pas gardée : l'écran n'a besoin que de
 * ce libellé, et c'est donc tout ce qu'on écrit.
 *
 * Un iPad récent se déclare « Macintosh » : côté serveur, rien ne permet de le distinguer d'un
 * Mac. Il apparaîtra comme tel.
 */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const device = /iPhone/.test(ua)
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
