import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

// Lu à chaque appel, et non recopié au chargement : réglable dans l'application (DECISIONS.md §48).
const cfg = config.sonarr;
// Un accesseur : lu par `fetch` à chaque requête, il suit un réglage changé dans l'application.
const headers = {
  get "X-Api-Key"() {
    return cfg.apiKey;
  },
  "Content-Type": "application/json",
};

export interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
  statistics?: { episodeFileCount: number; episodeCount: number };
}

export interface SonarrSeries {
  id: number;
  title: string;
  alternateTitles?: { title: string; sceneSeasonNumber?: number; seasonNumber?: number }[];
  year: number;
  overview?: string;
  monitored: boolean;
  status: string;
  images: { coverType: string; remoteUrl?: string; url?: string }[];
  remotePoster?: string;
  qualityProfileId: number;
  seasonCount: number;
  /** Le dossier de la série, tel que Sonarr le voit — rapproché de Jellyfin par son nom (`folderKey`). */
  path?: string;
  seasons?: SonarrSeason[];
  statistics?: { episodeFileCount: number; episodeCount: number; sizeOnDisk: number };
  /** La durée d'un épisode selon Sonarr, en minutes — 0 quand il ne la connaît pas. */
  runtime?: number;
  tvdbId: number;
  tmdbId?: number;
  imdbId?: string;
  added?: string;
  genres?: string[];
}

export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate?: string;
  airDateUtc?: string;
  monitored: boolean;
  hasFile: boolean;
  series?: { id: number; title: string; images: { coverType: string; remoteUrl?: string; url?: string }[] };
}

export interface SonarrRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  protocol: string;
  seeders?: number;
  leechers?: number;
  age: number;
  quality: { quality: { name: string } };
  rejected: boolean;
  rejections: string[];
}

export const sonarr = {
  getSystemStatus: () => fetchJson<{ version: string }>(`${cfg.url}/api/v3/system/status`, { headers }),
  getSeries: () => fetchJson<SonarrSeries[]>(`${cfg.url}/api/v3/series`, { headers }),
  getSeriesById: (id: number) => fetchJson<SonarrSeries>(`${cfg.url}/api/v3/series/${id}`, { headers }),
  updateSeries: (id: number, payload: Record<string, unknown>) =>
    fetchJson<SonarrSeries>(`${cfg.url}/api/v3/series/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    }),
  getEpisodes: (seriesId: number) =>
    fetchJson<SonarrEpisode[]>(`${cfg.url}/api/v3/episode?seriesId=${seriesId}`, { headers }),
  updateEpisode: (id: number, payload: Record<string, unknown>) =>
    fetchJson<SonarrEpisode>(`${cfg.url}/api/v3/episode/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    }),
  getQueue: () =>
    fetchJson<{ records: any[]; totalRecords: number }>(
      `${cfg.url}/api/v3/queue?pageSize=50&includeSeries=true`,
      { headers }
    ),
  /**
   * La file d'une seule série, entière. `getQueue` n'en lit que la première page (50) : le
   * 06/10/2026, les 263 épisodes d'une série remplissaient cette page, et l'annulation d'une autre
   * série, alors en plein téléchargement, l'a crue inactive et l'a retirée de Sonarr.
   */
  getQueueForSeries: (seriesId: number) =>
    fetchJson<{ seriesId?: number }[]>(`${cfg.url}/api/v3/queue/details?seriesId=${seriesId}`, { headers }),
  getQueueCount: () =>
    fetchJson<{ totalRecords: number }>(`${cfg.url}/api/v3/queue?pageSize=1`, { headers }).then(
      (r) => r.totalRecords
    ),
  getMissingCount: () =>
    fetchJson<{ totalRecords: number }>(`${cfg.url}/api/v3/wanted/missing?page=1&pageSize=1`, {
      headers,
    }).then((r) => r.totalRecords),
  lookupSeries: (term: string) =>
    fetchJson<any[]>(`${cfg.url}/api/v3/series/lookup?term=${encodeURIComponent(term)}`, { headers }),
  getQualityProfiles: () => fetchJson<any[]>(`${cfg.url}/api/v3/qualityprofile`, { headers }),
  getRootFolders: () => fetchJson<any[]>(`${cfg.url}/api/v3/rootfolder`, { headers }),
  addSeries: (payload: Record<string, unknown>) =>
    fetchJson<SonarrSeries>(`${cfg.url}/api/v3/series`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
  deleteSeries: (id: number) =>
    fetchJson<void>(`${cfg.url}/api/v3/series/${id}?deleteFiles=false`, { method: "DELETE", headers }),
  getHistory: (pageSize = 20) =>
    fetchJson<{ records: any[] }>(
      `${cfg.url}/api/v3/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending&includeSeries=true&includeEpisode=true`,
      { headers }
    ),
  getSeriesHistory: (seriesId: number) =>
    fetchJson<any[]>(
      `${cfg.url}/api/v3/history/series?seriesId=${seriesId}&includeSeries=true&includeEpisode=true`,
      { headers }
    ),
  // Encodées : les bornes viennent telles quelles de la requête du navigateur, et un `&` y
  // ajoutait n'importe quel paramètre à un appel fait avec la clé d'API (26/09/2026).
  getCalendar: (start: string, end: string) =>
    fetchJson<SonarrEpisode[]>(
      `${cfg.url}/api/v3/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&unmonitored=true&includeSeries=true`,
      { headers }
    ),
  searchReleases: (params: { seriesId?: number; episodeId?: number; seasonNumber?: number }) => {
    const query = new URLSearchParams();
    if (params.episodeId) query.set("episodeId", String(params.episodeId));
    else if (params.seriesId && params.seasonNumber !== undefined) {
      query.set("seriesId", String(params.seriesId));
      query.set("seasonNumber", String(params.seasonNumber));
    } else if (params.seriesId) query.set("seriesId", String(params.seriesId));
    return fetchJson<SonarrRelease[]>(`${cfg.url}/api/v3/release?${query.toString()}`, { headers }, 60000);
  },
  grabRelease: (guid: string, indexerId: number) =>
    fetchJson<void>(`${cfg.url}/api/v3/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ guid, indexerId }),
    }),
  // Standard automatic search — Sonarr's own normal search+grab pipeline (quality profile rules,
  // best-match auto-pick), no manual release list involved. Distinct from the interactive one
  // above (grabRelease), which requires a human to pick a specific release themselves.
  // La même recherche automatique, mais sur un épisode précis. C'est la commande que Sonarr
  // déclenche lui-même quand on clique sur la loupe d'une ligne d'épisode dans son interface.
  triggerEpisodeSearch: (episodeIds: number[]) =>
    fetchJson<void>(`${cfg.url}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "EpisodeSearch", episodeIds }),
    }),

  triggerSearch: (seriesId: number, seasonNumber?: number) =>
    fetchJson<void>(`${cfg.url}/api/v3/command`, {
      method: "POST",
      headers,
      body: seasonNumber != null
        ? JSON.stringify({ name: "SeasonSearch", seriesId, seasonNumber })
        : JSON.stringify({ name: "SeriesSearch", seriesId }),
    }),
};
