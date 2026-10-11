/**
 * Le kit d'émission de Google (Cast Web Sender), chargé à la demande — DECISIONS.md §64.
 *
 * Rien ici ne se charge tant qu'une page ne le demande pas (`startChromecastSender`), et elle ne le
 * demande que là où une diffusion est possible (`chromecastSenderEligible`) et pour qui y a droit :
 * ni l'iPhone, ni Safari, ni la Fire TV ne téléchargent quoi que ce soit, et une installation dont
 * personne ne diffuse ne parle jamais à Google.
 *
 * Les types du kit sont écrits ici, réduits à ce qu'on en emploie, plutôt que tirés d'un paquet de
 * définitions : ce sont les seules surfaces que les tests doublent (`chromecast-*.test.ts`), et la
 * liste dit d'un coup d'œil de quoi ce code dépend chez Google.
 *
 * Un seul état partagé pour toute la page — disponibilité des récepteurs, session en cours, nom de
 * l'appareil — lu par `useSyncExternalStore` (`useChromecast.ts`). Deux lecteurs qui écouteraient
 * le kit chacun de leur côté finiraient par ne plus s'accorder sur « est-on en train de diffuser ».
 */

import { DEFAULT_MEDIA_RECEIVER_APP_ID, receiverAppIdOf } from "./receiverAppId";

/** L'adresse du kit, celle que Google documente — autorisée par la CSP (`next.config.js`). */
export const CAST_SENDER_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
/** Au-delà, le kit est tenu pour absent : réseau bloqué, extension, navigateur qui ne répond pas. */
export const CAST_LOAD_TIMEOUT_MS = 10_000;

// ── Les surfaces du kit qu'on emploie ─────────────────────────────────────────────────────────

export interface CastDevice {
  friendlyName?: string;
}

export interface CastMediaSession {
  idleReason?: string | null;
  playerState?: string;
  editTracksInfo(request: unknown, onSuccess: () => void, onError: (error: unknown) => void): void;
  addUpdateListener(listener: (isAlive: boolean) => void): void;
  removeUpdateListener(listener: (isAlive: boolean) => void): void;
}

export interface CastSession {
  getCastDevice(): CastDevice | null | undefined;
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMediaSession | null | undefined;
  endSession(stopCasting: boolean): void;
}

export interface CastContext {
  setOptions(options: Record<string, unknown>): void;
  addEventListener(type: string, handler: (event: { castState?: string; sessionState?: string }) => void): void;
  removeEventListener(type: string, handler: (event: { castState?: string; sessionState?: string }) => void): void;
  getCastState(): string;
  getCurrentSession(): CastSession | null;
  requestSession(): Promise<unknown>;
  endCurrentSession(stopCasting: boolean): void;
}

export interface RemotePlayerState {
  isConnected: boolean;
  isMediaLoaded: boolean;
  currentTime: number;
  duration: number;
  isPaused: boolean;
  playerState: string | null;
  volumeLevel: number;
  isMuted: boolean;
}

export interface RemotePlayerController {
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
  playOrPause(): void;
  stop(): void;
  seek(): void;
  setVolumeLevel(): void;
  muteOrUnmute(): void;
}

/** `window.cast.framework` et `window.chrome.cast`, tels que le kit les pose. */
export interface CastGlobals {
  framework: {
    CastContext: { getInstance(): CastContext };
    RemotePlayer: new () => RemotePlayerState;
    RemotePlayerController: new (player: RemotePlayerState) => RemotePlayerController;
    CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
    RemotePlayerEventType: Record<string, string>;
    CastState: { NO_DEVICES_AVAILABLE: string; NOT_CONNECTED: string; CONNECTING: string; CONNECTED: string };
    SessionState: Record<string, string>;
  };
  chromeCast: {
    AutoJoinPolicy: { ORIGIN_SCOPED: string };
    media: {
      MediaInfo: new (contentId: string, contentType: string) => Record<string, unknown>;
      GenericMediaMetadata: new () => Record<string, unknown>;
      Track: new (trackId: number, trackType: string) => Record<string, unknown>;
      LoadRequest: new (mediaInfo: unknown) => Record<string, unknown>;
      EditTracksInfoRequest: new (activeTrackIds: number[]) => unknown;
      StreamType: { BUFFERED: string };
      TrackType: { TEXT: string };
      TextTrackType: { SUBTITLES: string };
      HlsSegmentFormat?: { FMP4: string };
      HlsVideoSegmentFormat?: { FMP4: string };
      IdleReason: { FINISHED: string; CANCELLED: string; INTERRUPTED: string; ERROR: string };
    };
  };
}

type CastWindow = Window & {
  cast?: { framework?: CastGlobals["framework"] };
  chrome?: { cast?: CastGlobals["chromeCast"] };
  __onGCastApiAvailable?: (available: boolean, reason?: unknown) => void;
};

// ── L'état partagé ─────────────────────────────────────────────────────────────────────────────

/** Ce que la page sait du Chromecast à cet instant. */
export interface ChromecastSnapshot {
  /** `off` : rien demandé ; `loading` ; `unavailable` : le kit n'a pas répondu ; sinon prêt. */
  phase: "off" | "loading" | "unavailable" | "ready";
  /** Au moins un récepteur sur le réseau — le bouton n'apparaît qu'à cette condition. */
  devices: boolean;
  /** Une session s'ouvre (choix fait dans la liste de Chrome, récepteur qui démarre). */
  connecting: boolean;
  /** Une session est ouverte. */
  connected: boolean;
  /** Le nom du récepteur, tel qu'il se présente (« Salon »). */
  device: string | null;
}

const OFF: ChromecastSnapshot = { phase: "off", devices: false, connecting: false, connected: false, device: null };
let snapshot: ChromecastSnapshot = OFF;
const listeners = new Set<() => void>();
let globals: CastGlobals | null = null;
let starting: Promise<boolean> | null = null;

function publish(next: Partial<ChromecastSnapshot>): void {
  const merged = { ...snapshot, ...next };
  if (
    merged.phase === snapshot.phase &&
    merged.devices === snapshot.devices &&
    merged.connecting === snapshot.connecting &&
    merged.connected === snapshot.connected &&
    merged.device === snapshot.device
  ) {
    return;
  }
  snapshot = merged;
  for (const listener of listeners) listener();
}

export function chromecastSnapshot(): ChromecastSnapshot {
  return snapshot;
}

export function chromecastServerSnapshot(): ChromecastSnapshot {
  return OFF;
}

export function subscribeChromecast(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Le kit, une fois chargé — pour le lecteur qui pilote la session. `null` avant, ou sans kit. */
export function chromecastGlobals(): CastGlobals | null {
  return globals;
}

/** La session ouverte, s'il y en a une. Ne lève jamais. */
export function currentChromecastSession(): CastSession | null {
  try {
    return globals?.framework.CastContext.getInstance().getCurrentSession() ?? null;
  } catch {
    return null;
  }
}

function deviceName(session: CastSession | null): string | null {
  try {
    return session?.getCastDevice()?.friendlyName?.trim() || null;
  } catch {
    return null;
  }
}

// ── Le chargement ──────────────────────────────────────────────────────────────────────────────

/** Les objets du kit, s'ils sont déjà posés sur la page. */
function readGlobals(w: CastWindow): CastGlobals | null {
  const framework = w.cast?.framework;
  const chromeCast = w.chrome?.cast;
  return framework && chromeCast?.media ? { framework, chromeCast } : null;
}

/** Charge le script de Google une fois. Résout `null` s'il ne répond pas — jamais d'exception. */
function loadScript(w: CastWindow, timeoutMs: number): Promise<CastGlobals | null> {
  const present = readGlobals(w);
  if (present) return Promise.resolve(present);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: CastGlobals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    // Le kit appelle cette fonction quand il est prêt — ou qu'il renonce (navigateur sans routeur
    // de médias). Une fonction déjà posée par quelqu'un d'autre est appelée aussi.
    const previous = w.__onGCastApiAvailable;
    w.__onGCastApiAvailable = (available, reason) => {
      try {
        previous?.(available, reason);
      } catch {
        // Le voisin ne doit pas empêcher la réponse.
      }
      settle(available ? readGlobals(w) : null);
    };
    const script = w.document.createElement("script");
    script.src = CAST_SENDER_URL;
    script.async = true;
    script.onerror = () => settle(null);
    w.document.head.appendChild(script);
  });
}

/** Ce que l'installation répond pour ce compte (`/api/player/cast`). */
export interface ChromecastConfig {
  allowed: boolean;
  receiverAppId: string;
}

let configAsked: Promise<ChromecastConfig> | null = null;

/**
 * La réponse de l'installation, demandée une fois par page — par `fetch` et non par SWR : un film
 * qui prend l'écran met SWR en pause, et une question abandonnée laisserait le bouton absent pour
 * toute la séance. Un échec n'est pas retenu : le lecteur suivant redemandera. Prudent en cas
 * d'échec : pas de bouton, récepteur de Google.
 */
export function chromecastConfig(): Promise<ChromecastConfig> {
  if (configAsked) return configAsked;
  const asked = (async (): Promise<ChromecastConfig> => {
    try {
      const res = await fetch("/api/player/cast", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { allowed?: unknown; receiverAppId?: unknown };
      return {
        allowed: body.allowed === true,
        receiverAppId: receiverAppIdOf(typeof body.receiverAppId === "string" ? body.receiverAppId : null),
      };
    } catch {
      configAsked = null;
      return { allowed: false, receiverAppId: DEFAULT_MEDIA_RECEIVER_APP_ID };
    }
  })();
  configAsked = asked;
  return asked;
}

async function receiverAppId(): Promise<string> {
  return (await chromecastConfig()).receiverAppId;
}

/**
 * Charge le kit, l'initialise et suit l'état des récepteurs. Une seule fois par page ; un échec
 * (kit absent, délai dépassé) peut être retenté par le montage suivant d'un lecteur.
 */
export function startChromecastSender(timeoutMs = CAST_LOAD_TIMEOUT_MS): Promise<boolean> {
  if (starting) return starting;
  if (typeof window === "undefined") return Promise.resolve(false);
  publish({ phase: "loading" });
  starting = (async () => {
    const [loaded, appId] = await Promise.all([loadScript(window as CastWindow, timeoutMs), receiverAppId()]);
    if (!loaded) {
      publish({ ...OFF, phase: "unavailable" });
      starting = null;
      return false;
    }
    try {
      const { framework, chromeCast } = loaded;
      const context = framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: appId,
        // Une session ouverte depuis un autre onglet du même site est reprise ; jamais celle d'une
        // autre application.
        autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      const readState = () => {
        const state = context.getCastState();
        const session = context.getCurrentSession();
        publish({
          phase: "ready",
          devices: state !== framework.CastState.NO_DEVICES_AVAILABLE,
          connecting: state === framework.CastState.CONNECTING,
          connected: state === framework.CastState.CONNECTED,
          device: state === framework.CastState.CONNECTED ? deviceName(session) : null,
        });
      };
      context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, readState);
      context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, readState);
      globals = loaded;
      readState();
      return true;
    } catch {
      publish({ ...OFF, phase: "unavailable" });
      starting = null;
      return false;
    }
  })();
  return starting;
}

/** Le résultat d'une demande de session : ouverte, ou le code d'erreur du kit (`cancel` compris). */
export type ChromecastSessionResult = { ok: true; device: string | null } | { ok: false; code: string };

/**
 * Ouvre la liste des récepteurs de Chrome et attend le choix.
 *
 * **À appeler dans le geste même**, avant tout `await` : Chrome refuse d'ouvrir sa liste hors d'un
 * appui. Le kit résout sans valeur quand la session est ouverte, et rejette avec un code
 * (`cancel` quand on ferme la liste, `receiver_unavailable`, `session_error`…).
 */
export function requestChromecastSession(): Promise<ChromecastSessionResult> {
  const context = (() => {
    try {
      return globals?.framework.CastContext.getInstance() ?? null;
    } catch {
      return null;
    }
  })();
  if (!context) return Promise.resolve({ ok: false, code: "api_not_initialized" });
  let pending: Promise<unknown>;
  try {
    pending = context.requestSession();
  } catch (error) {
    return Promise.resolve({ ok: false, code: errorCode(error) });
  }
  return pending.then(
    (code) => {
      // Certaines versions du kit résolvent avec un code au lieu de rejeter.
      if (typeof code === "string" && code) return { ok: false as const, code };
      return { ok: true as const, device: deviceName(context.getCurrentSession()) };
    },
    (error: unknown) => ({ ok: false as const, code: errorCode(error) })
  );
}

/** Ferme la session ; `stopReceiver` arrête aussi l'application sur le téléviseur. Ne lève jamais. */
export function endChromecastSession(stopReceiver: boolean): void {
  try {
    globals?.framework.CastContext.getInstance().endCurrentSession(stopReceiver);
  } catch {
    // Déjà fermée.
  }
}

/** Le code d'une erreur du kit : une chaîne, ou un objet `chrome.cast.Error` portant `code`. */
export function errorCode(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "unknown";
}

/** Remet le module à zéro — tests seulement. */
export function resetChromecastForTests(): void {
  snapshot = OFF;
  listeners.clear();
  globals = null;
  starting = null;
  configAsked = null;
}
