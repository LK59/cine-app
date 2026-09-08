/**
 * Le code que porte une réponse quand l'amont n'a pas répondu du tout.
 *
 * Lisible par machine, à côté du message : le même motif que
 * `jellyfin_reauth_required`, que PlayerHost lit déjà. Un texte se traduit et se réécrit ; un code
 * se compare.
 */
export const UPSTREAM_UNREACHABLE = "upstream_unreachable";

/**
 * L'amont n'a rien répondu — ni un statut, ni un refus : rien.
 *
 * C'est une panne d'une autre nature qu'une erreur HTTP, et les confondre coûte une phrase qui ne
 * veut rien dire. Observé pendant une sauvegarde de Jellyfin : l'appel échouait en cinq secondes
 * sur une résolution de nom, `fetch` levait un `TypeError: fetch failed` tout nu, et c'est ce
 * texte-là — « fetch failed » — que le spectateur recevait. L'interface répondait, le catalogue
 * s'affichait depuis le cache, et lancer un film ne faisait rien de compréhensible.
 *
 * Trois causes, trois phrases : le serveur est absent, la clé est mauvaise, le fichier a disparu.
 * Seule la première passe par ici.
 */
export class UpstreamUnreachableError extends Error {
  readonly code = UPSTREAM_UNREACHABLE;
  /** Ce que la couche réseau a dit — `EAI_AGAIN`, `ECONNREFUSED`, un délai dépassé. */
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "UpstreamUnreachableError";
    this.detail = detail;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
  externalSignal?: AbortSignal,
  retries = 2
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    try {
      const res = await fetchOrExplain(url, { ...init, signal, cache: "no-store" }, controller.signal, externalSignal);
      // Rate limiting (e.g. TMDB under a burst of requests) is transient — a short backoff and
      // retry avoids that request permanently failing (and, upstream, poisoning any cache built
      // on top of it) just because it landed in the same second as hundreds of others.
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new HttpError(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`, res.status);
      }
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `fetch`, mais un échec de transport y devient une panne nommée.
 *
 * Deux abandons se ressemblent et n'ont rien à voir : notre propre délai de garde, qui est une
 * panne, et un appelant qui annule, qui n'en est pas une — celle-là remonte telle quelle.
 *
 * L'adresse n'est jamais citée en entier : certaines portent une clé d'API dans leur requête, et
 * un message d'erreur voyage jusqu'à l'écran et jusqu'au journal. L'hôte suffit à savoir qui n'a
 * pas répondu.
 */
async function fetchOrExplain(
  url: string,
  init: RequestInit,
  ours: AbortSignal,
  external?: AbortSignal
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (external?.aborted) throw err;
    const host = ((): string => {
      try {
        return new URL(url).host;
      } catch {
        return "le service";
      }
    })();
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    const detail = ours.aborted ? "délai dépassé" : cause || (err instanceof Error ? err.message : String(err));
    throw new UpstreamUnreachableError(`${host} ne répond pas (${detail})`, detail);
  }
}
