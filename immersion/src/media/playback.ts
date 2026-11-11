import { loadSubtitles } from "./subtitles";
import type Hls from "hls.js";
import { IDLE_PLAYBACK, useStore } from "../state/store";
import { SessionExpired } from "../lib/session";
import { isHdrFile, isHdrRange, negotiate, PlaybackRefused, reportProgress, reportStop, resumePosition, type Negotiation, type NegotiateOptions, type ReportTarget } from "./api";
import { logLine, newLogSession } from "./log";
import { applyMix, connectVideo } from "./audio";

/**
 * La lecture sur la télévision du chalet.
 *
 * Un seul élément `<video>`, jamais affiché, pour toute la visite : son image devient la texture de
 * l'écran (`Television`), sa piste entre dans le graphe audio (`audio.ts`) — ce qui ne peut se faire
 * qu'une fois par élément, d'où l'élément unique. `crossOrigin="anonymous"` est posé avant toute
 * source : le flux vient de la même origine (`/api/jellyfin/stream/…`), donc la texture reste
 * lisible et le son exploitable.
 *
 * Le parcours est celui du lecteur serveur de Laterna : négociation par la route, puis le fichier
 * tel quel (DirectPlay) ou un flux HLS lu par hls.js (DirectStream, Transcode). Trois partis pris
 * propres au chalet :
 * - le son est demandé en **stéréo au plus** (`api.ts`) : il sort d'une seule source, la télévision ;
 * - une image **HDR est convertie en SDR par le serveur**, par défaut (réglage `hdrToSdr`) — dans une
 *   texture WebGL elle sortirait délavée ; une image SDR n'est jamais transcodée pour ça ;
 * - **chaque sortie annonce l'arrêt** à Jellyfin (changement de film, fin, erreur, « Quitter »,
 *   fermeture de l'onglet) : c'est ce qui coupe le transcodage. Un flux abandonné sans arrêt laisse
 *   un ffmpeg tourner pour personne.
 *
 * Une erreur de décodage fait descendre d'un échelon — l'image en H.264 — avant d'abandonner.
 */
const HLS_CONFIG = { backBufferLength: 90, maxBufferLength: 30, maxMaxBufferLength: 90 } as const;
const PROGRESS_EVERY_MS = 10_000;
const MAX_NETWORK_RETRIES = 6;
const MAX_MEDIA_RECOVERIES = 2;

/** Les échelons de repli, dans l'ordre. Le son est déjà ré-encodé en stéréo dès le premier. */
const LADDER: NegotiateOptions[] = [{}, { videoH264Only: true }];

/** Pourquoi une lecture s'arrête — le `why` de sa ligne `stop`. */
type StopWhy = "close" | "next" | "page" | "ended" | "error";

interface Item {
  id: string;
  title: string;
}

let video: HTMLVideoElement | null = null;
let hls: Hls | null = null;
let target: ReportTarget | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
/** Chaque nouvelle lecture invalide les rappels de la précédente. */
let generation = 0;
let current: { item: Item; rung: number; audio: number | null; subtitle: number | null } | null = null;
let lastPosition = 0;
let lastPaint = 0;
/** Ce que la séance en cours a regardé : pour le bilan de sa ligne `stop`. */
let watch = { since: 0, seconds: 0 };

/**
 * La fin d'une séance, en un seul endroit : l'arrêt annoncé à Jellyfin (qui coupe le transcodage) et
 * la ligne `stop` du journal. Rien si aucune séance n'est ouverte — on peut l'appeler sans crainte.
 */
function finish(why: StopWhy, lastGasp = false): void {
  const ending = target;
  if (!ending) return;
  target = null;
  const at = video && Number.isFinite(video.currentTime) ? video.currentTime : lastPosition;
  if (watch.since) watch.seconds += (performance.now() - watch.since) / 1000;
  watch.since = 0;
  reportStop(ending, why === "ended" && video && Number.isFinite(video.duration) ? video.duration : at);
  logLine("stop", { itemId: ending.itemId, title: useStore.getState().playback.title, why, at: Math.round(at), watched: Math.round(watch.seconds) }, lastGasp);
}

const set = (patch: Parameters<ReturnType<typeof useStore.getState>["setPlayback"]>[0]) => useStore.getState().setPlayback(patch);

function sendProgress() {
  if (target && video) reportProgress(target, video.currentTime, video.paused);
}

/** L'élément vidéo de la visite, créé à la première demande. */
export function getVideo(): HTMLVideoElement {
  if (video) return video;
  const el = document.createElement("video");
  el.crossOrigin = "anonymous";
  el.playsInline = true;
  // Sur iPhone, le flux passe par ManagedMediaSource, que Safari n'ouvre que si la diffusion vers un autre
  // appareil est coupée sur l'élément (il n'est de toute façon jamais montré : son image est une texture).
  el.disableRemotePlayback = true;
  el.preload = "auto";
  el.addEventListener("playing", () => {
    if (!watch.since) watch.since = performance.now();
    set({ status: "playing", waiting: false, error: null });
  });
  el.addEventListener("pause", () => {
    if (watch.since) watch.seconds += (performance.now() - watch.since) / 1000;
    watch.since = 0;
    if (!el.ended && useStore.getState().playback.status === "playing") set({ status: "paused" });
    sendProgress();
  });
  el.addEventListener("waiting", () => set({ waiting: true }));
  el.addEventListener("canplay", () => set({ waiting: false }));
  el.addEventListener("seeked", sendProgress);
  el.addEventListener("durationchange", () => Number.isFinite(el.duration) && set({ duration: el.duration }));
  el.addEventListener("timeupdate", () => {
    lastPosition = el.currentTime;
    const now = performance.now();
    // Deux fois par seconde suffisent à une barre de progression.
    if (now - lastPaint < 450) return;
    lastPaint = now;
    set({ position: el.currentTime });
  });
  el.addEventListener("ended", () => {
    finish("ended");
    release();
    set({ status: "ended", position: el.duration || lastPosition });
  });
  el.addEventListener("error", () => {
    // Avec hls.js, les erreurs passent par lui ; celle-ci ne compte que pour un fichier lu tel quel.
    if (!hls && current && el.error) void descend(`erreur du lecteur (${el.error.code})`);
  });
  video = el;
  ensureFollowing();
  return el;
}

/** Détache le flux en cours. L'arrêt, lui, est annoncé par `finish` — toujours avant. */
function release() {
  if (beat) clearInterval(beat);
  beat = null;
  if (hls) {
    try {
      hls.destroy();
    } catch {
      // Déjà détruit.
    }
    hls = null;
  }
}

function unload() {
  if (!video) return;
  video.pause();
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
}

/** Applique volume, silence et spatialisation des réglages au graphe audio. */
export function syncMix(): void {
  const state = useStore.getState();
  applyMix({ volume: state.settings.volume, muted: state.playback.muted, spatial: state.settings.spatial, reverb: state.settings.reverb });
}

/** L'ouverture suivante reste en pause une fois prête (la télévision commune d'un salon : `net/tv.ts`). */
let nextOpenPaused = false;

async function start(item: Item, rung: number, from: number | null, cause: "open" | "ladder" | "audio" = "open", audio: number | null = null, subtitle: number | null = null) {
  const mine = ++generation;
  const startPaused = cause === "open" && nextOpenPaused;
  nextOpenPaused = false;
  const el = getVideo();
  // Un autre titre jouait : sa séance se referme d'abord.
  finish(cause === "ladder" ? "error" : "next");
  release();
  unload();
  current = { item, rung, audio, subtitle };
  watch = { since: 0, seconds: 0 };
  void loadSubtitles(null);
  // Le même titre renégocié (autre piste audio, échelon plus bas) garde ce qu'on sait de lui : ses repères et
  // l'épisode qui le suit ne changent pas, et `upNext` ne les redemande qu'à un nouveau titre.
  const before = useStore.getState().playback;
  const same = before.itemId === item.id;
  set({ ...IDLE_PLAYBACK, muted: before.muted, status: "loading", itemId: item.id, title: item.title, audioIndex: audio, ...(same ? { markers: before.markers, next: before.next } : {}) });

  /** Referme une séance que la négociation vient d'ouvrir chez Jellyfin et dont on ne veut plus. */
  const abandon = (n: Negotiation, at: number) =>
    reportStop({ itemId: item.id, playSessionId: n.playSessionId, mediaSourceId: n.mediaSourceId, playMethod: n.playbackInfo.playMethod }, at);

  try {
    connectVideo(el);
    syncMix();
    const convert = useStore.getState().settings.hdrToSdr;
    const [resumeAt, hdr] = await Promise.all([from ?? resumePosition(item.id), convert ? isHdrFile(item.id) : Promise.resolve(false)]);
    if (mine !== generation) return;
    let sdr = hdr === true;
    const wanted = audio !== null ? { audioStreamIndex: audio } : {};
    let negotiation = await negotiate(item.id, { ...LADDER[rung], ...wanted, resumeAt, sdr });
    // La question « ce fichier est-il HDR ? » est restée sans réponse : la négociation la donne. Une
    // image HDR est alors redemandée en SDR — la première séance est refermée, jamais abandonnée.
    if (convert && !sdr && hdr === null && isHdrRange(negotiation.playbackInfo.video?.rangeType)) {
      abandon(negotiation, resumeAt);
      sdr = true;
      negotiation = await negotiate(item.id, { ...LADDER[rung], ...wanted, resumeAt, sdr });
    }
    if (mine !== generation) {
      // Une autre lecture a pris la place pendant la négociation : celle-ci est rendue tout de suite.
      abandon(negotiation, resumeAt);
      return;
    }
    target = { itemId: item.id, playSessionId: negotiation.playSessionId, mediaSourceId: negotiation.mediaSourceId, playMethod: negotiation.playbackInfo.playMethod };
    const info = negotiation.playbackInfo;
    set({
      title: negotiation.title ?? item.title,
      method: info.playMethod,
      audioTracks: negotiation.audioTracks ?? [],
      subtitleTracks: negotiation.subtitleTracks ?? [],
      markers: { intro: negotiation.introSkip ?? null, recap: negotiation.recapSkip ?? null, credits: negotiation.creditsStart ?? null },
    });
    // Les sous-titres choisis suivent un changement de piste audio ou d'échelon.
    if (subtitle !== null) chooseSubtitle(subtitle);
    if (cause === "open") newLogSession();
    logLine("start", {
      itemId: item.id,
      title: negotiation.title ?? item.title,
      why: cause,
      ...(cause === "ladder" ? { rung } : {}),
      path: "immersion",
      method: info.playMethod,
      reason: negotiation.isDirectPlay ? "fichier servi tel quel" : info.playMethod === "DirectStream" ? "image copiée, flux remultiplexé par le serveur" : "transcodé par le serveur",
      hls: negotiation.isDirectPlay ? "aucun" : "hls.js",
      at: Math.round(resumeAt),
      video: info.video?.codec ?? null,
      range: info.video?.rangeType ?? null,
      audio: "stéréo",
      // La conversion HDR → SDR par le serveur : le transcodage lourd, à pouvoir retrouver au journal.
      ...(sdr ? { sdr: "serveur" } : {}),
      ...(info.transcodeReasons?.length ? { transcodeReasons: info.transcodeReasons.join(",") } : {}),
    });

    if (negotiation.isDirectPlay) {
      el.src = negotiation.manifestUrl;
      if (resumeAt > 0) el.addEventListener("loadedmetadata", () => mine === generation && (el.currentTime = resumeAt), { once: true });
    } else {
      const { default: HlsClass } = await import("hls.js");
      if (mine !== generation) return;
      if (!HlsClass.isSupported()) throw new Error("Ce navigateur ne sait pas lire ce flux.");
      const instance = new HlsClass({ ...HLS_CONFIG, ...(resumeAt > 0 ? { startPosition: resumeAt } : {}) });
      hls = instance;
      let networkRetries = 0;
      let mediaRecoveries = 0;
      instance.on(HlsClass.Events.FRAG_BUFFERED, () => {
        networkRetries = 0;
      });
      instance.on(HlsClass.Events.ERROR, (_event, data) => {
        if (mine !== generation || !data.fatal) return;
        if (data.type === HlsClass.ErrorTypes.NETWORK_ERROR && networkRetries++ < MAX_NETWORK_RETRIES) {
          // Un transcodage qui démarre peut tarder à rendre son premier segment : on redemande, de plus en plus patiemment.
          setTimeout(() => mine === generation && instance.startLoad(), 800 * networkRetries);
          return;
        }
        if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < MAX_MEDIA_RECOVERIES) {
          instance.recoverMediaError();
          return;
        }
        void descend(data.details || "flux interrompu");
      });
      instance.loadSource(negotiation.manifestUrl);
      instance.attachMedia(el);
    }

    beat = setInterval(() => {
      if (video && !video.paused) sendProgress();
    }, PROGRESS_EVERY_MS);
    if (startPaused) {
      // Ouvert pour un départ commun : chargé, calé, en pause — le flux continue de se remplir. Le départ viendra du
      // salon (`net/tv.ts`).
      set({ wantPaused: true });
      el.addEventListener("canplay", () => mine === generation && useStore.getState().playback.status === "loading" && set({ status: "paused" }), { once: true });
      return;
    }
    await el.play().catch(() => {
      // Lecture refusée sans geste (ne devrait pas arriver : on vient d'un clic) : l'écran reste en pause.
      if (mine === generation) set({ status: "paused" });
    });
  } catch (error) {
    if (mine !== generation) return;
    // Une séance déjà ouverte chez Jellyfin se referme, quelle que soit la panne.
    finish("error");
    release();
    unload();
    current = null;
    if (error instanceof SessionExpired) return;
    const message = error instanceof PlaybackRefused ? error.message : error instanceof Error ? error.message : "Lecture impossible.";
    logLine("error", { itemId: item.id, title: item.title, message: message.slice(0, 200), stage: "ouverture" });
    set({ status: "error", error: message });
  }
}

/** Un échelon plus bas, à la position où l'on était ; au bout de l'échelle, l'erreur s'affiche. */
async function descend(why: string) {
  if (!current || !video) return;
  const { item, rung } = current;
  const at = video.currentTime || lastPosition;
  if (rung + 1 < LADDER.length) {
    console.warn(`[immersion] ${why} — nouvelle négociation (échelon ${rung + 1})`);
    await start(item, rung + 1, at, "ladder", current.audio, current.subtitle);
    return;
  }
  logLine("error", { itemId: item.id, title: item.title, message: why.slice(0, 200), position: Math.round(at) });
  finish("error");
  release();
  unload();
  current = null;
  set({ status: "error", error: why });
}

/**
 * Lance un titre de la bibliothèque. `from` : une position imposée ; sans elle, la reprise du compte.
 * N'est appelé que par les commandes (`commands.ts`).
 */
export function open(item: Item, from: number | null = null, paused = false): Promise<void> {
  nextOpenPaused = paused;
  return start(item, 0, from);
}

/**
 * Où en est l'élément, pour la télévision commune (`net/tv.ts`) : la position, combien de secondes sont chargées
 * devant, et s'il peut démarrer sans attendre.
 */
export function playbackClock(): { time: number; ahead: number; ready: boolean; ended: boolean } {
  const el = video;
  if (!el) return { time: 0, ahead: 0, ready: false, ended: false };
  let ahead = 0;
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= el.currentTime + 0.25 && el.buffered.end(i) > el.currentTime) ahead = el.buffered.end(i) - el.currentTime;
  }
  return { time: el.currentTime, ahead, ready: el.readyState >= 3, ended: el.ended };
}

/** La vitesse de lecture, pour rattraper doucement un décalage avec le salon (± 5 %, bornée). */
export function setPlaybackRate(rate: number): void {
  if (video) video.playbackRate = Math.min(1.1, Math.max(0.9, rate));
}

/**
 * Une autre piste audio : le serveur ne mélange qu'une piste dans le flux, il faut donc le lui redemander —
 * à la position où l'on est, avec les mêmes sous-titres.
 */
export function switchAudio(index: number): void {
  if (!current || !video) return;
  const at = Number.isFinite(video.currentTime) ? video.currentTime : lastPosition;
  void start(current.item, current.rung, at, "audio", index, current.subtitle);
}

/** Les sous-titres à lire (index Jellyfin), ou aucun. Une piste qui ne se lit pas en texte retombe sur « aucun ». */
export function chooseSubtitle(index: number | null): void {
  if (!current) return;
  const mine = current;
  const track = index === null ? null : (useStore.getState().playback.subtitleTracks.find((t) => t.index === index) ?? null);
  mine.subtitle = track ? track.index : null;
  set({ subtitleIndex: mine.subtitle });
  void loadSubtitles(track ? track.url : null).then((ok) => {
    if (!ok && current === mine && mine.subtitle === track?.index) {
      mine.subtitle = null;
      set({ subtitleIndex: null });
    }
  });
}

/**
 * Une vidéo quelconque sur l'écran, sans Jellyfin : pour les captures et les tests du rendu (image,
 * son, éclairage), qui n'ont pas à dépendre d'un film de la bibliothèque.
 */
export async function playTestClip(source: string | MediaStream): Promise<void> {
  generation++;
  const el = getVideo();
  finish("next");
  release();
  unload();
  current = null;
  connectVideo(el);
  syncMix();
  set({ ...IDLE_PLAYBACK, status: "loading", title: "Mire" });
  if (typeof source === "string") {
    el.src = source;
    el.loop = true;
  } else el.srcObject = source;
  await el.play().catch(() => set({ status: "paused" }));
}

/**
 * Le `<video>` suit l'état : en pause ou non, à la position demandée, muet ou non. C'est ici — et
 * nulle part ailleurs — que l'élément est commandé.
 */
let lastSeek = 0;
function follow(): void {
  const { playback } = useStore.getState();
  if (!video || (playback.status !== "playing" && playback.status !== "paused")) return;
  if (playback.seek && playback.seek.n !== lastSeek) {
    lastSeek = playback.seek.n;
    video.currentTime = playback.seek.to;
    set({ position: playback.seek.to });
  }
  if (playback.wantPaused && !video.paused) video.pause();
  else if (!playback.wantPaused && video.paused && !video.ended) void video.play().catch(() => set({ wantPaused: true }));
}

let following = false;
/** Branche le suivi (une fois) : chaque changement de ce qui est voulu est appliqué à l'élément. */
function ensureFollowing(): void {
  if (following) return;
  following = true;
  useStore.subscribe((state, previous) => {
    const now = state.playback;
    const before = previous.playback;
    if (now.wantPaused !== before.wantPaused || now.seek !== before.seek) follow();
    if (now.muted !== before.muted) syncMix();
  });
}

/** Arrête la lecture et l'annonce à Jellyfin — qui coupe alors le transcodage. N'est appelé que par les commandes. */
export function close(): void {
  generation++;
  void loadSubtitles(null);
  finish("close");
  release();
  unload();
  if (video) video.loop = false;
  current = null;
  set({ ...IDLE_PLAYBACK, muted: useStore.getState().playback.muted });
}

/** La page s'en va (fermeture, rechargement, retour au cinéma) : l'arrêt part quand même (`keepalive`). */
export function stopOnLeave(): void {
  finish("page", true);
}
