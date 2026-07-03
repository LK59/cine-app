import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { url, apiKey } = config.jellyfin;
const headers = { "X-Emby-Token": apiKey };

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type?: string;
  ProductionYear?: number;
  UserData?: {
    Played: boolean;
    PlayCount: number;
    LastPlayedDate?: string;
    PlaybackPositionTicks?: number;
  };
  ProviderIds?: { Tmdb?: string; Tvdb?: string; Imdb?: string };
  ImageTags?: { Primary?: string };
  RunTimeTicks?: number;
  SeriesName?: string;
  SeriesId?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
}

export interface JellyfinSession {
  Id: string;
  UserName?: string;
  Client: string;
  DeviceName: string;
  NowPlayingItem?: { Name: string; Type: string; RunTimeTicks?: number };
  PlayState?: {
    PositionTicks?: number;
    IsPaused?: boolean;
    PlayMethod?: "DirectPlay" | "DirectStream" | "Transcode";
  };
  TranscodingInfo?: {
    Bitrate?: number;
    VideoCodec?: string;
    AudioCodec?: string;
    Container?: string;
    CompletionPercentage?: number;
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
    TranscodeReasons?: string[];
  };
}

export const jellyfin = {
  getSystemInfo: () =>
    fetchJson<{ ServerName: string; Version: string }>(`${url}/System/Info`, { headers }),
  getSessions: () => fetchJson<JellyfinSession[]>(`${url}/Sessions`, { headers }),
  getLibraryCounts: () =>
    fetchJson<{ MovieCount: number; SeriesCount: number; EpisodeCount: number }>(
      `${url}/Items/Counts`,
      { headers }
    ),
  refreshLibrary: () =>
    fetchJson<void>(`${url}/Library/Refresh`, { method: "POST", headers }),

  // AnyProviderIdEquals is broken in Jellyfin 10.11 — fetch all and filter in JS
  getAllMovies: (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Users/${userId}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=ProviderIds,UserData,ProductionYear&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllMoviesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=ProviderIds,ProductionYear&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllSeries: (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Users/${userId}/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,UserData,ProductionYear&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllSeriesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,ProductionYear&Limit=5000`,
      { headers }
    ).then((res) => res.Items),


  markPlayed: (userId: string, itemId: string) =>
    fetchJson<void>(`${url}/Users/${userId}/PlayedItems/${itemId}`, { method: "POST", headers }),

  markUnplayed: (userId: string, itemId: string) =>
    fetchJson<void>(`${url}/Users/${userId}/PlayedItems/${itemId}`, { method: "DELETE", headers }),

  getResumeItems: (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Users/${userId}/Items/Resume?Limit=10&MediaTypes=Video&Fields=ProviderIds,UserData,ImageTags,RunTimeTicks,SeriesName,SeriesId,IndexNumber,ParentIndexNumber&Recursive=true`,
      { headers }
    ),

  getRecentlyPlayed: (userId: string, type: "Movie" | "Episode", limit = 10) =>
    fetchJson<{ Items: JellyfinItem[]; TotalRecordCount: number }>(
      `${url}/Users/${userId}/Items?Filters=IsPlayed&IncludeItemTypes=${type}&SortBy=DatePlayed&SortOrder=Descending&Limit=${limit}&Recursive=true&Fields=ProviderIds,UserData,ImageTags,RunTimeTicks,SeriesName,IndexNumber,ParentIndexNumber`,
      { headers }
    ),

  getPlayedCount: (userId: string, type: "Movie" | "Episode") =>
    fetchJson<{ TotalRecordCount: number }>(
      `${url}/Users/${userId}/Items?Filters=IsPlayed&IncludeItemTypes=${type}&Recursive=true&Limit=0`,
      { headers }
    ),

  getWatchTimeTicks: (userId: string) =>
    fetchJson<{ Items: { RunTimeTicks?: number }[]; TotalRecordCount: number }>(
      `${url}/Users/${userId}/Items?Filters=IsPlayed&IncludeItemTypes=Movie,Episode&Recursive=true&Fields=RunTimeTicks&Limit=500`,
      { headers }
    ),
};
