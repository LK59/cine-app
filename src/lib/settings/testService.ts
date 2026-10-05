import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import type { TestableGroup } from "./schema";

/**
 * « Tester » un service avec des valeurs (celles en cours de saisie, complétées par les réglages
 * actuels), avant de les enregistrer — l'assistant et la page « Connexions » (DECISIONS.md §48).
 * La même authentification que le client de chaque service. Six secondes au plus.
 */

export interface TestResult {
  ok: boolean;
  /** Ce qui a répondu (« Jellyfin 12.0.1 »), ou pourquoi ça n'a pas marché. */
  detail: string;
}

const TIMEOUT_MS = 6000;
const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
}

function failure(error: unknown): TestResult {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { ok: false, detail: "timeout" };
  }
  return { ok: false, detail: "unreachable" };
}

function status(res: Response): TestResult | null {
  if (res.status === 401 || res.status === 403) return { ok: false, detail: "unauthorized" };
  if (!res.ok) return { ok: false, detail: `http-${res.status}` };
  return null;
}

export async function testService(group: TestableGroup, valueOf: (key: string) => string): Promise<TestResult> {
  try {
    switch (group) {
      case "jellyfin": {
        const res = await get(`${trimSlash(valueOf("JELLYFIN_URL"))}/System/Info`, jellyfinAuthHeaders(valueOf("JELLYFIN_API_KEY")));
        const bad = status(res);
        if (bad) return bad;
        const info = (await res.json()) as { ServerName?: string; Version?: string };
        return { ok: true, detail: `${info.ServerName ?? "Jellyfin"} ${info.Version ?? ""}`.trim() };
      }
      case "tmdb": {
        const res = await get(`https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(valueOf("TMDB_API_KEY"))}`);
        return status(res) ?? { ok: true, detail: "TMDB" };
      }
      case "radarr":
      case "sonarr": {
        const prefix = group === "radarr" ? "RADARR" : "SONARR";
        const res = await get(`${trimSlash(valueOf(`${prefix}_URL`))}/api/v3/system/status`, { "X-Api-Key": valueOf(`${prefix}_API_KEY`) });
        const bad = status(res);
        if (bad) return bad;
        const info = (await res.json()) as { appName?: string; version?: string };
        return { ok: true, detail: `${info.appName ?? group} ${info.version ?? ""}`.trim() };
      }
      case "jellyseerr": {
        const res = await get(`${trimSlash(valueOf("JELLYSEERR_URL"))}/api/v1/settings/main`, { "X-Api-Key": valueOf("JELLYSEERR_API_KEY") });
        return status(res) ?? { ok: true, detail: "Jellyseerr" };
      }
      case "bazarr": {
        const res = await get(`${trimSlash(valueOf("BAZARR_URL"))}/api/system/status`, { "X-API-KEY": valueOf("BAZARR_API_KEY") });
        return status(res) ?? { ok: true, detail: "Bazarr" };
      }
      case "jackett": {
        const res = await get(
          `${trimSlash(valueOf("JACKETT_URL"))}/api/v2.0/indexers/all/results/torznab/api?apikey=${encodeURIComponent(valueOf("JACKETT_API_KEY"))}&t=caps`
        );
        return status(res) ?? { ok: true, detail: "Jackett" };
      }
      case "qbittorrent": {
        const base = trimSlash(valueOf("QBITTORRENT_URL"));
        const res = await fetch(`${base}/api/v2/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: base, Origin: base },
          body: `username=${encodeURIComponent(valueOf("QBITTORRENT_USERNAME"))}&password=${encodeURIComponent(valueOf("QBITTORRENT_PASSWORD"))}`,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const bad = status(res);
        if (bad) return bad;
        const text = (await res.text()).trim();
        return text === "Ok." ? { ok: true, detail: "qBittorrent" } : { ok: false, detail: "unauthorized" };
      }
    }
  } catch (error) {
    return failure(error);
  }
}
