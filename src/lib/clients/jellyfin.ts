import { PLAYBACK_CLIENTS, type PlaybackClient } from "@/lib/playbackClients";
import type { PlaybackDevice } from "@/lib/playbackDevice";
import type { NamedItem } from "@/lib/displayTitle";

export { PLAYBACK_CLIENTS, isPlaybackClient, type PlaybackClient } from "@/lib/playbackClients";

import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";
import { jellyfinAuth, jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { forwardedFor } from "@/lib/clientAddress";
import { jellyfinIdSegment as idSegment } from "@/lib/jellyfinPath";
import type { JellyfinDeviceProfile } from "@/lib/deviceProfile";
import { APP_VERSION } from "@/lib/appBuild";

// Lu à chaque appel, et non recopié au chargement : réglable dans l'application (DECISIONS.md §48).
const cfg = config.jellyfin;
// Un accesseur : lu par `fetch` à chaque requête, il suit un réglage changé dans l'application.
const headers = {
  get Authorization() {
    return jellyfinAuthHeaders(cfg.apiKey).Authorization;
  },
};

export interface JellyfinItem {
  Id: string;
  Name: string;
  /** Lus par le catalogue pour cacher à chaque compte ce que ses tags bloqués lui cachent (`blockedTags.ts`). */
  Tags?: string[];
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
  /** Quand l'élément est entré dans la bibliothèque — un épisode arrivé après qu'une série a été marquée vue la fait revenir (§51). */
  DateCreated?: string;
  /** Le chemin sur disque : un dossier pour une série, un fichier pour un film. Demandé par les listes d'administration (rapprochement par dossier). */
  Path?: string;
  ImageTags?: { Primary?: string };
  /** Les empreintes des visuels de fond — rendues sans `Fields` ; la première sert de grand visuel (`seriesBackdrop`). */
  BackdropImageTags?: string[];
  RunTimeTicks?: number;
  /**
   * Combien d'éléments cette série contient, tous niveaux confondus.
   *
   * Demandés explicitement — ils n'arrivent pas sans `Fields`. Ils ne servent qu'à une chose :
   * distinguer une série réellement finie d'une série vide. Voir `hasSomethingWatched`.
   */
  RecursiveItemCount?: number;
  ChildCount?: number;
  Overview?: string;
  SeriesName?: string;
  SeriesId?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
}

/**
 * Cet élément dit-il quelque chose de ce que la personne a regardé ?
 *
 * `Filters=IsPlayed` répond « oui » pour une série **vide**, et c'est correct : tous ses épisodes
 * — les zéro — ont été vus. Le résultat est qu'une série présente dans Sonarr mais dont aucun
 * fichier n'a encore été importé apparaît comme vue par **tout le monde**, y compris un compte
 * créé à l'instant. Observé le 18/09/2026 sur « La casa de las flores », seule série marquée vue
 * de toute l'installation : `ChildCount=0`, `RecursiveItemCount=0`, `PlayCount=0`, pour les
 * vingt-deux comptes.
 *
 * Le filtre est volontairement le plus étroit possible : seules les séries sont concernées — un
 * film ne peut pas être vide — et seul un compte d'épisodes **explicitement nul** écarte. Quand
 * Jellyfin ne renvoie pas ces champs, on garde : mieux vaut une ligne de trop qu'un historique
 * amputé par une hypothèse sur le serveur d'en face.
 */
export function hasSomethingWatched(item: JellyfinItem): boolean {
  if (item.Type !== "Series") return true;
  const episodes = item.RecursiveItemCount ?? item.ChildCount;
  return episodes !== 0;
}

export interface JellyfinSession {
  Id: string;
  /** Le dernier rapport de lecture reçu pour cette session. */
  LastPlaybackCheckIn?: string;
  LastActivityDate?: string;
  UserName?: string;
  UserId?: string;
  Client: string;
  DeviceName: string;
  NowPlayingItem?: {
    Name: string;
    Type: string;
    RunTimeTicks?: number;
    Id?: string;
    SeriesName?: string;
    IndexNumber?: number;
    ParentIndexNumber?: number;
  };
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
  /**
   * Vrai pour un sous-titre fait de texte, faux pour un sous-titre fait d'images (PGS, VobSub).
   *
   * La distinction n'a pas d'importance dans la page, qui reçoit du VTT dans les deux cas. Elle en
   * a une décisive pour la diffusion : un sous-titre image ne peut pas devenir une piste du flux,
   * Jellyfin doit l'incruster — donc **ré-encoder la vidéo**, et la couche Dolby Vision se perd
   * avec. Voir `castRefusalFor`.
   */
  IsTextSubtitleStream?: boolean;
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
  /** « 5.1 », « stereo »… Absent d'un AAC dont la disposition est un PCE — voir `audioNeedsStereoReencode`. */
  ChannelLayout?: string;
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
  /** Taille du fichier en octets — celle que le flux statique annonce dans `Content-Length`. */
  Size?: number;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  MediaStreams?: JellyfinMediaStream[];
  /** La piste son que Jellyfin retient quand on ne lui en demande aucune. */
  DefaultAudioStreamIndex?: number;
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
 * L'appareil est celui de la connexion (`device.id`, gardé avec la session) et son nom le libellé
 * de l'appareil qui envoie le rapport — voir `playbackDevice.ts`, qui dit aussi pourquoi c'est sans
 * danger : un rapport n'authentifie pas, et seul `AuthenticateByName` évince un jeton. Les deux
 * lecteurs restent deux sessions chez Jellyfin parce qu'il clé les sessions par client *et*
 * appareil.
 *
 * Sans appareil connu (session ouverte avant qu'on le garde), l'ancien identifiant stable par
 * compte et par client : il ne multiplie pas les sessions à chaque film, et ne réinscrit rien.
 */
async function playbackHeaders(token: string, client: PlaybackClient, userId: string, device?: PlaybackDevice) {
  const deviceId = device?.id ?? `${client === PLAYBACK_CLIENTS.engine ? "cine-engine" : "cine-app"}-${userId}`;
  return {
    ...(await forwardedFor()),
    "Content-Type": "application/json",
    Authorization: jellyfinAuth(token, {
      client,
      device: device?.name ?? "Navigateur",
      deviceId,
      version: APP_VERSION,
    }),
  };
}

/** Un compte, tel que `/Users` le rend à la clé d'administration. */
export interface JellyfinUser {
  Id: string;
  Name: string;
  LastLoginDate?: string;
  LastActivityDate?: string;
  HasPassword?: boolean;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean; EnableRemoteAccess?: boolean; EnableMediaPlayback?: boolean; InvalidLoginAttemptCount?: number };
}

export interface JellyfinDevice {
  Id: string;
  Name?: string;
  AppName?: string;
  AppVersion?: string;
  LastUserName?: string;
  LastUserId?: string;
  DateLastActivity?: string;
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
  getPlaybackInfo: async (userId: string, itemId: string, token: string, opts: PlaybackInfoOptions) =>
    fetchJson<JellyfinPlaybackInfo>(`${cfg.url}/Items/${idSegment(itemId)}/PlaybackInfo?UserId=${idSegment(userId)}`, {
      method: "POST",
      headers: { ...jellyfinAuthHeaders(token), ...(await forwardedFor()), "Content-Type": "application/json" },
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

  reportPlaybackStart: async (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    playMethod: "DirectPlay" | "DirectStream" | "Transcode",
    client: PlaybackClient = PLAYBACK_CLIENTS.stable,
    device?: PlaybackDevice
  ) =>
    fetchJson<void>(`${cfg.url}/Sessions/Playing`, {
      method: "POST",
      headers: await playbackHeaders(token, client, userId, device),
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PlayMethod: playMethod,
        CanSeek: true,
      }),
    }),

  reportPlaybackProgress: async (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    positionTicks: number,
    playMethod: "DirectPlay" | "DirectStream" | "Transcode",
    client: PlaybackClient = PLAYBACK_CLIENTS.stable,
    isPaused = false,
    device?: PlaybackDevice
  ) =>
    fetchJson<void>(`${cfg.url}/Sessions/Playing/Progress`, {
      method: "POST",
      headers: await playbackHeaders(token, client, userId, device),
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

  reportPlaybackStopped: async (
    userId: string,
    itemId: string,
    token: string,
    playSessionId: string,
    mediaSourceId: string,
    positionTicks: number,
    client: PlaybackClient = PLAYBACK_CLIENTS.stable,
    device?: PlaybackDevice
  ) =>
    fetchJson<void>(`${cfg.url}/Sessions/Playing/Stopped`, {
      method: "POST",
      headers: await playbackHeaders(token, client, userId, device),
      body: JSON.stringify({
        UserId: userId,
        ItemId: itemId,
        PlaySessionId: playSessionId,
        MediaSourceId: mediaSourceId,
        PositionTicks: positionTicks,
      }),
    }),

  /**
   * Le jeton de cette personne est-il encore accepté ?
   *
   * La question la plus légère qu'on puisse lui poser avec. Court et sans nouvel essai : elle est
   * posée sur le chemin d'un chargement de page, qui ne doit pas attendre un serveur lent — voir
   * `jellyfinToken.ts`, qui ne conclut que d'un 401, d'un 403, ou de ce que `Policy` dit du compte.
   */
  checkUserToken: async (token: string) =>
    fetchJson<{ Id?: string; Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean } }>(`${cfg.url}/Users/Me`, { headers: { ...jellyfinAuthHeaders(token), ...(await forwardedFor()) } }, 2500, undefined, 0),

  /**
   * Écrire la position d'une personne avec la clé d'administration.
   *
   * Le filet des rapports de lecture quand Jellyfin a révoqué son jeton (un mot de passe changé ou
   * réinitialisé révoque tous ceux du compte) : sans lui, six jours de visionnage d'un compte se
   * sont perdus en silence (24/09/2026). La date est écrite aussi, pour que « Reprendre » range le
   * titre à sa place.
   */
  savePositionAsAdmin: async (userId: string, itemId: string, positionTicks: number) =>
    fetchJson<void>(`${cfg.url}/UserItems/${idSegment(itemId)}/UserData?userId=${idSegment(userId)}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ PlaybackPositionTicks: positionTicks, LastPlayedDate: new Date().toISOString() }),
    }),

  /** La durée d'un titre, en ticks — pour décider comme Jellyfin si un arrêt vaut « vu ». */
  /**
   * La durée d'un élément sans passer par un compte : la clé du serveur suffit. Pour l'activité,
   * dont l'administrateur peut être connecté localement, sans compte Jellyfin derrière lui.
   */
  getItemRunTimeTicks: (itemId: string) =>
    fetchJson<{ Items?: { RunTimeTicks?: number }[] }>(`${cfg.url}/Items?ids=${encodeURIComponent(itemId)}`, { headers }).then(
      (r) => r.Items?.[0]?.RunTimeTicks ?? null
    ),

  getRunTimeTicks: async (userId: string, itemId: string) =>
    fetchJson<{ RunTimeTicks?: number }>(`${cfg.url}/Users/${idSegment(userId)}/Items/${idSegment(itemId)}`, { headers }).then(
      (item) => item.RunTimeTicks ?? null
    ),

  /**
   * The viewer's own playback preferences, read with their own token.
   *
   * Their account, their settings: the admin key would answer for whoever it belongs to, which
   * on a shared server is somebody else's languages.
   */
  getUserConfiguration: async (userId: string, token: string) =>
    fetchJson<{
      Configuration?: {
        AudioLanguagePreference?: string | null;
        SubtitleLanguagePreference?: string | null;
        SubtitleMode?: string | null;
        PlayDefaultAudioTrack?: boolean;
      };
    }>(`${cfg.url}/Users/${idSegment(userId)}`, { headers: { ...jellyfinAuthHeaders(token), ...(await forwardedFor()) } }),

  /**
   * Écrire ces mêmes préférences, avec le jeton de la personne.
   *
   * Jellyfin remplace la configuration entière : envoyer seulement les deux champs modifiés
   * effacerait tout le reste. L'appelant relit donc la configuration courante et renvoie l'objet
   * complet — voir la route, qui fait exactement ça.
   */
  updateUserConfiguration: async (userId: string, token: string, configuration: Record<string, unknown>) =>
    fetchJson<void>(`${cfg.url}/Users/${idSegment(userId)}/Configuration`, {
      method: "POST",
      headers: { ...jellyfinAuthHeaders(token), ...(await forwardedFor()), "Content-Type": "application/json" },
      body: JSON.stringify(configuration),
    }),

  /**
   * Changer son propre mot de passe.
   *
   * Avec le jeton de la personne, et son mot de passe actuel : c'est Jellyfin qui vérifie, pas
   * nous. La clé d'administration ferait le changement sans rien demander, ce qui transformerait
   * une session volée en prise de contrôle du compte.
   */
  changePassword: async (userId: string, token: string, currentPw: string, newPw: string) =>
    fetchJson<void>(`${cfg.url}/Users/${idSegment(userId)}/Password`, {
      method: "POST",
      headers: { ...jellyfinAuthHeaders(token), ...(await forwardedFor()), "Content-Type": "application/json" },
      body: JSON.stringify({ CurrentPw: currentPw, NewPw: newPw }),
    }),

  /**
   * Just enough of an item to name it on screen: the series, the season, the number, the title.
   *
   * Asked of the server rather than taken from whoever opened the player — eight places do, and
   * each passes whatever title it had to hand.
   */
  getItemNaming: async (userId: string, itemId: string) =>
    fetchJson<{ Items?: NamedItem[] }>(
      `${cfg.url}/Items?ids=${idSegment(itemId)}&userId=${idSegment(userId)}&fields=ParentIndexNumber,IndexNumber,ProviderIds`,
      { headers }
    ).then((page) => page.Items?.[0] ?? null),

  getSystemInfo: () =>
    fetchJson<{ ServerName: string; Version: string }>(`${cfg.url}/System/Info`, { headers }),
  getSessions: () => fetchJson<JellyfinSession[]>(`${cfg.url}/Sessions`, { headers }),
  getLibraryCounts: () =>
    fetchJson<{ MovieCount: number; SeriesCount: number; EpisodeCount: number }>(
      `${cfg.url}/Items/Counts`,
      { headers }
    ),
  refreshLibrary: () =>
    fetchJson<void>(`${cfg.url}/Library/Refresh`, { method: "POST", headers }),

  // AnyProviderIdEquals is broken in Jellyfin 10.11 — fetch all and filter in JS
  /**
   * `CollapseBoxSetItems=false` — et ce n'est pas une option d'affichage, c'est ce qui décide si
   * un film existe pour cette application.
   *
   * Sans ce paramètre, Jellyfin replie les films appartenant à une collection **dans** leur
   * collection : l'énumération renvoie le BoxSet à la place de ses membres. Mesuré le 18/09/2026
   * sur cette installation : 511 films et 54 BoxSet là où la bibliothèque en compte 688. Les 54
   * titres repliés — « Hannibal », toute une saga à la fois — étaient absents du catalogue, donc
   * introuvables dans la grille et impossibles à ouvrir depuis la recherche, qui les trouvait
   * pourtant et pointait vers une fiche que rien ne pouvait résoudre.
   *
   * `IncludeItemTypes=Movie` ne suffit pas à s'en protéger : Jellyfin classe le BoxSet parmi les
   * films et le renvoie quand même. C'est le repliement qu'il faut refuser, pas le type qu'il faut
   * filtrer.
   */
  getAllMovies: async (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?IncludeItemTypes=Movie&Recursive=true&CollapseBoxSetItems=false&Fields=ProviderIds,UserData,ProductionYear,RunTimeTicks&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  /** Même repliement, même correctif — voir `getAllMovies`. */
  getAllMoviesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Items?IncludeItemTypes=Movie&Recursive=true&CollapseBoxSetItems=false&Fields=ProviderIds,ProductionYear,RunTimeTicks,Path,Tags&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllSeries: async (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,UserData,ProductionYear,RunTimeTicks&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  getAllSeriesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,ProductionYear,RunTimeTicks,Path,Tags&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  /** La configuration du serveur — pour ses seuils de reprise (`MinResumePct`, `MaxResumePct`). */
  getServerConfiguration: () =>
    fetchJson<{ MinResumePct?: number; MaxResumePct?: number; MinResumeDurationSeconds?: number }>(`${cfg.url}/System/Configuration`, { headers }),

  /**
   * Le premier épisode (S1·É1) de chaque série, en un appel pour toute la bibliothèque — de quoi
   * montrer « Lire S1·É1 » dès l'ouverture d'une fiche de série jamais commencée (08/10/2026).
   */
  getFirstEpisodesAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Items?IncludeItemTypes=Episode&Recursive=true&ParentIndexNumber=1&IndexNumber=1&Fields=RunTimeTicks&Limit=5000`,
      { headers }
    ).then((res) => res.Items),

  /**
   * Les saisons de toute la bibliothèque, en un appel, avec leur nombre d'épisodes : de quoi dire
   * « 3 saisons » sur la fiche dès l'ouverture (08/10/2026). Mesuré le même jour : le compte des
   * saisons non vides est identique, série par série, à celui de la liste d'épisodes de la fiche.
   */
  getSeasonsAdmin: () =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Items?IncludeItemTypes=Season&Recursive=true&Fields=ChildCount&EnableImages=false&Limit=10000`,
      { headers }
    ).then((res) => res.Items),

  markPlayed: async (userId: string, itemId: string) =>
    fetchJson<void>(`${cfg.url}/Users/${idSegment(userId)}/PlayedItems/${idSegment(itemId)}`, { method: "POST", headers }),

  markUnplayed: async (userId: string, itemId: string) =>
    fetchJson<void>(`${cfg.url}/Users/${idSegment(userId)}/PlayedItems/${idSegment(itemId)}`, { method: "DELETE", headers }),

  /**
   * Oublie où l'on en était d'un titre, sans rien toucher d'autre — ce qui le retire de « Reprendre ».
   *
   * Pas `markUnplayed` : il remet aussi à zéro le nombre de visionnages et l'état « Vu », si bien
   * qu'un film déjà vu puis recommencé aurait perdu son « Vu » en quittant la rangée. Cette route
   * (Jellyfin 10.9 et suivants) ne met à jour que les champs envoyés — vérifiée en direct sur le
   * serveur le 23/09/2026.
   */
  resetPlaybackPosition: async (userId: string, itemId: string) =>
    fetchJson<unknown>(`${cfg.url}/UserItems/${idSegment(itemId)}/UserData?userId=${idSegment(userId)}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ PlaybackPositionTicks: 0 }),
    }),

  // Les favoris vivent chez Jellyfin, pas dans la base locale : c'est ce qui les fait apparaître
  // aussi dans les applications Jellyfin de la personne, sur sa télé comme sur son téléphone. Ils
  // ne concernent donc que des titres présents dans la bibliothèque — sans identifiant Jellyfin,
  // il n'y a rien à marquer.
  markFavorite: async (userId: string, itemId: string) =>
    fetchJson<void>(`${cfg.url}/Users/${idSegment(userId)}/FavoriteItems/${idSegment(itemId)}`, { method: "POST", headers }),

  unmarkFavorite: async (userId: string, itemId: string) =>
    fetchJson<void>(`${cfg.url}/Users/${idSegment(userId)}/FavoriteItems/${idSegment(itemId)}`, { method: "DELETE", headers }),

  /**
   * Ce que cette personne a vu, et ce qu'elle a mis en favori.
   *
   * Des requêtes ciblées, et non un balayage de la bibliothèque filtré ensuite : l'énumération par
   * compte (`/Users/{id}/Items` sans filtre) est incomplète sur cette installation — 546 films
   * contre 674 vus par le serveur, pour un compte administrateur — alors que ces deux-ci
   * répondent juste. Elles sont aussi bien plus légères : quelques dizaines d'éléments au lieu de
   * plusieurs centaines.
   */
  getPlayedItems: async (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?Filters=IsPlayed&IncludeItemTypes=Movie,Series&Recursive=true&Fields=ProviderIds,UserData,ImageTags,ProductionYear,RunTimeTicks,RecursiveItemCount,ChildCount&Limit=500`,
      { headers }
    ).then((res) => res.Items.filter(hasSomethingWatched)),

  getFavorites: async (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?Filters=IsFavorite&IncludeItemTypes=Movie,Series&Recursive=true&Fields=ProviderIds,UserData,ImageTags,ProductionYear,RunTimeTicks&Limit=500`,
      { headers }
    ).then((res) => res.Items),

  getResumeItems: async (userId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items/Resume?Limit=10&MediaTypes=Video&Fields=ProviderIds,UserData,ImageTags,RunTimeTicks,SeriesName,SeriesId,IndexNumber,ParentIndexNumber,DateCreated&Recursive=true`,
      { headers }
    ),

  // Jellyfin only puts ProviderIds (Tvdb/Tmdb) on the Series item itself, never
  // on its Episode children — even when Fields=ProviderIds is requested on the
  // episode. Needed to resolve a "series sheet" link from a resume/recent episode.
  /** Un élément seul, de quoi le rattacher à son titre : type, série, identifiants, date d'entrée (§51). */
  getItemBasic: async (userId: string, itemId: string) =>
    fetchJson<JellyfinItem>(
      `${cfg.url}/Users/${idSegment(userId)}/Items/${idSegment(itemId)}?Fields=ProviderIds,SeriesId,DateCreated,IndexNumber,ParentIndexNumber,ProductionYear,ImageTags,UserData`,
      { headers }
    ),

  getItemProviderIds: async (userId: string, itemId: string) =>
    fetchJson<{ ProviderIds?: JellyfinItem["ProviderIds"] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items/${idSegment(itemId)}?Fields=ProviderIds`,
      { headers }
    ),

  getRecentlyPlayed: async (userId: string, type: "Movie" | "Episode", limit = 10) =>
    fetchJson<{ Items: JellyfinItem[]; TotalRecordCount: number }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?Filters=IsPlayed&IncludeItemTypes=${type}&SortBy=DatePlayed&SortOrder=Descending&Limit=${limit}&Recursive=true&Fields=ProviderIds,UserData,ImageTags,RunTimeTicks,SeriesName,IndexNumber,ParentIndexNumber`,
      { headers }
    ),

  getPlayedCount: async (userId: string, type: "Movie" | "Episode") =>
    fetchJson<{ TotalRecordCount: number }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?Filters=IsPlayed&IncludeItemTypes=${type}&Recursive=true&Limit=0`,
      { headers }
    ),

  getWatchTimeTicks: async (userId: string) =>
    fetchJson<{ Items: { RunTimeTicks?: number }[]; TotalRecordCount: number }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?Filters=IsPlayed&IncludeItemTypes=Movie,Episode&Recursive=true&Fields=RunTimeTicks&Limit=500`,
      { headers }
    ),

  // All episodes of a series, in one call — used to cross-reference against
  // Sonarr's season/episode list by (ParentIndexNumber, IndexNumber).
  // Overview added on top of the original field list — Cinema Mode's episode browser needs a
  // per-episode synopsis and this is the only call that already returns the full episode list;
  // additive field, no effect on existing callers that don't read it.
  getSeriesEpisodes: async (userId: string, seriesId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Shows/${idSegment(seriesId)}/Episodes?userId=${idSegment(userId)}&Fields=ProviderIds,UserData,ImageTags,RunTimeTicks,IndexNumber,ParentIndexNumber,Overview`,
      { headers }
    ).then((res) => res.Items),

  // Jellyfin's own "what to watch next" for a series: the in-progress episode
  // if one exists, otherwise the next unwatched one after the last played —
  // exactly the Netflix-style "Lire"/"Reprendre" logic for a series' main
  // play button, without reimplementing it ourselves.
  getNextUp: async (userId: string, seriesId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Shows/NextUp?SeriesId=${idSegment(seriesId)}&UserId=${idSegment(userId)}&Limit=1&Fields=UserData,ImageTags,RunTimeTicks,IndexNumber,ParentIndexNumber`,
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
  getUsers: () => fetchJson<JellyfinUser[]>(`${cfg.url}/Users`, { headers }),

  /**
   * Les appareils autorisés — un par jeton. Pour la page d'activité : un compte dont l'appareil de
   * l'application ne bouge plus alors qu'il s'en sert a perdu son jeton (voir `jellyfinToken.ts`).
   */
  /**
   * Supprimer un appareil — et le jeton qui lui est attaché : chez Jellyfin, un appareil inscrit
   * est un jeton. Avec la clé d'administration, sur l'identifiant que la connexion a choisi
   * (`cine-app-<aléatoire>`) : seul le jeton de cette connexion-là tombe, jamais ceux des autres
   * applications de la personne.
   */
  deleteDevice: (deviceId: string) =>
    fetchJson<void>(`${cfg.url}/Devices?id=${encodeURIComponent(deviceId)}`, { method: "DELETE", headers }, 5000, undefined, 0),

  /** Fermer la session d'un jeton, avec ce jeton : il cesse d'être accepté. */
  logoutToken: (token: string) =>
    fetchJson<void>(`${cfg.url}/Sessions/Logout`, { method: "POST", headers: jellyfinAuthHeaders(token) }, 5000, undefined, 0),

  getDevices: () => fetchJson<{ Items: JellyfinDevice[] }>(`${cfg.url}/Devices`, { headers }).then((res) => res.Items ?? []),

  /**
   * Quand le compte a lu un épisode de cette série pour la dernière fois — la date d'un épisode
   * d'« À suivre » jamais ouvert, pour l'ordre de « Reprendre » (`continueOrder`). Jellyfin ne date pas
   * la série elle-même (`LastPlayedDate` absent, vérifié le 28/09/2026).
   */
  getSeriesLastPlayed: async (userId: string, seriesId: string) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items?ParentId=${idSegment(seriesId)}&IncludeItemTypes=Episode&Recursive=true&SortBy=DatePlayed&SortOrder=Descending&Limit=1&Fields=UserData`,
      { headers }
    ).then((res) => res.Items[0]?.UserData?.LastPlayedDate ?? null),

  getNextUpGlobal: async (userId: string, limit = 10) =>
    fetchJson<{ Items: JellyfinItem[] }>(
      `${cfg.url}/Shows/NextUp?UserId=${idSegment(userId)}&Limit=${limit}&Fields=UserData,ImageTags,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeriesId,DateCreated`,
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
  getItemMediaSources: async (userId: string, itemId: string) =>
    fetchJson<{
      Name?: string;
      RunTimeTicks?: number;
      UserData?: JellyfinItem["UserData"];
      MediaSources?: JellyfinMediaSource[];
    }>(`${cfg.url}/Users/${idSegment(userId)}/Items/${idSegment(itemId)}?Fields=MediaSources,UserData,RunTimeTicks`, { headers }),

  getItemUserData: async (userId: string, itemId: string) =>
    fetchJson<{ UserData?: JellyfinItem["UserData"]; RunTimeTicks?: number }>(
      `${cfg.url}/Users/${idSegment(userId)}/Items/${idSegment(itemId)}?Fields=UserData,RunTimeTicks`,
      { headers }
    ),

  /**
   * Le générique d'ouverture et celui de fin d'un épisode — « Passer l'intro », « Épisode suivant ».
   *
   * Lus dans les segments de Jellyfin (`/MediaSegments`), où Jellyfin 12 et Intro Skipper 12 les
   * rangent. L'ancienne adresse du greffon (`/Episode/{id}/Timestamps`) répond 404 pour tous les
   * épisodes depuis la montée de version : aucune intro à passer, aucune carte « épisode suivant »,
   * et un lecteur figé sur la dernière image en fin d'épisode (relevé le 23/09/2026). Elle reste en
   * repli, pour un serveur qui n'aurait que l'ancien greffon. Un échec vaut « pas de repères ».
   */
  getEpisodeTimestamps: async (itemId: string): Promise<EpisodeTimestamps | null> => {
    const segments = await fetchJson<{ Items?: MediaSegment[] }>(`${cfg.url}/MediaSegments/${idSegment(itemId)}`, { headers }).catch(
      () => null
    );
    if (segments?.Items) return timestampsFromSegments(segments.Items);
    return fetchJson<EpisodeTimestamps>(`${cfg.url}/Episode/${idSegment(itemId)}/Timestamps`, { headers });
  },
};

export interface EpisodeTimestamps {
  Introduction?: { Start: number; End: number; Valid: boolean };
  Credits?: { Start: number; End: number; Valid: boolean };
}

export interface MediaSegment {
  Type: string;
  StartTicks: number;
  EndTicks: number;
}

/** Un segment plus court que ça n'est pas un générique : « Intro 3 s – 3 s » existe bel et bien. */
const MIN_SEGMENT_S = 5;
/**
 * Un générique de fin qui commence dans la première minute est une erreur d'analyse — vu sur
 * *Bref* : « Outro 3 s – 129 s » à côté du vrai, à 115 s. Pris tel quel, il lançait l'épisode
 * suivant au bout de trois secondes.
 */
const MIN_CREDITS_START_S = 60;

/** Les segments de Jellyfin, ramenés à la forme qu'attend le lecteur (secondes). */
export function timestampsFromSegments(items: MediaSegment[]): EpisodeTimestamps {
  const spans = items
    .map((s) => ({ type: s.Type, start: s.StartTicks / 10_000_000, end: s.EndTicks / 10_000_000 }))
    .filter((s) => s.end - s.start >= MIN_SEGMENT_S)
    .sort((a, b) => a.start - b.start);
  const intro = spans.find((s) => s.type === "Intro");
  const credits = spans.find((s) => s.type === "Outro" && s.start >= MIN_CREDITS_START_S);
  return {
    ...(intro ? { Introduction: { Start: intro.start, End: intro.end, Valid: true } } : {}),
    ...(credits ? { Credits: { Start: credits.start, End: credits.end, Valid: true } } : {}),
  };
}
