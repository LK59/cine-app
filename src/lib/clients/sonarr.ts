import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { url, apiKey } = config.sonarr;
const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

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
  seasons?: SonarrSeason[];
  statistics?: { episodeFileCount: number; episodeCount: number; sizeOnDisk: number };
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
  getSystemStatus: () => fetchJson<{ version: string }>(`${url}/api/v3/system/status`, { headers }),
  getSeries: () => fetchJson<SonarrSeries[]>(`${url}/api/v3/series`, { headers }),
  getSeriesById: (id: number) => fetchJson<SonarrSeries>(`${url}/api/v3/series/${id}`, { headers }),
  updateSeries: (id: number, payload: Record<string, unknown>) =>
    fetchJson<SonarrSeries>(`${url}/api/v3/series/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    }),
  getEpisodes: (seriesId: number) =>
    fetchJson<SonarrEpisode[]>(`${url}/api/v3/episode?seriesId=${seriesId}`, { headers }),
  updateEpisode: (id: number, payload: Record<string, unknown>) =>
    fetchJson<SonarrEpisode>(`${url}/api/v3/episode/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    }),
  getQueue: () =>
    fetchJson<{ records: any[]; totalRecords: number }>(
      `${url}/api/v3/queue?pageSize=50&includeSeries=true`,
      { headers }
    ),
  getQueueCount: () =>
    fetchJson<{ totalRecords: number }>(`${url}/api/v3/queue?pageSize=1`, { headers }).then(
      (r) => r.totalRecords
    ),
  getMissingCount: () =>
    fetchJson<{ totalRecords: number }>(`${url}/api/v3/wanted/missing?page=1&pageSize=1`, {
      headers,
    }).then((r) => r.totalRecords),
  lookupSeries: (term: string) =>
    fetchJson<any[]>(`${url}/api/v3/series/lookup?term=${encodeURIComponent(term)}`, { headers }),
  getQualityProfiles: () => fetchJson<any[]>(`${url}/api/v3/qualityprofile`, { headers }),
  getRootFolders: () => fetchJson<any[]>(`${url}/api/v3/rootfolder`, { headers }),
  addSeries: (payload: Record<string, unknown>) =>
    fetchJson<SonarrSeries>(`${url}/api/v3/series`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
  deleteSeries: (id: number) =>
    fetchJson<void>(`${url}/api/v3/series/${id}?deleteFiles=false`, { method: "DELETE", headers }),
  getHistory: (pageSize = 20) =>
    fetchJson<{ records: any[] }>(
      `${url}/api/v3/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending&includeSeries=true&includeEpisode=true`,
      { headers }
    ),
  getSeriesHistory: (seriesId: number) =>
    fetchJson<any[]>(
      `${url}/api/v3/history/series?seriesId=${seriesId}&includeSeries=true&includeEpisode=true`,
      { headers }
    ),
  getCalendar: (start: string, end: string) =>
    fetchJson<SonarrEpisode[]>(
      `${url}/api/v3/calendar?start=${start}&end=${end}&unmonitored=true&includeSeries=true`,
      { headers }
    ),
  searchReleases: (params: { seriesId?: number; episodeId?: number; seasonNumber?: number }) => {
    const query = new URLSearchParams();
    if (params.episodeId) query.set("episodeId", String(params.episodeId));
    else if (params.seriesId && params.seasonNumber !== undefined) {
      query.set("seriesId", String(params.seriesId));
      query.set("seasonNumber", String(params.seasonNumber));
    } else if (params.seriesId) query.set("seriesId", String(params.seriesId));
    return fetchJson<SonarrRelease[]>(`${url}/api/v3/release?${query.toString()}`, { headers }, 60000);
  },
  grabRelease: (guid: string, indexerId: number) =>
    fetchJson<void>(`${url}/api/v3/release`, {
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
    fetchJson<void>(`${url}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "EpisodeSearch", episodeIds }),
    }),

  triggerSearch: (seriesId: number, seasonNumber?: number) =>
    fetchJson<void>(`${url}/api/v3/command`, {
      method: "POST",
      headers,
      body: seasonNumber != null
        ? JSON.stringify({ name: "SeasonSearch", seriesId, seasonNumber })
        : JSON.stringify({ name: "SeriesSearch", seriesId }),
    }),
};
