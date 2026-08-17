import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { url, apiKey } = config.radarr;
const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

export interface RadarrMovie {
  id: number;
  title: string;
  originalTitle?: string;
  year: number;
  overview?: string;
  monitored: boolean;
  hasFile: boolean;
  status: string;
  images: { coverType: string; remoteUrl?: string; url?: string }[];
  remotePoster?: string;
  qualityProfileId: number;
  sizeOnDisk: number;
  tmdbId: number;
  imdbId?: string;
  added?: string;
  genres?: string[];
  // Present in the real API response (verified live) but previously untyped/unused — Radarr
  // resolves this itself at add/refresh time via its Skyhook metadata proxy, so it's already
  // sitting in every /movie response for free, no extra OMDb/TMDB call needed to sort by it.
  ratings?: { imdb?: { value: number; votes: number } };
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  movieFile?: {
    id: number;
    quality: { quality: { name: string } };
    size: number;
    relativePath: string;
    dateAdded?: string;
    mediaInfo?: {
      audioAdditionalFeatures?: string;
      audioBitrate?: number;
      audioChannels?: number;
      audioCodec?: string;
      audioLanguages?: string;
      audioStreamCount?: number;
      videoBitDepth?: number;
      videoBitrate?: number;
      videoCodec?: string;
      videoColourPrimaries?: string;
      videoFps?: number;
      videoHdr?: boolean;
      videoDynamicRange?: string;
      videoDynamicRangeType?: string;
      videoProfile?: string;
      videoTransferCharacteristics?: string;
      resolution?: string;
      runTime?: string;
      scanType?: string;
      subtitles?: string;
      containerFormat?: string;
    };
  };
}

export interface RadarrRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  protocol: string;
  seeders?: number;
  leechers?: number;
  age: number;
  ageHours?: number;
  quality: { quality: { name: string } };
  rejected: boolean;
  rejections: string[];
  publishDate: string;
}

export const radarr = {
  getSystemStatus: () => fetchJson<{ version: string }>(`${url}/api/v3/system/status`, { headers }),
  getMovies: () => fetchJson<RadarrMovie[]>(`${url}/api/v3/movie`, { headers }),
  getMovie: (id: number) => fetchJson<RadarrMovie>(`${url}/api/v3/movie/${id}`, { headers }),
  updateMovie: (id: number, payload: Record<string, unknown>) =>
    fetchJson<RadarrMovie>(`${url}/api/v3/movie/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    }),
  getQueue: () =>
    fetchJson<{ records: any[]; totalRecords: number }>(
      `${url}/api/v3/queue?pageSize=50&includeMovie=true`,
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
  lookupMovie: (term: string) =>
    fetchJson<any[]>(`${url}/api/v3/movie/lookup?term=${encodeURIComponent(term)}`, { headers }),
  getQualityProfiles: () => fetchJson<any[]>(`${url}/api/v3/qualityprofile`, { headers }),
  getRootFolders: () => fetchJson<any[]>(`${url}/api/v3/rootfolder`, { headers }),
  addMovie: (payload: Record<string, unknown>) =>
    fetchJson<RadarrMovie>(`${url}/api/v3/movie`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
  deleteMovie: (id: number) =>
    fetchJson<void>(`${url}/api/v3/movie/${id}?deleteFiles=false`, { method: "DELETE", headers }),
  deleteMovieFile: (fileId: number) =>
    fetchJson<void>(`${url}/api/v3/moviefile/${fileId}`, { method: "DELETE", headers }),
  getHistory: (pageSize = 20) =>
    fetchJson<{ records: any[] }>(
      `${url}/api/v3/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending&includeMovie=true`,
      { headers }
    ),
  getMovieHistory: (movieId: number) =>
    fetchJson<any[]>(
      `${url}/api/v3/history/movie?movieId=${movieId}&includeMovie=true`,
      { headers }
    ),
  getCalendar: (start: string, end: string) =>
    fetchJson<RadarrMovie[]>(
      `${url}/api/v3/calendar?start=${start}&end=${end}&unmonitored=true`,
      { headers }
    ),
  searchReleases: (movieId: number) =>
    fetchJson<RadarrRelease[]>(`${url}/api/v3/release?movieId=${movieId}`, { headers }, 60000),
  grabRelease: (guid: string, indexerId: number) =>
    fetchJson<void>(`${url}/api/v3/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ guid, indexerId }),
    }),
  triggerSearch: (movieId: number) =>
    fetchJson<void>(`${url}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "MoviesSearch", movieIds: [movieId] }),
    }),
};
