/**
 * Ce navigateur peut-il lancer une diffusion Chromecast depuis une page web ? — DECISIONS.md §64.
 *
 * Le kit de Google (« Web Sender ») ne fonctionne que dans Chrome et Edge, sur ordinateur et sur
 * Android : il s'appuie sur leur routeur de médias intégré. Partout ailleurs il se charge, attend, et
 * ne trouve jamais rien — un téléchargement pour rien et un bouton qui ne viendrait pas.
 *
 *   - **Jamais sur iPhone ni iPad**, quel que soit le navigateur : tous sont WebKit, et Google ne
 *     fournit pas Cast aux pages web sur iOS (CriOS, EdgiOS compris).
 *   - **Ni Safari, ni Firefox.**
 *   - **Ni Silk** (Fire TV) : il se dit « like Chrome », mais c'est un téléviseur, pas un émetteur.
 *   - **Ni une vue web Android** (`; wv)`), ni les dérivés de Chromium sans routeur de médias
 *     (Samsung Internet, Opera, Yandex).
 *
 * Une question sur l'agent plutôt qu'une sonde, exception assumée à « demander au navigateur » :
 * la seule sonde est le kit lui-même — 100 Ko chargés depuis Google pour s'entendre dire non.
 */
export function chromecastSenderEligible(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  if (!/\b(Chrome|Edg)\//.test(ua)) return false;
  if (/iPhone|iPad|iPod|CriOS|EdgiOS|FxiOS/.test(ua)) return false;
  if (/\bSilk\/|SamsungBrowser\/|\bOPR\/|YaBrowser\/|; wv\)/.test(ua)) return false;
  return true;
}
