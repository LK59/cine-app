/**
 * Un kit Cast de Google simulé — DECISIONS.md §64. Aucun récepteur n'est là pour éprouver le
 * Chromecast : ce double reproduit les surfaces que `src/lib/chromecast/framework.ts` déclare, avec
 * les valeurs que le vrai kit emploie (`caststatechanged`, `NO_DEVICES_AVAILABLE`, `FINISHED`…), et
 * garde la trace de ce qu'on lui a demandé.
 */
import type { CastGlobals, RemotePlayerState } from "@/lib/chromecast/framework";

type Handler = (event: { castState?: string; sessionState?: string }) => void;

export interface FakeCast {
  globals: CastGlobals;
  /** Pose `window.cast` et `window.chrome.cast`, comme le script de Google une fois chargé. */
  install(): void;
  setCastState(state: string): void;
  /** Ouvre une session vers ce récepteur (ce que fait un choix dans la liste de Chrome). */
  connect(name?: string): void;
  /** La session se ferme de l'extérieur (télé éteinte, arrêt depuis un autre appareil). */
  disconnect(): void;
  /** Le récepteur passe à l'arrêt, pour cette raison (`FINISHED`, `ERROR`, `CANCELLED`). */
  idle(reason: string): void;
  /** Le récepteur joue, à cette position. */
  play(currentTime: number, duration?: number): void;
  requestSession: { next: () => Promise<unknown> };
  loads: Record<string, unknown>[];
  editedTracks: number[][];
  ended: boolean[];
  options: Record<string, unknown>[];
  player: RemotePlayerState;
  controllerCalls: string[];
}

export function createFakeCast(): FakeCast {
  const contextHandlers = new Map<string, Set<Handler>>();
  const controllerHandlers = new Map<string, Set<() => void>>();
  let castState = "NOT_CONNECTED";
  let session: ReturnType<typeof makeSession> | null = null;
  let idleReason: string | null = null;
  const loads: Record<string, unknown>[] = [];
  const editedTracks: number[][] = [];
  const ended: boolean[] = [];
  const options: Record<string, unknown>[] = [];
  const controllerCalls: string[] = [];
  const player: RemotePlayerState = {
    isConnected: false,
    isMediaLoaded: false,
    currentTime: 0,
    duration: 0,
    isPaused: false,
    playerState: null,
    volumeLevel: 1,
    isMuted: false,
  };

  const fireContext = (type: string, event: { castState?: string; sessionState?: string }) => {
    for (const h of contextHandlers.get(type) ?? []) h(event);
  };
  const fireController = (...types: string[]) => {
    for (const type of types) for (const h of controllerHandlers.get(type) ?? []) h();
  };

  function makeSession(name: string) {
    const media = {
      get idleReason() {
        return idleReason;
      },
      playerState: "PLAYING",
      editTracksInfo(request: unknown, ok: () => void) {
        editedTracks.push((request as { activeTrackIds: number[] }).activeTrackIds);
        ok();
      },
      addUpdateListener() {},
      removeUpdateListener() {},
    };
    return {
      getCastDevice: () => ({ friendlyName: name }),
      loadMedia: async (request: unknown) => {
        loads.push(request as Record<string, unknown>);
        idleReason = null;
        return undefined;
      },
      getMediaSession: () => media,
      endSession: (stop: boolean) => {
        ended.push(stop);
      },
    };
  }

  class MediaInfo {
    [key: string]: unknown;
    constructor(
      public contentId: string,
      public contentType: string
    ) {}
  }
  class GenericMediaMetadata {
    [key: string]: unknown;
  }
  class Track {
    [key: string]: unknown;
    constructor(
      public trackId: number,
      public type: string
    ) {}
  }
  class LoadRequest {
    [key: string]: unknown;
    constructor(public media: unknown) {}
  }
  class EditTracksInfoRequest {
    constructor(public activeTrackIds: number[]) {}
  }

  const context = {
    setOptions: (o: Record<string, unknown>) => options.push(o),
    addEventListener: (type: string, h: Handler) => {
      if (!contextHandlers.has(type)) contextHandlers.set(type, new Set());
      contextHandlers.get(type)!.add(h);
    },
    removeEventListener: (type: string, h: Handler) => contextHandlers.get(type)?.delete(h),
    getCastState: () => castState,
    getCurrentSession: () => session,
    requestSession: () => requestSession.next(),
    endCurrentSession: (stop: boolean) => {
      ended.push(stop);
      fake.disconnect();
    },
  };

  const requestSession = {
    next: async (): Promise<unknown> => {
      fake.connect();
      return undefined;
    },
  };

  const globals: CastGlobals = {
    framework: {
      CastContext: { getInstance: () => context },
      RemotePlayer: function RemotePlayer() {
        return player;
      } as unknown as new () => RemotePlayerState,
      RemotePlayerController: function RemotePlayerController() {
        return {
          addEventListener: (type: string, h: () => void) => {
            if (!controllerHandlers.has(type)) controllerHandlers.set(type, new Set());
            controllerHandlers.get(type)!.add(h);
          },
          removeEventListener: (type: string, h: () => void) => controllerHandlers.get(type)?.delete(h),
          playOrPause: () => controllerCalls.push("playOrPause"),
          stop: () => controllerCalls.push("stop"),
          seek: () => controllerCalls.push(`seek:${player.currentTime}`),
          setVolumeLevel: () => controllerCalls.push(`volume:${player.volumeLevel}`),
          muteOrUnmute: () => controllerCalls.push("mute"),
        };
      } as unknown as CastGlobals["framework"]["RemotePlayerController"],
      CastContextEventType: { CAST_STATE_CHANGED: "caststatechanged", SESSION_STATE_CHANGED: "sessionstatechanged" },
      RemotePlayerEventType: {
        ANY_CHANGE: "anyChanged",
        IS_CONNECTED_CHANGED: "isConnectedChanged",
        PLAYER_STATE_CHANGED: "playerStateChanged",
        CURRENT_TIME_CHANGED: "currentTimeChanged",
      },
      CastState: { NO_DEVICES_AVAILABLE: "NO_DEVICES_AVAILABLE", NOT_CONNECTED: "NOT_CONNECTED", CONNECTING: "CONNECTING", CONNECTED: "CONNECTED" },
      SessionState: { SESSION_STARTED: "SESSION_STARTED", SESSION_ENDED: "SESSION_ENDED" },
    },
    chromeCast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: "origin_scoped" },
      media: {
        MediaInfo: MediaInfo as unknown as CastGlobals["chromeCast"]["media"]["MediaInfo"],
        GenericMediaMetadata: GenericMediaMetadata as unknown as CastGlobals["chromeCast"]["media"]["GenericMediaMetadata"],
        Track: Track as unknown as CastGlobals["chromeCast"]["media"]["Track"],
        LoadRequest: LoadRequest as unknown as CastGlobals["chromeCast"]["media"]["LoadRequest"],
        EditTracksInfoRequest,
        StreamType: { BUFFERED: "BUFFERED" },
        TrackType: { TEXT: "TEXT" },
        TextTrackType: { SUBTITLES: "SUBTITLES" },
        HlsSegmentFormat: { FMP4: "fmp4" },
        HlsVideoSegmentFormat: { FMP4: "fmp4" },
        IdleReason: { FINISHED: "FINISHED", CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED", ERROR: "ERROR" },
      },
    },
  };

  const fake: FakeCast = {
    globals,
    install() {
      const w = window as unknown as { cast?: unknown; chrome?: unknown };
      w.cast = { framework: globals.framework };
      w.chrome = { cast: globals.chromeCast };
    },
    setCastState(state) {
      castState = state;
      fireContext("caststatechanged", { castState: state });
    },
    connect(name = "Salon") {
      session = makeSession(name);
      player.isConnected = true;
      fake.setCastState("CONNECTED");
      fireContext("sessionstatechanged", { sessionState: "SESSION_STARTED" });
      fireController("isConnectedChanged", "anyChanged");
    },
    disconnect() {
      if (!session) return;
      session = null;
      player.isConnected = false;
      player.isMediaLoaded = false;
      fake.setCastState("NOT_CONNECTED");
      fireContext("sessionstatechanged", { sessionState: "SESSION_ENDED" });
      fireController("isConnectedChanged", "anyChanged");
    },
    idle(reason) {
      idleReason = reason;
      player.playerState = "IDLE";
      fireController("playerStateChanged", "anyChanged");
    },
    play(currentTime, duration = 3600) {
      player.isMediaLoaded = true;
      player.currentTime = currentTime;
      player.duration = duration;
      player.playerState = "PLAYING";
      player.isPaused = false;
      fireController("playerStateChanged", "anyChanged");
    },
    requestSession,
    loads,
    editedTracks,
    ended,
    options,
    player,
    controllerCalls,
  };
  return fake;
}
