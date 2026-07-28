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
      const res = await fetch(url, { ...init, signal, cache: "no-store" });
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
