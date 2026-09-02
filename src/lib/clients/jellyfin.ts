import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";
import type { JellyfinDeviceProfile } from "@/lib/deviceProfile";

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
  Overview?: string;
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

export interface JellyfinMediaStream {
  Type: "Audio" | "Subtitle" | "Video";
  Index: number;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsExternal?: boolean;
  Codec?: string;
  Profile?: string;
  BitRate?: number;
  BitDepth?: number;
  Width?: number;
  Height?: number;
  Channels?: number;
  AverageFrameRate?: number;
  DeliveryUrl?: string;
}

export interface JellyfinMediaSource {
  Id: string;
  ETag?: string;
  TranscodingUrl?: string;
  Container?: string;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  MediaStreams?: JellyfinMediaStream[];
}

export interface JellyfinPlaybackInfo {
  PlaySessionId: string;
  MediaSources: JellyfinMediaSource[];
}

export interface PlaybackInfoOptions {
  maxBitrate: number;
  mediaSourceId?: string;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  startTicks?: number;
  deviceProfile: JellyfinDeviceProfile;
}

export const jellyfin = {
  // DeviceProfile is built by the caller (see deviceProfile.ts) from the browser's actually
  // detected codec support, and handed to Jellyfin's own StreamBuilder to negotiate
  // DirectPlay / DirectStream (remux) / Transcode — same model as jellyfin-web. Replaces the
  // previous permanent "always transcode to H.264/AAC" DeviceProfile.
  //
  // Authenticated with the user's own jfToken (not the admin apiKey): Jellyfin
  // embeds this token in the returned TranscodingUrl/segment URIs (HLS clients
  // can't send custom headers per-segment), and that URL eventually reaches
  // the browser. Using the user's scoped, revocable session token there — instead
  // of the eternal admin key — keeps that unavoidable exposure low-stakes.
  getPlaybackInfo: (userId: string, itemId: string, token: string, opts: PlaybackInfoOptions) =>
    fetchJson<JellyfinPlaybackInfo>(`${url}/Items/${itemId}/PlaybackInfo?UserId=${userId}`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        UserId: userId,
        MaxStreamingBitrate: opts.maxBitrate,
        AutoOpenLiveStream: false,
        MediaSourceId: opts.mediaSourceId,
        AudioStreamIndex: opts.audioStreamIndex,
        SubtitleStreamIndex: opts.subtitleStreamIndex,
        StartTimeTicks: opts.startTicks,
        DeviceProfile: opts.deviceProfile,
      }),
    }),

  reportPlaybackStart: (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    playMethod: "DirectPlay" | "DirectStream" | "Transcode"
  ) =>
    fetchJson<void>(`${url}/Sessions/Playing`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PlayMethod: playMethod,
        CanSeek: true,
      }),
    }),

  reportPlaybackProgress: (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    positionTicks: number,
    playMethod: "DirectPlay" | "DirectStream" | "Transcode"
  ) =>
    fetchJson<void>(`${url}/Sessions/Playing/Progress`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PositionTicks: positionTicks,
        PlayMethod: playMethod,
        CanSeek: true,
        IsPaused: false,
      }),
    }),

  reportPlaybackStopped: (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    positionTicks: number
  ) =>
    fetchJson<void>(`${url}/Sessions/Playing/Stopped`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PositionTicks: positionTicks,
      }),
    }),


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
      `${url}/Users/${userId}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=ProviderIds,UserData,ProductionYear,RunTimeTicks&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllMoviesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=ProviderIds,ProductionYear,RunTimeTicks&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllSeries: (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Users/${userId}/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,UserData,ProductionYear,RunTimeTicks&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllSeriesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,ProductionYear,RunTimeTicks&Limit=5000`,
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

  // Jellyfin only puts ProviderIds (Tvdb/Tmdb) on the Series item itself, never
  // on its Episode children — even when Fields=ProviderIds is requested on the
  // episode. Needed to resolve a "series sheet" link from a resume/recent episode.
  getItemProviderIds: (userId: string, itemId: string) =>
    fetchJson<{ ProviderIds?: JellyfinItem["ProviderIds"] }>(
      `${url}/Users/${userId}/Items/${itemId}?Fields=ProviderIds`,
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

  // All episodes of a series, in one call — used to cross-reference against
  // Sonarr's season/episode list by (ParentIndexNumber, IndexNumber).
  // Overview added on top of the original field list — Cinema Mode's episode browser needs a
  // per-episode synopsis and this is the only call that already returns the full episode list;
  // additive field, no effect on existing callers that don't read it.
  getSeriesEpisodes: (userId: string, seriesId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Shows/${seriesId}/Episodes?userId=${userId}&Fields=ProviderIds,UserData,ImageTags,RunTimeTicks,IndexNumber,ParentIndexNumber,Overview`,
      { headers }
    ).then((res) => res.Items),

  // Jellyfin's own "what to watch next" for a series: the in-progress episode
  // if one exists, otherwise the next unwatched one after the last played —
  // exactly the Netflix-style "Lire"/"Reprendre" logic for a series' main
  // play button, without reimplementing it ourselves.
  getNextUp: (userId: string, seriesId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Shows/NextUp?SeriesId=${seriesId}&UserId=${userId}&Limit=1&Fields=UserData,ImageTags,RunTimeTicks,IndexNumber,ParentIndexNumber`,
      { headers }
    ).then((res) => res.Items[0] ?? null),

  // Same endpoint as getNextUp, but with no SeriesId — Jellyfin's own home-screen "Next Up" feed,
  // aggregated across the WHOLE library: one entry per series the user has any watch history on,
  // each already resolved to either that series' in-progress episode (if one is partway through)
  // or the next unwatched one after the last played episode. This is what lets Cinema Mode's own
  // Continue Watching row show a series that hasn't been started yet ("Lire EpX SX") and not just
  // ones with an actual partial episode ("Reprendre EpX SX") — getResumeItems only ever returns
  // the latter, since by definition nothing has been played on the former.
  getNextUpGlobal: (userId: string, limit = 10) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Shows/NextUp?UserId=${userId}&Limit=${limit}&Fields=UserData,ImageTags,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeriesId`,
      { headers }
    ).then((res) => res.Items),

  // Jellyfin 10.11's per-user recursive `/Users/{id}/Items` query silently
  // drops a large, seemingly arbitrary chunk of the library (confirmed:
  // ~27% of movies on this server) with no correlating permission/rating
  // restriction — but a direct per-item lookup for one of those "missing"
  // items still returns its UserData correctly. Used as a fallback when an
  // item can't be found in the bulk per-user list, so watched/resume state
  // doesn't just disappear for whichever titles are affected.
  // RunTimeTicks added on top of the original Fields list — Cinema Mode's movie detail sheet
  // needs it alongside UserData.PlaybackPositionTicks to compute a remaining-time resume label
  // (see cinemaContinueLabel.ts) and this is already the per-item lookup it needs anyway.
  // Additive field, no effect on existing callers that only read .UserData.
  getItemUserData: (userId: string, itemId: string) =>
    fetchJson<{ UserData?: JellyfinItem["UserData"]; RunTimeTicks?: number }>(
      `${url}/Users/${userId}/Items/${itemId}?Fields=UserData,RunTimeTicks`,
      { headers }
    ),

  // From the "Intro Skipper" plugin — not core Jellyfin API, so this 404s
  // (or has Valid:false segments) for movies and for episodes it hasn't
  // analyzed yet. Callers must treat failures as "no data", not an error.
  getEpisodeTimestamps: (itemId: string) =>
    fetchJson<{
      Introduction?: { Start: number; End: number; Valid: boolean };
      Credits?: { Start: number; End: number; Valid: boolean };
    }>(`${url}/Episode/${itemId}/Timestamps`, { headers }),
};
