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
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    const res = await fetch(url, { ...init, signal, cache: "no-store" });
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
