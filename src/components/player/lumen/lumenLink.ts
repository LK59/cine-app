/**
 * Le débit de la connexion vu par Lumen serveur, et la règle qui en dépend : annoncer à Safari le quart du débit du
 * film (`?bw=bas`, `trials.ts`) seulement quand la connexion le permet (17/11/2026).
 *
 * Pourquoi. Après un saut, Safari ne relance l'image qu'avec ~12 s d'avance (0,9 à 4 s d'attente, contre 0,7 s au
 * lecteur actuel). Le banc « Attente de Safari » du 17/11 : le débit annoncé au quart fait partir la lecture avec 3 à 7 s
 * d'avance — l'attente image → lecture de *Ghosted* passe de 4,1 s à 1,2 s, celle de *Ted Lasso* de 2,2 s à 1,0 s.
 * Mais la prudence de Safari protège une connexion juste : là, il faut la lui laisser — et une future version allégée
 * (plusieurs débits dans la liste) a besoin de débits annoncés honnêtes pour que Safari choisisse la bonne. D'où la
 * règle : le quart seulement si la connexion mesurée dépasse nettement le débit moyen du film.
 *
 * La mesure : les segments que Safari tire de toute façon (Resource Timing), aucun octet de plus. Octets reçus sur la
 * durée de la requête entière — attente du premier octet comprise, et deux pistes qui se partagent le lien —, donc
 * une mesure prudente. Gardée sur l'appareil dix minutes : le choix se fait à l'ouverture, avant le premier segment de
 * la lecture, et une mesure plus vieille peut venir d'une autre connexion (le Wi-Fi de la maison, puis la 5G).
 */

export const LUMEN_LINK_KEY = "cine:lumen-debit";
/** Au-delà, la mesure peut venir d'une autre connexion : elle ne décide plus rien. */
export const LINK_FRESH_MS = 10 * 60_000;
/** Le quart seulement si la connexion mesurée vaut au moins tant de fois le débit moyen du film. */
export const LOW_BANDWIDTH_LINK_RATIO = 1.5;
/** Les segments plus petits ne disent rien du lien (le premier octet y pèse plus que le transfert). */
export const LINK_MIN_BYTES = 256 * 1024;
/** Les derniers segments retenus pour la médiane. */
export const LINK_SAMPLES = 8;

export interface LinkSample {
  name: string;
  startTime: number;
  responseEnd: number;
  transferSize: number;
}

/** Le débit médian (Mb/s) des derniers gros segments de cette lecture, ou null s'il n'y en a pas assez (3). */
export function linkMbpsOf(lumenSession: string, entries: readonly LinkSample[]): number | null {
  const marker = `/${lumenSession}/`;
  const rates = entries
    .filter((e) => e.name.includes(marker) && /\.m4s(?:$|[?#])/.test(e.name) && e.transferSize >= LINK_MIN_BYTES && e.responseEnd > e.startTime)
    .sort((a, b) => a.responseEnd - b.responseEnd)
    .slice(-LINK_SAMPLES)
    .map((e) => (e.transferSize * 8) / ((e.responseEnd - e.startTime) * 1000));
  if (rates.length < 3) return null;
  rates.sort((a, b) => a - b);
  const mid = rates.length >> 1;
  const median = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  return Math.round(median * 10) / 10;
}

/** Retient la dernière mesure sur l'appareil. Stockage refusé : rien, la règle reste prudente. */
export function rememberLink(mbps: number, now = Date.now()): void {
  if (!Number.isFinite(mbps) || mbps <= 0) return;
  try {
    window.localStorage.setItem(LUMEN_LINK_KEY, JSON.stringify({ mbps, at: now }));
  } catch {
    // Navigation privée, stockage plein.
  }
}

/** La dernière mesure si elle a moins de dix minutes, sinon null. */
export function recentLinkMbps(now = Date.now()): number | null {
  try {
    const raw = window.localStorage.getItem(LUMEN_LINK_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as { mbps?: unknown; at?: unknown };
    if (typeof kept.mbps !== "number" || typeof kept.at !== "number" || !(kept.mbps > 0)) return null;
    return now - kept.at >= 0 && now - kept.at < LINK_FRESH_MS ? kept.mbps : null;
  } catch {
    return null;
  }
}

/** Annoncer le quart ? Seulement avec une mesure récente qui dépasse nettement le débit moyen du film. */
export function announcesLowBandwidth(linkMbps: number | null, averageBps: number | undefined): boolean {
  if (linkMbps === null || !averageBps || averageBps <= 0) return false;
  return linkMbps * 1e6 >= LOW_BANDWIDTH_LINK_RATIO * averageBps;
}

/** L'adresse de la liste maître avec `bw=bas` (le fragment `#t=` éventuel gardé à sa place). */
export function withLowBandwidth(master: string): string {
  const hash = master.indexOf("#");
  const base = hash < 0 ? master : master.slice(0, hash);
  const tail = hash < 0 ? "" : master.slice(hash);
  if (/[?&]bw=/.test(base)) return master;
  return `${base}${base.includes("?") ? "&" : "?"}bw=bas${tail}`;
}
