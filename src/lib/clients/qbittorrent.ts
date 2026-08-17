import { config } from "@/lib/config";
import { HttpError } from "@/lib/http";

const { url, username, password } = config.qbittorrent;

// qBittorrent (>=4.1) rejects requests whose Referer/Origin doesn't match its own
// Host, as a CSRF protection — without these headers, login fails with 403 even
// when username/password are correct.
const originHeaders = { Referer: url, Origin: url };

// qBittorrent >=5.2 names its session cookie "QBT_SID_<port>" and returns 204
// with an empty body on successful login; older versions return 200 "Ok." and
// name the cookie plain "SID". Handle both.
function extractSessionCookie(res: Response): string | null {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const rawCookies = getSetCookie ? getSetCookie.call(res.headers) : [res.headers.get("set-cookie") ?? ""];
  for (const raw of rawCookies) {
    const match = raw.match(/^\s*((?:QBT_)?SID(?:_\d+)?)=([^;]+)/);
    if (match) return `${match[1]}=${match[2]}`;
  }
  return null;
}

async function login(): Promise<string> {
  const res = await fetch(`${url}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...originHeaders },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    cache: "no-store",
  });

  if (res.status === 403) {
    throw new HttpError(
      "qBittorrent a refusé la connexion (403) : IP probablement bannie après plusieurs échecs, ou Host header validation à désactiver dans Réglages > WebUI.",
      403
    );
  }

  const cookie = extractSessionCookie(res);
  if (cookie) return cookie;

  // No cookie: either old version with "Fails." body, or unexpected error.
  const body = await res.text().catch(() => "");
  if (!res.ok && res.status !== 204) {
    throw new HttpError(`qBittorrent login failed: ${res.status} ${body.slice(0, 150)}`, res.status);
  }
  throw new HttpError(
    `qBittorrent login refusé : identifiants incorrects${body.trim() ? ` (réponse: "${body.trim()}")` : ""}`,
    401
  );
}

// Re-logging in on every request added a full network round-trip to qBittorrent
// for each call (and doubled/tripled on pages issuing several requests per poll).
// Cache the session cookie in module scope and only refresh it when it actually
// expires (401/403) or after a generous TTL.
let cachedCookie: string | null = null;
let cachedAt = 0;
const SESSION_TTL_MS = 10 * 60 * 1000;

async function getCookie(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedCookie && Date.now() - cachedAt < SESSION_TTL_MS) {
    return cachedCookie;
  }
  const cookie = await login();
  cachedCookie = cookie;
  cachedAt = Date.now();
  return cookie;
}

async function request<T>(path: string, init: RequestInit = {}, _retried = false): Promise<T> {
  const cookie = await getCookie();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { ...init.headers, ...originHeaders, Cookie: cookie },
    cache: "no-store",
  });
  if ((res.status === 401 || res.status === 403) && !_retried) {
    cachedCookie = null;
    return request(path, init, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`, res.status);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export interface QbTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  size: number;
  eta: number;
  category: string;
  ratio: number;
  added_on: number;
  uploaded: number;
  downloaded: number;
  content_path: string;
  num_seeds: number;
  num_leechs: number;
}

export const qbittorrent = {
  getTorrents: () => request<QbTorrent[]>("/api/v2/torrents/info"),
  getTransferInfo: () => request<{
    dl_info_speed: number;
    up_info_speed: number;
    dl_info_data: number;
    up_info_data: number;
    alltime_dl: number;
    alltime_ul: number;
  }>("/api/v2/transfer/info"),
  pause: (hashes: string[]) =>
    request<void>("/api/v2/torrents/pause", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `hashes=${hashes.join("|")}`,
    }),
  resume: (hashes: string[]) =>
    request<void>("/api/v2/torrents/resume", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `hashes=${hashes.join("|")}`,
    }),
  remove: (hashes: string[], deleteFiles: boolean) =>
    request<void>("/api/v2/torrents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `hashes=${hashes.join("|")}&deleteFiles=${deleteFiles}`,
    }),
};
