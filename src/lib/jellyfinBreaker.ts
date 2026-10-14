import { config } from "@/lib/config";
import { UpstreamUnreachableError } from "@/lib/http";

/**
 * Le coupe-circuit de Jellyfin (14/10/2026, DECISIONS.md §92).
 *
 * Un Jellyfin injoignable se payait à chaque appel. Nom introuvable : un échec immédiat, mais
 * répété — la même ligne `ENOTFOUND` en boucle dans `server.log`. Hôte figé : huit secondes
 * (`fetchJson`) par appel, et chaque appel du catalogue, de la recherche (8 s au lieu de 0,3), de
 * `/api/status` ou de l'accueil de la gestion les repayait, l'un après l'autre (test isolé du
 * 14/10/2026).
 *
 * Après un échec **de transport** — pas de réponse du tout, ou délai dépassé —, l'hôte est réputé
 * hors ligne pendant `OPEN_MS` : les appels échouent tout de suite, avec la même erreur nommée
 * (`upstream_unreachable`) que le vrai échec, si bien qu'aucun appelant n'a à changer. Le délai
 * passé, **un** appel passe pour sonder (les autres échouent encore vite) : sa réponse rouvre ou
 * referme. Une réponse HTTP, même un 500, prouve que l'hôte répond : elle referme.
 *
 * **Jamais pour un film en cours.** Les octets d'un film (relais de flux, sous-titres, flux direct)
 * et les rapports de lecture ne sont pas retenus (`passJellyfin`) : un disjoncteur ouvert sur une
 * fausse alerte couperait un film qui marchait. Ils ne font que témoigner — une réponse referme le
 * disjoncteur, et c'est voulu : un film qui reçoit ses octets prouve que Jellyfin est là.
 *
 * Un seul état, dans ce module : l'hôte est celui que règle l'application (§48), et un changement
 * d'adresse remet tout à zéro (une adresse corrigée n'hérite pas de la panne de l'ancienne).
 */

export const OPEN_MS = 30_000;

interface State {
  /** L'adresse dont on parle — un réglage changé repart de zéro. */
  url: string;
  /** Le premier échec de la panne en cours ; `null` quand tout va bien. */
  downSince: number | null;
  /** Jusqu'à quand les appels échouent sans partir. */
  openUntil: number;
  /** Une sonde est partie et n'a pas encore répondu. */
  probing: boolean;
  /** Ce que la couche réseau a dit au dernier échec — repris dans l'erreur rapide. */
  lastDetail: string;
}

/**
 * Sur `globalThis` : un seul état pour tout le processus, même si Next charge ce module dans
 * plusieurs paquets (le proxy, les routes). La suite de tests l'efface avant chaque test
 * (`vitest.setup.ts`) — un test qui simule une panne ne doit pas faire échouer le suivant.
 */
const KEY = "__cineJellyfinBreaker";
type Holder = { [KEY]?: State };

function fresh(url: string): State {
  return { url, downSince: null, openUntil: 0, probing: false, lastDetail: "" };
}

function current(): State {
  const holder = globalThis as Holder;
  const url = config.jellyfin.url;
  let s = holder[KEY];
  if (!s || s.url !== url) {
    s = fresh(url);
    holder[KEY] = s;
  }
  return s;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "jellyfin";
  }
}

/** Pour les tests. */
export function resetJellyfinBreaker(): void {
  delete (globalThis as Holder)[KEY];
}

/** Depuis quand Jellyfin est réputé hors ligne — `null` quand il répond (ou qu'on n'en sait rien de mal). */
export function jellyfinDownSince(): number | null {
  return current().downSince;
}

/** Jellyfin est-il réputé hors ligne en ce moment ? (Sonde comprise : tant qu'elle n'a pas répondu, oui.) */
export function jellyfinIsDown(): boolean {
  return current().downSince !== null;
}

/** Un échec de transport, ou un délai dépassé. Une annulation de l'appelant n'en est pas un. */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof UpstreamUnreachableError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError") return true;
  if (err.name === "AbortError") return false;
  // `fetch` nu : « TypeError: fetch failed », la cause porte le code (ENOTFOUND, ECONNREFUSED…).
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

export function noteJellyfinSuccess(): void {
  const s = current();
  s.downSince = null;
  s.openUntil = 0;
  s.probing = false;
  s.lastDetail = "";
}

export function noteJellyfinFailure(err: unknown, now = Date.now()): void {
  if (!isTransportFailure(err)) return;
  const s = current();
  if (s.downSince === null) s.downSince = now;
  s.openUntil = now + OPEN_MS;
  s.probing = false;
  const detail = err instanceof UpstreamUnreachableError ? err.detail : err instanceof Error ? (((err as { cause?: { code?: string } }).cause?.code) ?? err.message) : String(err);
  s.lastDetail = detail;
}

/**
 * Peut-on appeler ? Lève l'erreur rapide si non. Rend `true` quand cet appel est la sonde (il doit
 * alors rendre compte de son issue — `throughJellyfinBreaker` s'en charge).
 */
export function admitJellyfinCall(now = Date.now()): boolean {
  const s = current();
  if (s.downSince === null) return false;
  if (now < s.openUntil || s.probing) {
    const host = hostOf(s.url);
    throw new UpstreamUnreachableError(
      `${host} ne répond pas (hors ligne depuis ${new Date(s.downSince).toISOString()} — ${s.lastDetail || "injoignable"})`,
      s.lastDetail || "hors ligne",
      host
    );
  }
  s.probing = true;
  return true;
}

/**
 * Un appel à Jellyfin, retenu quand l'hôte est réputé hors ligne. Une réponse (même un refus HTTP)
 * referme ; un échec de transport ouvre pour `OPEN_MS`. Toute autre erreur est rendue telle quelle.
 */
export async function throughJellyfinBreaker<T>(call: () => Promise<T>): Promise<T> {
  const probe = admitJellyfinCall();
  try {
    const value = await call();
    noteJellyfinSuccess();
    return value;
  } catch (err) {
    if (isTransportFailure(err)) noteJellyfinFailure(err);
    else if (isHttpAnswer(err)) noteJellyfinSuccess();
    else if (probe) current().probing = false;
    throw err;
  }
}

/**
 * Un appel qui ne doit jamais être retenu — un film en cours, la sonde de santé — mais dont
 * l'issue renseigne le disjoncteur.
 */
export async function passJellyfin<T>(call: () => Promise<T>): Promise<T> {
  try {
    const value = await call();
    noteJellyfinSuccess();
    return value;
  } catch (err) {
    if (isTransportFailure(err)) noteJellyfinFailure(err);
    else if (isHttpAnswer(err)) noteJellyfinSuccess();
    throw err;
  }
}

/** Une erreur qui porte un statut HTTP : l'hôte a répondu. */
function isHttpAnswer(err: unknown): boolean {
  return typeof (err as { status?: unknown })?.status === "number";
}

/**
 * `fetch` vers Jellyfin, pour les appels qui ne passent pas par le client (une réponse relayée,
 * un statut lu à la main). `mode: "guard"` retient pendant une panne ; `"pass"` ne retient
 * jamais (octets d'un film, rapports de lecture, sonde) et ne fait que témoigner.
 *
 * Une réponse, quel que soit son statut, referme : l'hôte a répondu.
 */
export function jellyfinFetch(input: string, init: RequestInit = {}, mode: "guard" | "pass" = "guard"): Promise<Response> {
  const run = () => fetch(input, init);
  if (mode === "pass") return passJellyfin(run);
  return throughJellyfinBreaker(run);
}

/** `jellyfinFetch(…, "pass")`, nommé : les octets d'un film, qui ne sont jamais retenus. */
export function passJellyfinFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return jellyfinFetch(input, init, "pass");
}
