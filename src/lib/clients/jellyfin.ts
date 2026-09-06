import { PLAYBACK_CLIENTS, type PlaybackClient } from "@/lib/playbackClients";
import type { NamedItem } from "@/lib/displayTitle";

export { PLAYBACK_CLIENTS, isPlaybackClient, type PlaybackClient } from "@/lib/playbackClients";

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
    /** Présent dans la réponse dès que `Fields=UserData` est demandé — vérifié en direct. */
    IsFavorite?: boolean;
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
  // Jellyfin derives these from the video bitstream itself, not from the container — verified
  // live: the Matroska Colour element is absent from these files, and ffprobe reports
  // smpte2084/bt2020 by parsing the HEVC SPS. So this is the authoritative HDR signal.
  VideoRange?: string;
  VideoRangeType?: string;
  Width?: number;
  Height?: number;
  Channels?: number;
  // Jellyfin 10.10 et suivants. Absent des versions antérieures, d'où l'optionnel : les
  // appelants retombent alors sur ce que la piste dit d'elle-même dans son nom.
  IsHearingImpaired?: boolean;
  IsForced?: boolean;
  Title?: string;
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

/**
 * Identifies the client for one playback report.
 *
 * The device id is stable per user and per client, so the two players are two devices and
 * neither multiplies sessions as films are opened and closed. It is deliberately *not* the id
 * minted at login: that one belongs to an authentication, and re-registering a device id through
 * AuthenticateByName is what used to evict other people's tokens (see the auth route). Nothing
 * here authenticates, so nothing here can evict anything.
 */
function playbackHeaders(token: string, client: PlaybackClient, userId: string) {
  const deviceId = `${client === PLAYBACK_CLIENTS.engine ? "cine-engine" : "cine-app"}-${userId}`;
  return {
    "X-Emby-Token": token,
    "Content-Type": "application/json",
    Authorization: `MediaBrowser Client="${client}", Device="Navigateur", DeviceId="${deviceId}", Version="1.0.0", Token="${token}"`,
  };
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
    playMethod: "DirectPlay" | "DirectStream" | "Transcode",
    client: PlaybackClient = PLAYBACK_CLIENTS.stable
  ) =>
    fetchJson<void>(`${url}/Sessions/Playing`, {
      method: "POST",
      headers: playbackHeaders(token, client, userId),
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
    playMethod: "DirectPlay" | "DirectStream" | "Transcode",
    client: PlaybackClient = PLAYBACK_CLIENTS.stable,
    isPaused = false
  ) =>
    fetchJson<void>(`${url}/Sessions/Playing/Progress`, {
      method: "POST",
      headers: playbackHeaders(token, client, userId),
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PositionTicks: positionTicks,
        PlayMethod: playMethod,
        CanSeek: true,
        // Truthfully: a paused film left on screen for an hour is not an hour of watching, and
        // Jellyfin's dashboard says "playing" for all of it when this is hardcoded.
        IsPaused: isPaused,
      }),
    }),

  reportPlaybackStopped: (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    positionTicks: number,
    client: PlaybackClient = PLAYBACK_CLIENTS.stable
  ) =>
    fetchJson<void>(`${url}/Sessions/Playing/Stopped`, {
      method: "POST",
      headers: playbackHeaders(token, client, userId),
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PositionTicks: positionTicks,
      }),
    }),


  /**
   * The viewer's own playback preferences, read with their own token.
   *
   * Their account, their settings: the admin key would answer for whoever it belongs to, which
   * on a shared server is somebody else's languages.
   */
  getUserConfiguration: (userId: string, token: string) =>
    fetchJson<{
      Configuration?: {
        AudioLanguagePreference?: string | null;
        SubtitleLanguagePreference?: string | null;
        SubtitleMode?: string | null;
        PlayDefaultAudioTrack?: boolean;
      };
    }>(`${url}/Users/${userId}`, { headers: { "X-Emby-Token": token } }),

  /**
   * Écrire ces mêmes préférences, avec le jeton de la personne.
   *
   * Jellyfin remplace la configuration entière : envoyer seulement les deux champs modifiés
   * effacerait tout le reste. L'appelant relit donc la configuration courante et renvoie l'objet
   * complet — voir la route, qui fait exactement ça.
   */
  updateUserConfiguration: (userId: string, token: string, configuration: Record<string, unknown>) =>
    fetchJson<void>(`${url}/Users/${userId}/Configuration`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(configuration),
    }),

  /**
   * Changer son propre mot de passe.
   *
   * Avec le jeton de la personne, et son mot de passe actuel : c'est Jellyfin qui vérifie, pas
   * nous. La clé d'administration ferait le changement sans rien demander, ce qui transformerait
   * une session volée en prise de contrôle du compte.
   */
  changePassword: (userId: string, token: string, currentPw: string, newPw: string) =>
    fetchJson<void>(`${url}/Users/${userId}/Password`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ CurrentPw: currentPw, NewPw: newPw }),
    }),

  /**
   * Just enough of an item to name it on screen: the series, the season, the number, the title.
   *
   * Asked of the server rather than taken from whoever opened the player — eight places do, and
   * each passes whatever title it had to hand.
   */
  getItemNaming: (userId: string, itemId: string) =>
    fetchJson<{ Items?: NamedItem[] }>(
      `${url}/Items?ids=${itemId}&userId=${userId}&fields=ParentIndexNumber,IndexNumber`,
      { headers }
    ).then((page) => page.Items?.[0] ?? null),

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

  // Les favoris vivent chez Jellyfin, pas dans la base locale : c'est ce qui les fait apparaître
  // aussi dans les applications Jellyfin de la personne, sur sa télé comme sur son téléphone. Ils
  // ne concernent donc que des titres présents dans la bibliothèque — sans identifiant Jellyfin,
  // il n'y a rien à marquer.
  markFavorite: (userId: string, itemId: string) =>
    fetchJson<void>(`${url}/Users/${userId}/FavoriteItems/${itemId}`, { method: "POST", headers }),

  unmarkFavorite: (userId: string, itemId: string) =>
    fetchJson<void>(`${url}/Users/${userId}/FavoriteItems/${itemId}`, { method: "DELETE", headers }),

  /**
   * Ce que cette personne a vu, et ce qu'elle a mis en favori.
   *
   * Des requêtes ciblées, et non un balayage de la bibliothèque filtré ensuite : l'énumération par
   * compte (`/Users/{id}/Items` sans filtre) est incomplète sur cette installation — 546 films
   * contre 674 vus par le serveur, pour un compte administrateur — alors que ces deux-ci
   * répondent juste. Elles sont aussi bien plus légères : quelques dizaines d'éléments au lieu de
   * plusieurs centaines.
   */
  getPlayedItems: (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Users/${userId}/Items?Filters=IsPlayed&IncludeItemTypes=Movie,Series&Recursive=true&Fields=ProviderIds,UserData,ImageTags,ProductionYear,RunTimeTicks&Limit=500`,
      { headers }
    ).then((res) => res.Items),

  getFavorites: (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${url}/Users/${userId}/Items?Filters=IsFavorite&IncludeItemTypes=Movie,Series&Recursive=true&Fields=ProviderIds,UserData,ImageTags,ProductionYear,RunTimeTicks&Limit=500`,
      { headers }
    ).then((res) => res.Items),

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
  /**
   * Tous les comptes du serveur, avec leur nom et leur identifiant.
   *
   * Lu avec la clé d'administration : c'est une tâche de fond qui appelle, sans session de
   * personne. Le nom compte autant que l'identifiant — c'est sous lui que les abonnements aux
   * notifications sont rangés (voir `pushDb`), et sous l'identifiant que Jellyfin répond.
   */
  getUsers: () =>
    fetchJson<{ Id: string; Name: string }[]>(`${url}/Users`, { headers }),

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
  // Everything the experimental WebCodecs player needs to decide whether it can play a file and
  // how: container, per-stream codecs, HDR range, and the resume position — all from the one
  // per-item lookup, with no PlaybackInfo call and therefore no transcode session created.
  getItemMediaSources: (userId: string, itemId: string) =>
    fetchJson<{
      Name?: string;
      RunTimeTicks?: number;
      UserData?: JellyfinItem["UserData"];
      MediaSources?: JellyfinMediaSource[];
    }>(`${url}/Users/${userId}/Items/${itemId}?Fields=MediaSources,UserData,RunTimeTicks`, { headers }),

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
