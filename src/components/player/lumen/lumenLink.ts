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
 *
 * Et la fiche du film mesure elle-même quand l'appareil n'a rien de récent (`probeLink`, 17/11/2026) : sans elle, la
 * première lecture d'une soirée partait toujours aux vrais débits — et la plupart des séances sont une seule lecture,
 * lancée puis regardée jusqu'au bout. Un échantillon de 3 Mo, au plus une fois par dix minutes, après la préparation
 * de la fiche (`lumenSheetPrepare.ts`), par la sonde déjà servie à la page de banc (`chrono?bytes=`).
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

/**
 * La version allégée (`lumenServer/light/`) : en dessous de tant de fois le débit moyen du film, la connexion est
 * faible — la page fait préparer l'échelon adapté d'avance, et une lecture qui s'ouvre sur une connexion qu'on sait
 * faible démarre sur lui (`?lv=`).
 */
export const WEAK_LINK_RATIO = 1.3;
/** Un échelon tient si la connexion vaut au moins tant de fois sa crête annoncée. */
export const RUNG_HEADROOM = 1.2;

export interface LightRungFacts {
  rung: 1 | 2;
  height: number;
  averageBps: number;
  peakBps: number;
}

/**
 * L'échelon adapté à une connexion faible, ou null : pas de mesure, pas d'échelon, ou une connexion qui porte le film.
 * Le meilleur échelon dont la crête passe avec de la marge ; aucun ne passe : le plus léger.
 */
export function lightRungFor(linkMbps: number | null, averageBps: number | undefined, rungs: readonly LightRungFacts[] | undefined): 1 | 2 | null {
  if (linkMbps === null || !averageBps || !rungs?.length) return null;
  const link = linkMbps * 1e6;
  if (link >= WEAK_LINK_RATIO * averageBps) return null;
  const byQuality = [...rungs].sort((a, b) => b.height - a.height);
  return (byQuality.find((r) => link >= RUNG_HEADROOM * r.peakBps) ?? byQuality[byQuality.length - 1]).rung;
}

/** L'adresse de la liste maître avec `lv=N` (cet échelon listé d'abord : Safari démarre sur lui). */
export function withLightFirst(master: string, rung: 1 | 2): string {
  const hash = master.indexOf("#");
  const base = hash < 0 ? master : master.slice(0, hash);
  const tail = hash < 0 ? "" : master.slice(hash);
  if (/[?&]lv=/.test(base)) return master;
  return `${base}${base.includes("?") ? "&" : "?"}lv=${rung}${tail}`;
}

/** L'adresse de la liste maître avec `bw=bas` (le fragment `#t=` éventuel gardé à sa place). */
export function withLowBandwidth(master: string): string {
  const hash = master.indexOf("#");
  const base = hash < 0 ? master : master.slice(0, hash);
  const tail = hash < 0 ? "" : master.slice(hash);
  if (/[?&]bw=/.test(base)) return master;
  return `${base}${base.includes("?") ? "&" : "?"}bw=bas${tail}`;
}

/** La taille de l'échantillon de la fiche : assez pour sortir du démarrage lent de TCP, sans coûter une rafale. */
export const LINK_PROBE_BYTES = 3 * 1024 * 1024;

/**
 * Mesure le lien par un échantillon de `LINK_PROBE_BYTES` octets aléatoires (`GET /api/lumen/{id}/chrono?bytes=`),
 * retient le résultat et le rend (Mb/s), ou null. Rien si une mesure récente existe déjà. Ne lève jamais.
 */
export async function probeLink(itemId: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  if (recentLinkMbps() !== null) return null;
  try {
    const url = `/api/lumen/${itemId}/chrono?s=fiche-sonde&bytes=${LINK_PROBE_BYTES}&t=${Math.round(performance.now())}`;
    const started = performance.now();
    const res = await fetchImpl(url, { cache: "no-store", signal });
    if (!res.ok) return null;
    const head = performance.now();
    const body = await res.arrayBuffer();
    const end = performance.now();
    // Resource Timing quand le navigateur le donne (le transfert seul) ; sinon de la réponse à la fin de la lecture.
    const entry = (performance.getEntriesByType?.("resource") as PerformanceResourceTiming[] | undefined)?.filter((e) => e.name.includes(url)).at(-1);
    const ms = entry && entry.responseEnd > entry.responseStart && entry.responseStart > 0 ? entry.responseEnd - entry.responseStart : end - (head > started ? head : started);
    if (!(ms > 0) || body.byteLength < LINK_MIN_BYTES) return null;
    const mbps = Math.round(((body.byteLength * 8) / (ms * 1000)) * 10) / 10;
    rememberLink(mbps);
    return mbps;
  } catch {
    return null;
  }
}

/**
 * Le débit le plus bas que ce film peut servir (b/s) : son échelon allégé le plus léger, sinon son débit moyen ; null
 * sans rien de connu. En dessous, la connexion est « trop faible » pour lire sans attendre (`LumenServerHost`).
 */
export function lowestServedBps(rungs: readonly { averageBps: number }[] | undefined, filmAverageBps: number | undefined): number | null {
  const candidates = [...(rungs ?? []).map((r) => r.averageBps), ...(filmAverageBps ? [filmAverageBps] : [])].filter((v) => v > 0);
  return candidates.length ? Math.min(...candidates) : null;
}
