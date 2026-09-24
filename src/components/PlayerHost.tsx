"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { createPortal, flushSync } from "react-dom";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { refreshAfterPlayback } from "@/lib/swr";
import { UPSTREAM_UNREACHABLE } from "@/lib/http";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { useStableFallback, takeoverFor, returningFor, castHandBackPosition, type StableTakeover } from "@/lib/useStableFallback";
import { publishHandedOver } from "@/lib/playerBench/bridge";
import { PlayerControls, type Track, VOLUME_STORAGE_KEY } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { pickMaxBitrate } from "@/lib/networkBitrate";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import { useLegacyPlayer } from "@/lib/useLegacyPlayer";
import { usePlayerServerFallback } from "@/lib/usePlayerEnabled";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";
import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { describeJellyfinPlayback } from "@/lib/playbackPanel";
import { usePlayback, PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import { isWebKit } from "@/lib/webkitEngine";
import { detectCodecSupport } from "@/lib/codecSupport";
import { useT, useLocale } from "@/components/TranslationProvider";
import { useWakeLock } from "@/lib/useWakeLock";
import { reportPlayback } from "@/lib/reportPlayback";
import { serverStartFields, serverFailureFields, castEstablishedFields, serverStopFields, type ServerPlayerContext } from "@/lib/serverPlayerLog";
import { resolveResumeAt } from "@/lib/resumePosition";

export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";

export interface PlaybackInfoSummary {
  playMethod: PlayMethod;
  transcodeReasons: string[];
  container: string | null;
  requestedVideoCodecs: string[];
  video: {
    codec: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
    bitDepth: number | null;
    frameRate: number | null;
    bitRate: number | null;
  } | null;
  audio: {
    codec: string | null;
    channels: number | null;
    bitRate: number | null;
    language: string | null;
  } | null;
}

interface ExternalSubtitleTrack {
  index: number;
  url: string;
  /**
   * L'étiquette construite ici, et non reçue du serveur.
   *
   * Elle sert deux fois : dans notre menu, et dans l'attribut `label` de la balise `<track>` —
   * que le navigateur affiche dans **son propre** sélecteur, et que l'Apple TV montre en AirPlay.
   * D'où l'importance qu'elle se tienne hors de notre interface aussi.
   */
  label: string;
  language?: string | null;
  title?: string | null;
  isDefault: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  isExternal?: boolean;
}

const MAX_NETWORK_RETRIES = 6;

// ── Audio-codec fallback ladder (native HLS path) ────────────────────────────────────────────
// Ground truth from live testing: a device's own canPlayType() can overreport what its native
// HLS pipeline really accepts — the concrete case being an iPhone whose canPlayType claims
// E-AC-3 support while its HLS master-playlist variant filter rejects any CODECS="…,ec-3"
// stream outright (MediaError 4, instantly, with byte-identical playlists to a working AC-3
// negotiation — every other explanation was tested and eliminated one by one). Since claimed
// support can't be trusted, actual playback is the only reliable probe: on a fatal native
// error, retry the same request with a progressively reduced audio codec set, which makes
// Jellyfin fall back to a genuine server-side audio transcode. The final rung (AAC only) is
// always transcodable and universally decodable, so the ladder can't strand the user.
// A codec disabled on the rung that finally SUCCEEDS is persisted per-browser (localStorage)
// so every future load on this device excludes it up front — one failed attempt total, ever,
// instead of a failure dance on every playback.
const AUDIO_FALLBACK_RUNGS: string[][] = [
  [], // replay the identical request first — absorbs transient teardown races, learns nothing
  ["eac3", "flac", "opus"], // keep aac+ac3, the two most reliably decoded codecs on Apple hw
  ["eac3", "flac", "opus", "ac3"], // AAC only — forces a clean server transcode, always works
];

const AUDIO_BLOCKLIST_KEY = "cine:audio-codec-blocklist:v1";

function readAudioBlocklist(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AUDIO_BLOCKLIST_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function persistAudioBlocklist(codecs: string[]): void {
  try {
    localStorage.setItem(AUDIO_BLOCKLIST_KEY, JSON.stringify([...new Set(codecs)]));
  } catch {
    // Storage unavailable — the ladder just re-learns next session.
  }
}
const MAX_MEDIA_RETRIES = 3;

// The single, always-mounted playback engine for the whole app (mounted once in the
// dashboard layout) — driven by PlaybackProvider's global state instead of props, so it
// survives navigating to a different page. Renders nothing when there's no active session;
// otherwise renders the SAME <video> element regardless of full/mini mode (only the
// container's size/position/chrome differ), so minimizing never interrupts playback.
export function PlayerHost() {
  const t = useT();
  const playback = usePlayback();
  const { session, mode } = playback;
  const { legacy } = useLegacyPlayer();
  // Whether this install has a server-side player at all. When it does not, nothing below can
  // hand a file to Jellyfin: neither the account option, nor a refusal by the native path.
  const serverFallback = usePlayerServerFallback();
  // Set by the experimental player's own "switch to the stable player" button. Deliberately not
  // persisted: it applies to this session only, so the option in settings stays the source of
  // truth and the next playback tries the experimental path again — which is what makes it
  // useful for finding out which files it actually cannot handle.
  // The handover to the stable player: which files it has taken over, why, and the word shown
  // to the viewer while it settles in. See useStableFallback.
  const { handedOver, negotiating, reason: fallbackReason, takeover, stepAside, stepBack, returning } = useStableFallback();

  // Le banc d'essai éprouve le lecteur natif : un film déjà confié au lecteur serveur ne lui
  // reviendra pas, et l'attendre revenait à annoncer un échec là où il n'y a rien à mesurer.
  // Publié d'ici parce que c'est ici que ce fait vit — le banc n'a pas à connaître cet état.
  useEffect(() => publishHandedOver(handedOver), [handedOver]);

  // Stable across renders on purpose. Handed down as an inline arrow, this was a different
  // function every time this component drew — and minimising the player draws it — which the
  // experimental player took for a reason to build its whole pipeline again.
  const itemId = session?.itemId;
  // La séance est jointe au relais ici, et non par le lecteur natif : c'est ce niveau qui la
  // possède, et le relais ne doit valoir que pour elle — voir `StableTakeover.owner`.
  const handOver = useCallback(
    (reason: string, resumeInto?: StableTakeover) => {
      if (itemId) stepAside(itemId, reason, resumeInto ? { ...resumeInto, owner: session } : undefined);
    },
    [itemId, session, stepAside]
  );

  /**
   * La diffusion s'est arrêtée : on rend la main au lecteur natif.
   *
   * `stepBack` ne le fait que si la bascule était une diffusion — une bascule d'échec qui
   * reviendrait rejouerait son échec en boucle. La règle vit là-bas, pas ici.
   */
  const handCastBack = useCallback(
    (resumeAt: number) => {
      if (itemId) stepBack(itemId, resumeAt, session);
    },
    [itemId, session, stepBack]
  );

  if (!session) return null;
  // Waited for rather than assumed. Whichever player is assumed while the answer is in flight
  // mounts and *starts* — and for the server-side one that means negotiating a stream and
  // warming a transcode, which was then thrown away a round trip later. One request, once per
  // session, against an abandoned transcode on every playback.
  //
  // Attention : ce `return null` s'applique à une séance **en cours**, pas seulement à un
  // démarrage. Sur une adresse publique — la page d'état, qu'on peut ouvrir depuis le panneau
  // Compte avec un film réduit —, `useLegacyPlayer` ne pose plus sa question. Il faut donc qu'il
  // se souvienne de la réponse, sans quoi cette ligne coupe la lecture ; c'est le cache SWR, qui
  // n'appartient à aucun montage, qui la porte. Une version qui la retenait dans l'instance du
  // hook (clé nulle + `keepPreviousData`) a tué le film en production. Couvert par
  // `useLegacyPlayer-public-path.test.tsx`, qui remonte le hook au lieu de le re-rendre.
  if (legacy === undefined || serverFallback === undefined) return null;

  /**
   * Le lecteur natif reprend là où la diffusion s'est arrêtée, et non là où la séance s'est
   * ouverte — qui peut dater d'une heure et demie.
   *
   * La position voyage par la séance plutôt que par une nouvelle propriété : c'est déjà le champ
   * dont ce lecteur tire sa réponse, et lui en ajouter un second à consulter serait une seconde
   * règle sur la même question. `?? 0` n'a pas lieu d'être ici : `returning` porte toujours un
   * nombre.
   */
  const back = returningFor(returning, session);
  const playing = back !== null ? { ...session, resumeAt: back } : session;

  // Sans lecteur serveur, il n'y a pas d'aiguillage : le choix du compte comme le repli
  // automatique désignent tous deux un lecteur qui n'existe pas sur cette installation. Un
  // fichier que le navigateur ne sait pas porter finit sur une erreur de lecture, pas sur un
  // transcodage — c'est tout l'objet du réglage.
  const useNative = !serverFallback || (!legacy && !handedOver.includes(session.itemId));
  if (useNative) {
    return (
      <ExperimentalPlayerHost
        // A different film is a different player. Without this, advancing to the next episode
        // kept everything the previous one had accumulated: the audio track number the viewer
        // had chosen — which on another file may well be another language — the subtitle file
        // fetched for the episode before, the position, the count of rebuilds already spent, and
        // a readiness left true while the new one was still opening.
        // Et une nouvelle ouverture du même film aussi — voir `PlaybackSession.openId`.
        key={`${session.itemId}:${session.openId ?? 0}`}
        session={playing}
        mode={mode === "mini" ? "mini" : "full"}
        onFallback={handOver}
      />
    );
  }

  return (
    <>
      <ActivePlayer
        // Le numéro d'ouverture seul, pas l'épisode : ce lecteur-ci enchaîne lui-même les épisodes
        // sur le changement d'identifiant, avec son propre compte rendu d'arrêt. Le remonter à
        // chaque épisode l'aurait rendu deux fois.
        key={session.openId ?? 0}
        session={session}
        mode={mode === "mini" ? "mini" : "full"}
        fallbackReason={fallbackReason}
        takeover={takeover}
        onCastEnded={handCastBack}
      />
      {/* Shown over the stable player while it makes its own arrangements, and gone on its own.
          Nothing to dismiss and nothing to decide: by the time a viewer has read it, the film is
          usually already playing. */}
      {negotiating && (
        <div className="pointer-events-none fixed inset-x-0 top-6 z-[70] flex justify-center">
          {/* Le mot nomme ce qu'on attend. Un encart qui dit « négociation » pendant qu'on prépare
              une diffusion ne se lit pas comme une attente utile : il se lit comme un incident.
              Et un spinner qui nomme ce qu'il attend ne se lit plus comme un spinner. */}
          <span className="animate-fade-in flex items-center gap-2 rounded-full bg-slate-900/85 px-4 py-2 text-sm text-slate-200 shadow-lg ring-1 ring-white/10 backdrop-blur-sm">
            <Loader2 size={14} className="animate-spin text-accent-400" />
            {takeover?.cast ? t("player.castPreparing") : t("player.handingOver")}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Ce que WebKit ajoute à un élément vidéo et que `lib.dom` ne décrit pas — même raison que le
 * type jumeau de `PlayerControls`, qui n'en connaît que la moitié dont il se sert.
 */
interface CastCapableVideo extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

function ActivePlayer({
  session,
  mode,
  fallbackReason,
  takeover,
  onCastEnded,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  mode: "full" | "mini";
  /** Set when this player took over from the experimental one, and why. Shown in its panel. */
  fallbackReason?: string | null;
  /** Where to resume and on which track, when the handover happened mid-playback. */
  takeover?: StableTakeover | null;
  /** Appelé quand la diffusion s'arrête, avec la position où elle s'est arrêtée. */
  onCastEnded?: (resumeAt: number) => void;
}) {
  const playback = usePlayback();
  const t = useT();
  const { locale } = useLocale();
  const {
    itemId,
    title: openedAs,
    resumeAt: sessionResumeAt,
    initialAudioStreamIndex: sessionAudioStreamIndex,
    fromReload,
    reloadAttempt,
  } = session;

  // Le relais d'un repli survenu *pendant* la lecture prime sur ce que la séance portait : celle-ci
  // décrit son ouverture, il y a peut-être quarante minutes, et sur la piste par défaut du fichier.
  // Reprendre là-dessus renverrait le spectateur en arrière et dans la langue qu'il vient justement
  // de quitter. Le `??` préserve un zéro des deux côtés — voir `PlaybackSession.resumeAt`.
  // Et seulement si ce relais appartient à *cette* lecture : rouvrir le même film plus tard est
  // une séance neuve, qui porte sa propre position — « Recommencer » comprise.
  const mine = takeoverFor(takeover, session);
  /**
   * Cette séance existe-t-elle pour diffuser ?
   *
   * Elle décide de trois choses, et de rien d'autre : le serveur met les sous-titres dans le flux,
   * l'adresse revient absolue et signée, et le sélecteur s'ouvre dès que l'image est prête. Hors
   * de ce cas, pas une ligne de ce lecteur ne change.
   */
  const castSession = mine?.cast === true;
  const initialResumeAt = mine?.resumeAt ?? sessionResumeAt;
  const initialAudioStreamIndex = mine?.audioStreamIndex ?? sessionAudioStreamIndex;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  // Quatre appelants lancent startPlayback sans jamais attendre le précédent (changement de
  // piste, « Réessayer », montage, échelon de repli audio), et la fonction traverse deux await.
  // Deux appels qui se chevauchent créaient donc chacun leur Hls : le premier arrivé se faisait
  // écraser dans hlsRef sans jamais recevoir destroy(), et continuait à télécharger ses
  // fragments — deux flux HLS en parallèle pour un seul film, sur un appareil qui vient déjà
  // d'échouer une fois. Même modèle que le `cancelled` du lecteur natif
  // (ExperimentalPlayerHost), en compteur parce qu'il y a ici plusieurs départs successifs et
  // pas un effet unique à annuler : chaque appel prend un numéro strictement plus grand, et un
  // appel qui ne porte plus le numéro courant abandonne au lieu de poser ses effets de bord.
  const playbackGeneration = useRef(0);
  const networkRetryCount = useRef(0);
  const mediaRetryCount = useRef(0);
  const networkRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept up to date on every 'timeupdate' so a fatal error (which freezes the <video> in
  // place, no longer receiving new data) still has a recent position to resume from — reading
  // video.currentTime directly at that point would work too, but this is more robust if the
  // element itself is ever swapped.
  //
  // Semée au point de reprise plutôt qu'à zéro. Elle ne l'était qu'une fois le chargement fini,
  // si bien que fermer un film *pendant* qu'il chargeait rapportait un arrêt à 0:00 — Jellyfin
  // oubliait la position, le film quittait « Reprendre », et cliquer sur « Reprendre » pour se
  // raviser aussitôt effaçait donc précisément ce qu'on venait de vouloir reprendre.
  const lastKnownTime = useRef(initialResumeAt ?? 0);
  const loadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Belt-and-braces for the native (non-hls.js) path: iOS's media daemon releases HLS sessions
  // asynchronously, so even with the reload-based track switch a fresh load can race the old
  // session's teardown and get refused (SRC_NOT_SUPPORTED). One automatic, delayed re-attempt
  // absorbs that race invisibly; only a second consecutive failure surfaces the error UI.
  // Reset on every successful load ('loadeddata'), NOT at the top of startPlayback — the retry
  // itself goes through startPlayback, which would otherwise clear its own budget.
  const nativeErrorRetryCount = useRef(0);
  const nativeErrorRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The opts of the most recent startPlayback call, so an automatic retry replays the SAME
  // request (audio track included) — state like currentAudioId would be stale inside the
  // error listener's closure.
  const lastPlaybackOpts = useRef<{ audioStreamIndex?: number; resumeAt?: number; disableAudioCodecs?: string[] } | undefined>(undefined);
  // Re-tested in isolation now that the Range/206 and manifest-prewarm bugs are both confirmed
  // fixed — a previous attempt at this (ebc2d2d) was reverted after appearing not to help, but
  // that test ran while the Range-truncation bug was still live, which may have masked whether
  // this was actually necessary. Bumped to force a genuinely fresh <video> element (via the
  // `key` prop below) for a track switch on WebKit, instead of reusing the same node.
  const [videoKey, setVideoKey] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(true);
  // True only while hls.js is mid-retry after a fatal network/media error — distinct from
  // `loading` (the initial "fetching a fresh manifest" spinner) and from `error` (retries
  // exhausted, playback truly stopped). Drives the small non-blocking "Reconnexion..." banner.
  const [reconnecting, setReconnecting] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  // Non-interactive — a measured signal, not a settings toggle. Two real, checkable metrics
  // (not an invented "latency" a browser can't actually observe for HLS segments): how often
  // playback has stalled to rebuffer in the last minute, and the decoder's own RECENT
  // dropped-frame rate via the standard getVideoPlaybackQuality() API. Reset per session in
  // startPlayback.
  const [badConnection, setBadConnection] = useState(false);
  const rebufferTimestamps = useRef<number[]>([]);
  const hasPlayedOnce = useRef(false);
  // A deliberate seek always fires 'waiting' too (the video briefly reloads at the new
  // position) — reported live as a false-positive trigger during normal scrubbing, nothing to
  // do with connection quality. 'waiting' within this long after a 'seeking' event is ignored.
  const lastSeekAt = useRef(0);
  // getVideoPlaybackQuality()'s dropped/total counts are cumulative since playback started, so a
  // ratio computed directly from them can only ever climb — once real congestion pushed it past
  // the threshold once, the badge could never clear again even after the connection fully
  // recovered. Comparing against the previous poll's reading turns it into a recent-window rate
  // that can properly drop back down.
  const lastQuality = useRef<{ total: number; dropped: number } | null>(null);
  // Estimated actual network throughput (hls.js's own adaptive-bitrate estimate) — distinct
  // from playbackInfo.video.bitRate/audio.bitRate, which are the STATIC target bitrate Jellyfin
  // encoded/is streaming at. Only meaningful on the hls.js path (Transcode/DirectStream on
  // Chrome/Firefox); native Safari HLS has no equivalent and this just stays null there.
  const [networkBitrate, setNetworkBitrate] = useState<number | null>(null);
  // True once loading/reconnecting has been ongoing for >3s — drives the "still loading, don't
  // close the player" reassurance line for heavy flows (a 4K track switch can legitimately take
  // 15-20s across the grace delay, codec ladder and reload escalation).
  const [loadingLong, setLoadingLong] = useState(false);
  const [closing, setClosing] = useState(false);
  const [playSession, setPlaySession] = useState<{
    itemId: string;
    playSessionId: string;
    mediaSourceId: string;
  } | null>(null);

  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [currentAudioId, setCurrentAudioId] = useState<number | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<Track[]>([]);
  const [currentSubtitleId, setCurrentSubtitleId] = useState<number | null>(null);
  // The server's own name for the item — the only one that knows an episode is an episode. What
  // the caller passed stands until it arrives, so the title never blinks in empty.
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  const title = serverTitle ?? openedAs;
  // Ce que chaque ligne du journal de ce lecteur porte — voir `serverPlayerLog`. Tenu dans une
  // référence : `startPlayback` a des dépendances volontairement figées, et y lire `title` ou
  // `castSession` directement nommerait l'épisode d'avant.
  const logContext = useRef<ServerPlayerContext>({ itemId, title, cast: castSession, bench: session.bench });
  useEffect(() => {
    logContext.current = { itemId, title, cast: castSession, bench: session.bench };
  }, [itemId, title, castSession, session.bench]);
  const [introSkip, setIntroSkip] = useState<{ start: number; end: number } | null>(null);
  const [creditsStart, setCreditsStart] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Tant que ça joue, l'écran reste allumé — voir useWakeLock pour ce que chaque chemin
  // obtient déjà tout seul et ce qu'il n'obtient pas.
  useWakeLock(playing);
  const [externalSubtitleTracks, setExternalSubtitleTracks] = useState<ExternalSubtitleTrack[]>([]);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfoSummary | null>(null);
  const [showPlaybackInfo, setShowPlaybackInfo] = useState(false);
  const playMethod = playbackInfo?.playMethod ?? "Transcode";

  const { stop: stopPlaybackNow, resume: resumePlaybackSession } = usePlaybackSession(
    useCallback(() => lastKnownTime.current, []),
    // Named as this app rather than as its engine: this player hands the file to Jellyfin, which
    // is what the server's own dashboard should show.
    playSession && { ...playSession, playMethod, client: PLAYBACK_CLIENTS.stable },
    useCallback(() => videoRef.current?.paused ?? false, [])
  );

  const nextEpisode = session.getNextEpisode?.(itemId) ?? null;

  // Swaps to the next episode in place — reports the current one's final
  // position first, same as a manual close, but never triggers the
  // close/unmount fade since the player stays open for the new episode.
  const handleAdvance = useCallback(() => {
    if (!nextEpisode) return;
    reportPlayback("stop", serverStopFields(logContext.current, "next", lastKnownTime.current));
    stopPlaybackNow();
    playback.advance(nextEpisode);
  }, [nextEpisode, playback, stopPlaybackNow]);

  // Fades out instead of vanishing instantly — an abrupt unmount back to the
  // underlying page reads as a glitch, especially mid-transcode. Reports the
  // stop position right now (not whenever React gets around to unmounting)
  // so Jellyfin's resume point reflects the exact moment the user closed,
  // not wherever currentTime drifts to during the fade delay.
  const CLOSE_MS = 200;
  const handleClose = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    reportPlayback("stop", serverStopFields(logContext.current, "close", lastKnownTime.current));
    const reported = stopPlaybackNow();
    setClosing(true);
    // Cette lecture-ci seulement : voir `close(openId)`.
    const openId = session.openId;
    setTimeout(() => playback.close(openId), CLOSE_MS);
    // La fiche et la rangée « Reprendre » décrivent ce film : elles sont fausses dès l'instant
    // où on le quitte, et rien ne les relisait. Volontairement hors du chemin de la fermeture —
    // l'écran doit partir tout de suite, la relecture peut attendre son tour.
    void refreshAfterPlayback(reported, itemId);
  }, [playback, stopPlaybackNow, itemId, session.openId]);

  // (Re)starts playback, optionally at a specific audio track / resume point.
  // Jellyfin only ever transcodes ONE audio stream into the HLS output (unlike
  // subtitles, which it exposes as switchable renditions), so changing audio
  // means asking for a brand new transcode. Jellyfin's HLS output here is a
  // full VOD playlist covering the whole runtime regardless of StartTimeTicks
  // (seeking already works by jumping within it) — so instead of trusting
  // Jellyfin to start the new stream at the right offset, we seek the video
  // to resumeAt ourselves once the new manifest's metadata is ready.
  const startPlayback = useCallback(
    async (opts?: { audioStreamIndex?: number; resumeAt?: number; disableAudioCodecs?: string[] }) => {
      let video = videoRef.current;
      if (!video) return;

      // Incrémenté à chaque appel, sans exception — l'échelon de repli audio rejoue
      // délibérément la requête identique (rung 0) et doit donc lui aussi prendre un numéro
      // neuf, sinon il se reconnaîtrait comme périmé et s'annulerait lui-même.
      const generation = ++playbackGeneration.current;

      // Dropped before the request that will replace it. Advancing to the next episode keeps
      // this component mounted, so the previous episode's name stayed across the top until the
      // server answered — and what the caller passed, which is already the right episode, was
      // sitting behind it unused.
      setServerTitle(null);

      // Per-browser learned exclusions (see AUDIO_FALLBACK_RUNGS) merged with this call's own —
      // so a codec this device already proved it can't play is excluded from the very first
      // negotiation, not rediscovered through a failure on every playback.
      const disableAudioCodecs = [...new Set([...readAudioBlocklist(), ...(opts?.disableAudioCodecs ?? [])])];
      lastPlaybackOpts.current = opts;

      // WebKit only — hls.js (Firefox, Chrome/Edge desktop & Android) already handles reusing
      // the element correctly via its own MediaSource and was never affected by this.
      if (video.src && video.canPlayType("application/vnd.apple.mpegurl")) {
        flushSync(() => setVideoKey((k) => k + 1));
        video = videoRef.current;
        if (!video) return;
      }

      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
      networkRetryTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
      networkRetryCount.current = 0;
      mediaRetryCount.current = 0;
      setError(null);
      setReconnecting(false);
      setLoading(true);
      rebufferTimestamps.current = [];
      hasPlayedOnce.current = false;
      lastSeekAt.current = 0;
      lastQuality.current = null;
      setBadConnection(false);
      setNetworkBitrate(null);

      // (An earlier revision also waited for the "emptied" event here before reassigning src —
      // removed: it was built on a disproven teardown-timing theory and only added up to 300ms
      // of dead latency to every hls.js track switch. WebKit gets a fresh element via the
      // remount above; hls.js manages its own MediaSource and needs nothing.)

      const codecSupport = await detectCodecSupport();
      if (generation !== playbackGeneration.current) return;

      // Safari and iOS play HLS natively and never touch hls.js; everything else needs it, and
      // it is a 376 KB chunk. Awaiting that download only at its point of use — after
      // /playback/start has already answered — put the whole thing on the critical path to the
      // first frame. Kicking it off HERE overlaps it with the request, the negotiation and
      // ffmpeg's warm-up, which is dead time it can hide behind entirely.
      //
      // The value is awaited far below, on the one branch that needs it; the DirectPlay and
      // native-HLS branches return before then and simply leave it downloading into the browser
      // cache, where the next transcoded title will find it. The extra .catch() is only there so
      // an early return can't leave a rejected promise unhandled — the await below still sees
      // (and throws) the original rejection exactly as it did before.
      const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
      const hlsModule = nativeHls ? null : import("hls.js");
      hlsModule?.catch(() => {});

      const res = await fetch("/api/jellyfin/playback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          maxBitrate: pickMaxBitrate(),
          audioStreamIndex: opts?.audioStreamIndex,
          startTicks: opts?.resumeAt ? Math.floor(opts.resumeAt * 10_000_000) : undefined,
          codecSupport,
          disableAudioCodecs,
          /**
           * Cette lecture part-elle vers un téléviseur ?
           *
           * Le serveur en tire deux conséquences : les sous-titres entrent dans le manifeste — le
           * récepteur ne voit rien de ce que la page dessine — et l'adresse revient absolue et
           * signée, puisque c'est lui qui ira la chercher, sans notre cookie.
           */
          forCast: castSession,
          // Lets the server skip its manifest pre-warm for us — see the route. hls.js retries a
          // slow first manifest patiently; Safari's native pipeline does not, which is who that
          // pre-warm was built for.
          nativeHls,
        }),
      });
      // Avant la lecture du corps, donc avant setNeedsReauth / setError : l'échec d'une
      // négociation déjà remplacée n'a rien à afficher, c'est la nouvelle qui décide.
      if (generation !== playbackGeneration.current) return;
      if (res.status === 401) {
        const body = await res.json().catch(() => null);
        if (body?.code === "jellyfin_reauth_required") {
          reportPlayback("error", serverFailureFields(logContext.current, "reconnexion à Jellyfin demandée", { status: 401 }));
          setNeedsReauth(true);
          setLoading(false);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        reportPlayback(
          "error",
          serverFailureFields(logContext.current, "négociation refusée", { status: res.status, code: body?.code ?? body?.error ?? "" })
        );
        // La même phrase que le lecteur natif pour la même panne : un serveur média absent n'est
        // pas une lecture impossible, c'est une lecture à retenter plus tard. Le code vient de la
        // réponse, comme `jellyfin_reauth_required` juste au-dessus.
        setError(
          body?.code === UPSTREAM_UNREACHABLE
            ? t("player.libraryUnreachable")
            : body?.error || "Lecture impossible pour le moment."
        );
        setLoading(false);
        return;
      }
      const data = await res.json();
      reportPlayback("start", {
        ...serverStartFields(logContext.current, {
          directPlay: !!data.isDirectPlay,
          nativeHls,
          resumeAt: opts?.resumeAt,
          audioStreamIndex: opts?.audioStreamIndex,
        }),
        // Une reprise de l'échelle audio rejoue la négociation : la ligne dit laquelle.
        ...(nativeErrorRetryCount.current > 0 ? { retry: nativeErrorRetryCount.current } : {}),
      });

      setPlaySession({ itemId, playSessionId: data.playSessionId, mediaSourceId: data.mediaSourceId });
      /**
       * Les mêmes étiquettes que le lecteur natif, écrites par le même module.
       *
       * On atterrit ici quand quelque chose vient de mal se passer — un TrueHD refusé, un
       * AirPlay, un tampon récalcitrant. C'est exactement le moment où un menu qui se met à
       * parler un autre vocabulaire ajoute de la confusion à une situation déjà dégradée.
       */
      const faitsAudio = (data.audioTracks ?? []) as {
        index: number;
        language: string | null;
        title: string | null;
        codec: string | null;
        channels: number | null;
        profile: string | null;
        isDefault: boolean;
      }[];
      setAudioTracks(
        labelAudioTracks(
          faitsAudio.map((t) => ({
            number: t.index,
            language: t.language,
            name: t.title,
            isDefault: t.isDefault,
            isForced: false,
            codecId: t.codec,
            channels: t.channels,
            profile: t.profile,
          })),
          {
            locale,
            originalLanguage: data.originalLanguage ?? null,
            canaux: (n: number) => t("player.trackLabel.channels", { n }),
            piste: (n: number) => t("player.trackLabel.track", { n }),
          }
        ).map((e) => ({ id: e.number, label: e.label }))
      );
      setCurrentAudioId(opts?.audioStreamIndex ?? data.audioTracks?.find((t: { isDefault: boolean }) => t.isDefault)?.index ?? null);
      setServerTitle(data.title ?? null);
      setIntroSkip(data.introSkip ?? null);
      setCreditsStart(data.creditsStart ?? null);
      setPlaybackInfo(data.playbackInfo ?? null);

      const resumeAt = opts?.resumeAt;
      // Avant le chargement, et pas seulement dans son rappel plus bas : entre cet instant et
      // l'arrivée des métadonnées il s'écoule plusieurs secondes sur un gros fichier, et c'est
      // exactement la fenêtre pendant laquelle une fermeture rapportait zéro.
      lastKnownTime.current = resumeAt ?? 0;
      video.addEventListener(
        // Root cause found live via real Jellyfin logs during a reproduced test: setting
        // currentTime this early (previously on 'loadedmetadata', which only guarantees
        // duration/dimensions are known — no data buffered yet at any position) made Safari's
        // native HLS engine jump straight to the resume target's segment before the very first
        // manifest bootstrap (segment 0 + its init segment) had even settled. That collided with
        // Jellyfin's own ffmpeg job for segment 0, which got killed mid-request right as our
        // client's init-segment fetch landed on it — logged server-side as "task was canceled"
        // then "doesn't exist and no transcode is running". hls.js already sequences this more
        // carefully, which is why Firefox never hit it despite running the exact same code here.
        // 'loadeddata' guarantees the browser actually has playable data at the CURRENT position
        // first, so the resume seek only fires once the initial bootstrap has already succeeded.
        "loadeddata",
        () => {
          if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
          loadWatchdog.current = null;
          nativeErrorRetryCount.current = 0;
          // A successful load with codecs disabled beyond what the blocklist already held means
          // the fallback ladder just identified the culprit(s) — persist so every future load on
          // this browser excludes them from the first negotiation (see AUDIO_FALLBACK_RUNGS).
          if (opts?.disableAudioCodecs?.length) {
            persistAudioBlocklist([...readAudioBlocklist(), ...opts.disableAudioCodecs]);
          }
          if (resumeAt) video.currentTime = resumeAt;
          // Seeded here rather than waiting for the first 'timeupdate' — otherwise a progress
          // heartbeat firing in the gap right after a resume would still report the pre-seek 0.
          lastKnownTime.current = resumeAt ?? 0;
          setLoading(false);
        },
        { once: true }
      );

      // Last-resort safety net alongside the "error" event listener above: covers the case
      // where the manifest/segment request itself hangs (through our own stream proxy) without
      // ever firing a native error OR an hls.js fatal — nothing to recover from, so this just
      // turns a silent infinite spinner into an actionable error with a retry button.
      loadWatchdog.current = setTimeout(() => {
        reportPlayback("error", serverFailureFields(logContext.current, "pas de première image en 20 s"));
        setReconnecting(false);
        setLoading(false);
        setError(t('player.loadingTooLong'));
      }, 20_000);

      // Subtitles always come from the PlaybackInfo response as external VTT tracks (rendered
      // as <track> elements below), for every PlayMethod — not from hls.js's own
      // SUBTITLE_TRACKS_UPDATED event or native textTrack discovery. Those turned out both
      // *less* reliable (hls.js's own rendition names are often blank, falling back to generic
      // "Piste N") AND actively harmful here: since they fire asynchronously after this rich
      // list is already set, they'd silently overwrite it a moment later. Real-world catalog
      // check: DirectStream (an mkv container remuxed to HLS, video copied untouched) is the
      // dominant case for an HEVC-in-mkv library, not the exception — so this isn't a narrow
      // DirectPlay-only fix, it's the primary path.
      const faitsSt = (data.subtitleTracks ?? []) as Omit<ExternalSubtitleTrack, "label">[];
      const etiquettesSt = new Map(
        labelSubtitleTracks(
          faitsSt.map((st) => ({
            number: st.index,
            language: st.language ?? null,
            name: st.title ?? null,
            isDefault: st.isDefault,
            isForced: st.isForced ?? false,
            isHearingImpaired: st.isHearingImpaired,
            isExternal: st.isExternal,
          })),
          {
            locale,
            forces: t("player.trackLabel.forced"),
            complets: t("player.trackLabel.full"),
            malentendants: t("player.trackLabel.sdh"),
            externe: t("player.trackLabel.external"),
            piste: (n: number) => t("player.trackLabel.track", { n }),
          }
        ).map((e) => [e.number, e.label])
      );
      const tracks: ExternalSubtitleTrack[] = faitsSt.map((st) => ({
        ...st,
        label: etiquettesSt.get(st.index) ?? String(st.index),
      }));
      setExternalSubtitleTracks(tracks);
      setSubtitleTracks(tracks.map((st) => ({ id: st.index, label: st.label })));
      setCurrentSubtitleId(null);

      // A play() rejected with NotAllowedError is iOS's autoplay policy, not a media failure:
      // the reload-based WebKit track switch lands on a fresh page that has no user activation
      // (the tap that picked the language happened on the PREVIOUS page), so programmatic
      // playback with sound is denied even though the stream itself loaded fine. iOS only
      // exempts MUTED autoplay, which was tried and rejected as UX (silently playing video
      // after an audio-track switch defeats the point) — so the deliberate behavior is a clean
      // paused state: spinner cleared, play button showing, one tap resumes with the new track.
      const playAllowingGesture = () => {
        video.play().catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "NotAllowedError") {
            setLoading(false);
          }
        });
      };

      // DirectPlay/DirectStream: a plain Range-seekable file, not an HLS manifest — no hls.js,
      // no native-HLS branch below, just a regular <video src>.
      /**
       * L'adresse que l'élément reçoit — et donc celle que le récepteur recevra.
       *
       * AirPlay comme Remote Playback ne transmettent pas le flux : ils tendent au téléviseur la
       * `src` courante, à charge pour lui d'aller la chercher. Elle doit donc être absolue et
       * porter son laissez-passer. Hors diffusion, rien ne change : `castUrl` est nulle et c'est
       * l'adresse relative d'hier qui sert.
       */
      const sourceUrl = data.castUrl ?? data.manifestUrl;

      if (data.isDirectPlay) {
        video.src = sourceUrl;
        video.load();
        playAllowingGesture();
        return;
      }

      // Safari (desktop + iOS) plays HLS natively — hls.js is only needed where
      // that's absent (Chrome/Firefox).
      if (nativeHls) {
        video.src = sourceUrl;
        // Reassigning .src alone doesn't reliably tear down Safari's existing
        // HLS session when only the query string changes (e.g. switching
        // audio track) — force a clean reload so it actually picks up the
        // new manifest instead of silently continuing the old one.
        video.load();
        playAllowingGesture();
        return;
      }

      // Started alongside the request above, not here — see its comment. Non-null because this
      // branch is only reached when canPlayType said there is no native HLS.
      const { default: Hls } = await hlsModule!;
      if (!Hls.isSupported()) {
        reportPlayback("error", serverFailureFields(logContext.current, "hls.js non pris en charge par ce navigateur"));
        setError(t('player.unsupportedBrowser'));
        setLoading(false);
        return;
      }
      const hls = new Hls({
        // hls.js's own default back-buffer behavior varies by version and isn't
        // worth trusting blindly — pin it explicitly so a -30s rewind replays
        // from the already-decoded buffer instead of stalling on a re-fetch.
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 90,
      });
      // Dernier recours : l'import de hls.js est lui aussi un await, et l'instance vient d'être
      // construite. Sans ce garde elle s'écrirait par-dessus celle d'un appel plus récent, qui
      // resterait vivante et sans propriétaire.
      if (generation !== playbackGeneration.current) {
        hls.destroy();
        return;
      }
      hlsRef.current = hls;

      // A successfully buffered fragment means the stream is healthy again — reset both
      // counters so a later, unrelated blip gets its own full retry budget instead of
      // inheriting an exhausted one from an earlier, already-recovered outage.
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        networkRetryCount.current = 0;
        mediaRetryCount.current = 0;
        setReconnecting(false);
        // hls.js keeps refining this per fragment even with a single-rendition stream (no real
        // ABR ladder from Jellyfin's transcoder) — piggybacking on the same event that already
        // resets the retry counters avoids adding a separate polling interval just for this.
        if (typeof hls.bandwidthEstimate === "number" && hls.bandwidthEstimate > 0) {
          setNetworkBitrate(Math.round(hls.bandwidthEstimate));
        }
      });

      // hls.js's own per-request retry/backoff (fragLoadingMaxRetry etc.) already absorbs a
      // short stall before ever raising a *fatal* error — a fatal here means that budget is
      // already exhausted. hls.js's documented recovery for that case is to call startLoad()
      // (network) or recoverMediaError() (media) ourselves rather than tearing the player down;
      // bounded so a genuinely dead stream still surfaces an error instead of retrying forever.
      hls.on(Hls.Events.ERROR, (_evt, data2) => {
        if (!data2.fatal) return;
        switch (data2.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: {
            if (networkRetryCount.current >= MAX_NETWORK_RETRIES) {
              setReconnecting(false);
              setLoading(false);
              setError(t('player.playbackInterruptedCheckConnection'));
              return;
            }
            networkRetryCount.current += 1;
            setReconnecting(true);
            // Exponential backoff (1s, 2s, 4s... capped at 15s) — covers a brief network
            // handoff (e.g. mobile switching between 5G and Wi-Fi, which drops connectivity
            // for roughly 1-3s) without hammering the server if it's actually down.
            const delay = Math.min(1000 * 2 ** (networkRetryCount.current - 1), 15_000);
            if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
            networkRetryTimer.current = setTimeout(() => hls.startLoad(), delay);
            return;
          }
          case Hls.ErrorTypes.MEDIA_ERROR: {
            if (mediaRetryCount.current >= MAX_MEDIA_RETRIES) {
              setReconnecting(false);
              setLoading(false);
              setError(t('player.playbackInterrupted'));
              return;
            }
            mediaRetryCount.current += 1;
            setReconnecting(true);
            hls.recoverMediaError();
            return;
          }
          default:
            setReconnecting(false);
            setLoading(false);
            setError(t('player.playbackInterrupted'));
        }
      });
      hls.loadSource(sourceUrl);
      hls.attachMedia(video);
    },
    // t (from useT()) only changes on a locale switch mid-playback, an edge case not worth
    // recreating this whole callback for — deps deliberately narrowed to itemId already (see
    // startPlaybackRef's own comment below for why).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemId]
  );

  // Always-fresh reference for the error listener's retry timer — that effect's deps are
  // deliberately frozen (it re-binds only on element remount), so calling startPlayback through
  // its closure directly would replay a stale itemId after an episode advance.
  const startPlaybackRef = useRef(startPlayback);
  useEffect(() => {
    startPlaybackRef.current = startPlayback;
  }, [startPlayback]);

  const changeAudio = useCallback(
    (id: number) => {
      const video = videoRef.current;
      // La position connue, pas celle de l'élément : pendant un chargement, il est encore à 0, et
      // changer de piste à ce moment relançait le film depuis le début (23/09/2026).
      const resumeAt = video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? video.currentTime : lastKnownTime.current;
      // WebKit only: switching audio in-place reliably fails there with MediaError
      // SRC_NOT_SUPPORTED — a genuine, reproducible WebKit limitation on loading a second HLS
      // session within the same page. Verified this isn't about DOM element reuse (fails
      // identically with a freshly created <video> element), our own HTTP/manifest handling
      // (verified byte-correct both directly against Jellyfin and through our own proxy), or
      // ffmpeg startup timing (fails just as fast for a plain remux as a real transcode) — every
      // other angle has been tested and ruled out. A full page reload sidesteps it entirely: the
      // new track then loads as the page's first-ever HLS session, which has never once failed
      // across every test. Persists just enough to resume exactly where playback left off.
      // WebKit, et non « sait lire du HLS » : Chrome Android répond oui à la seconde question et
      // rechargeait donc la page à chaque changement de piste. Voir isWebKitEngine.
      if (isWebKit() && video?.canPlayType("application/vnd.apple.mpegurl")) {
        try {
          sessionStorage.setItem(
            PLAYER_RELOAD_INTENT_KEY,
            JSON.stringify({ itemId, title, audioStreamIndex: id, resumeAt })
          );
        } catch {
          // Storage unavailable (private browsing, quota) — falls through to the in-place
          // switch below, which will still surface the usual error+retry UI if it fails.
        }
        // Tear the current media session down BEFORE reloading, not merely as a side effect of
        // the page dying: iOS's media daemon (mediaserverd) releases HLS sessions asynchronously
        // and independently of the page lifecycle, so a reload issued while the old stream is
        // still actively playing can bring the new page up before the old session is gone.
        // Starting teardown explicitly here buys that release as much head start as possible.
        video.pause();
        video.removeAttribute("src");
        video.load();
        window.location.reload();
        return;
      }
      startPlayback({ audioStreamIndex: id, resumeAt });
    },
    [startPlayback, itemId, title]
  );

  /**
   * Changer de piste pendant une diffusion : on prévient, on ne surprend pas.
   *
   * Le changement de piste recharge la page sur WebKit — c'est la seule façon connue d'ouvrir une
   * seconde session HLS, voir `changeAudio`. Or la route AirPlay appartient à l'élément : le
   * rechargement la rompt, sans exception. Le geste est donc légitime mais il a une conséquence,
   * et la conséquence doit être dite avant, pas découverte après. Ailleurs — hors diffusion —
   * rien ne change et rien ne s'interpose.
   */
  const [pendingAudioTrack, setPendingAudioTrack] = useState<number | null>(null);
  const requestAudioChange = useCallback(
    (id: number) => {
      if (castActiveRef.current) setPendingAudioTrack(id);
      else changeAudio(id);
    },
    [changeAudio]
  );

  // Manual "Réessayer" after retries are exhausted and `error` is showing — a full re-fetch
  // of PlaybackInfo (not just hls.startLoad()) since the old PlaySessionId/manifest may itself
  // be stale by then, picking up from the last position we saw before the stream died.
  const handleRetry = useCallback(() => {
    startPlayback({ resumeAt: lastKnownTime.current });
  }, [startPlayback]);

  // Always toggles the native <track> elements rendered from externalSubtitleTracks below —
  // regardless of PlayMethod, since subtitles are now uniformly external VTT (see startPlayback).
  // video.textTracks is indexed by DOM position, not by Jellyfin's own stream index (`id`
  // here), so the position has to be looked up in externalSubtitleTracks (rendered in the same
  // order) rather than assuming textTracks[id].
  const changeSubtitle = useCallback((id: number | null) => {
    const video = videoRef.current;
    if (!video) return;
    const position = id === null ? -1 : externalSubtitleTracks.findIndex((t) => t.index === id);
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = i === position ? "showing" : "disabled";
    }
    setCurrentSubtitleId(id);
  }, [externalSubtitleTracks]);

  // Kicks off async playback setup (fetch + hls.js wiring) on mount — real effect work, not a
  // simple state derivation, so it can't move to render.
  useEffect(() => {
    // Grace period after a reload-based track switch (see PlaybackSession.fromReload): iOS's
    // media daemon releases the previous page's HLS session asynchronously, roughly
    // proportionally to how much it had buffered. Proven live with byte-identical server
    // responses: resuming after a ~3s-old session loaded fine, after an 8-minute session it was
    // refused instantly (SRC_NOT_SUPPORTED) — the only remaining variable was the old session's
    // weight. Waiting here lets that release finish before the new session asks for its slot.
    // Remembered volume — applied once here, right when the session starts, rather than in
    // PlayerControls (which remounts on every full<->mini toggle and would otherwise re-apply
    // it on top of whatever the video's actual live volume already is).
    try {
      const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
      if (stored && videoRef.current) {
        const { volume, muted } = JSON.parse(stored) as { volume: number; muted: boolean };
        if (typeof volume === "number") videoRef.current.volume = volume;
        if (typeof muted === "boolean") videoRef.current.muted = muted;
      }
    } catch {
      // Malformed or unavailable — video just keeps its own default volume.
    }

    const graceMs = fromReload ? 3000 : 0;
    // Une position absente veut dire « demande au serveur », pas « du début » — voir
    // `resolveResumeAt`. Ce lecteur la lisait comme un zéro, et c'est lui qui s'ouvre quand le
    // compte a choisi le lecteur stable : sa séance repartait du début, puis ses rapports de
    // progression effaçaient la position chez Jellyfin.
    let abandoned = false;
    const graceTimer = setTimeout(() => {
      void resolveResumeAt(itemId, initialResumeAt).then((resumeAt) => {
        if (abandoned) return;
        startPlayback({ resumeAt, audioStreamIndex: initialAudioStreamIndex });
      });
    }, graceMs);
    return () => {
      abandoned = true;
      clearTimeout(graceTimer);
      // Un startPlayback encore en vol au démontage revient et construit son Hls quand même :
      // même fuite que F-013, autre déclencheur. Le compteur périme cette exécution-là.
      playbackGeneration.current += 1;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
      networkRetryTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
      if (nativeErrorRetryTimer.current) clearTimeout(nativeErrorRetryTimer.current);
      nativeErrorRetryTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPlayback]);

  /**
   * La diffusion, d'un bout à l'autre : ouvrir le sélecteur, puis guetter sa fin.
   *
   * **L'ouverture.** Les navigateurs n'ouvrent un sélecteur d'appareils que dans la fenêtre
   * d'activation d'un vrai geste — sinon n'importe quel site ferait apparaître « Diffuser vers… »
   * sans qu'on ait rien demandé. Entre l'appui du spectateur et cet instant, il y a eu une bascule
   * de lecteur et un aller-retour avec Jellyfin ; la fenêtre est peut-être fermée. On tente
   * quand même : Chrome accorde quelques secondes et laissera passer, et là où c'est refusé, le
   * bouton reste en évidence pour un second appui — qui, lui, portera sa propre activation.
   *
   * **La fin.** Elle peut venir de trois endroits : cette page, le centre de contrôle du
   * téléphone, ou le téléviseur lui-même. Seul l'événement les couvre tous les trois. WebKit le
   * dit par `webkitcurrentplaybacktargetiswirelesschanged`, l'API standard par les changements
   * d'état de `remote`. On rend alors la main au lecteur natif, à la position atteinte.
   *
   * Non détecté, on **reste** sur ce lecteur : le pire cas est le comportement d'avant, jamais
   * pire. C'est ce qui permet de tenter le retour sans risquer d'y perdre la lecture.
   */
  /**
   * Rendre la main, sur demande.
   *
   * Le geste que le spectateur fait quand il a ouvert le sélecteur puis choisi de rester sur son
   * téléphone : il n'a rien diffusé, donc aucun événement ne se déclenchera jamais, et sans ceci
   * il resterait sur ce lecteur jusqu'à la fin du film.
   */
  const handleCastReturn = useCallback(() => {
    // Pas `currentTime || 0` : une diffusion quittée pendant son chargement n'a pas encore posé sa
    // position, et le film repartait du début — voir `castHandBackPosition`.
    onCastEnded?.(castHandBackPosition(videoRef.current?.currentTime ?? 0, lastKnownTime.current, lastPlaybackOpts.current?.resumeAt));
  }, [onCastEnded]);

  const castAttempted = useRef(false);
  /**
   * Quelque chose diffuse-t-il vraiment ?
   *
   * Tenu par l'écouteur ci-dessous et par lui seul. Deux endroits qui observeraient le même état
   * finiraient par ne plus être d'accord, et celui-ci décide d'un mot que le spectateur lit.
   */
  const [castActive, setCastActive] = useState(false);
  const castActiveRef = useRef(false);
  /**
   * La diffusion s'est arrêtée toute seule, et on ne peut pas la relancer en silence.
   *
   * Relancer un flux veut dire ouvrir une nouvelle session HLS, ce que WebKit ne permet pas dans
   * la même page : il faut un élément neuf, ou un rechargement. Or la route AirPlay appartient à
   * l'élément — « rattraper » et « mettre fin à la diffusion » sont donc le même geste. C'est
   * exactement pour cela que l'ancienne échelle de reprise ressemblait à une réparation et était
   * le défaut.
   *
   * Puisqu'on ne peut pas réparer sans rompre, on le dit et on laisse le geste au spectateur :
   * mieux vaut un écran qui explique et un bouton, qu'un téléviseur figé sans raison.
   */
  const [castInterrupted, setCastInterrupted] = useState(false);

  /**
   * Refaire la bascule, sélecteur compris.
   *
   * La route est perdue : il n'y a rien à reprendre, seulement à recommencer. Le verrou du
   * sélecteur est relâché — sans quoi il ne s'ouvrirait pas une seconde fois — et l'échelle de
   * reprise repart de zéro, parce que la panne précédente n'apprenait rien sur les codecs.
   */
  // Fonction simple, et non `useCallback` : elle n'est lue que par un bouton, et le compilateur
  // React refuse qu'un rappel mémoïsé modifie une référence qu'un crochet a déjà reçue.
  function relaunchCast() {
    castAttempted.current = false;
    // `castActiveRef` n'est pas touché ici, et c'est son invariant : il appartient à l'écouteur de
    // diffusion et à lui seul. Le laisser à « vrai » le temps de la relance est d'ailleurs la
    // bonne valeur — si la nouvelle tentative échoue à son tour, on remontre cet écran-ci plutôt
    // que de repartir dans l'échelle de reprise, qui n'a rien à faire ici.
    nativeErrorRetryCount.current = 0;
    setCastInterrupted(false);
    setLoading(true);
    startPlaybackRef.current({
      ...lastPlaybackOpts.current,
      resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt,
    });
  }
  useEffect(() => {
    const video = videoRef.current as CastCapableVideo | null;
    if (!video || !castSession) return;

    const openPicker = () => {
      if (castAttempted.current) return;
      castAttempted.current = true;
      try {
        if (typeof video.webkitShowPlaybackTargetPicker === "function") video.webkitShowPlaybackTargetPicker();
        else void video.remote?.prompt().catch(() => {});
      } catch {
        // Refusé faute d'activation : le bouton du menu reste, et son appui en portera une.
      }
    };
    // Dès que l'image est là — pas avant : un sélecteur ouvert sur un élément sans source ne
    // propose rien à quoi se connecter.
    if (video.readyState >= 1) openPicker();
    else video.addEventListener("loadedmetadata", openPicker, { once: true });

    /**
     * Rendre la main, en disant d'où vient la décision.
     *
     * Sans cette ligne, une diffusion qui s'arrête ne laisse aucune trace : le journal ne montre
     * que le lecteur natif qui redémarre, sans dire si c'est le téléviseur qui a lâché, le centre
     * de contrôle du téléphone, ou nous. C'est précisément ce qui a coûté une demi-journée à
     * comprendre le 19/09/2026, et la question se reposera.
     */
    const ended = (source: string) => {
      reportPlayback("fallback", {
        itemId,
        title,
        reason: `fin de diffusion (${source})`,
        at: Math.round(video.currentTime || 0),
      });
      onCastEnded?.(castHandBackPosition(video.currentTime, lastKnownTime.current, lastPlaybackOpts.current?.resumeAt));
    };
    const setActive = (active: boolean) => {
      // Établie, et pas seulement demandée : sans cette ligne, un téléviseur resté en chargement
      // ne se distinguait pas d'un téléviseur qui jouait (22/09/2026).
      if (active && !castActiveRef.current) reportPlayback("cast", castEstablishedFields(logContext.current, video.currentTime || 0));
      castActiveRef.current = active;
      setCastActive(active);
    };
    const onWirelessChanged = () => {
      const wireless = video.webkitCurrentPlaybackTargetIsWireless === true;
      // Ne rend la main que si quelque chose diffusait : l'événement se déclenche aussi en
      // arrivant, et un « faux » de départ n'est pas une diffusion qui s'arrête.
      const wasActive = castActiveRef.current;
      setActive(wireless);
      if (!wireless && wasActive) ended("route sans fil perdue");
    };
    const onConnect = () => setActive(true);
    const onDisconnect = () => {
      const wasActive = castActiveRef.current;
      setActive(false);
      if (wasActive) ended("appareil distant déconnecté");
    };
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWirelessChanged);
    video.remote?.addEventListener?.("connect", onConnect);
    video.remote?.addEventListener?.("disconnect", onDisconnect);

    return () => {
      video.removeEventListener("loadedmetadata", openPicker);
      video.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWirelessChanged);
      video.remote?.removeEventListener?.("connect", onConnect);
      video.remote?.removeEventListener?.("disconnect", onDisconnect);
    };
    // `itemId` et `title` ne servent qu'à nommer la ligne de journal ; les mettre en dépendance
    // réarmerait les écouteurs de diffusion sur un changement d'épisode, ce qui perdrait la route
    // en cours. Ils ne changent pas sans que cet effet ne soit déjà remonté par `videoKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castSession, onCastEnded, videoKey]);

  // Ends playback entirely (not just minimize) when the video finishes — same in both modes.
  //
  // Sauf s'il y a un épisode suivant : la carte et son décompte (PlayerControls) s'affichent à la
  // toute dernière seconde quand l'épisode n'a pas de repère de générique, et la fermeture à
  // `ended` les coupait net — l'épisode suivant ne venait jamais sur ce lecteur, alors que le
  // lecteur natif, lui, reste ouvert et laisse le décompte finir (relu le 24/09/2026). Pas dans le
  // mini-lecteur, qui n'a pas de commandes et donc pas de carte : il se ferme comme avant.
  //
  // Resté ouvert, il annonce quand même la fin à Jellyfin tout de suite, comme le lecteur natif :
  // c'est cet arrêt qui marque l'épisode vu, et il ne partait sinon qu'au passage à l'épisode
  // suivant ou à la fermeture — jamais, pour une page tuée pendant la question « toujours là ? »
  // (relu le 24/09/2026). Relancé après, l'épisode rouvre sa séance.
  const hasNextEpisode = nextEpisode !== null && mode !== "mini";
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let endStopped = false;
    function onEnded() {
      if (!hasNextEpisode) {
        handleClose();
        return;
      }
      endStopped = true;
      void stopPlaybackNow();
    }
    function onPlay() {
      if (!endStopped) return;
      endStopped = false;
      resumePlaybackSession();
    }
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    return () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
    };
  }, [handleClose, videoKey, hasNextEpisode, stopPlaybackNow, resumePlaybackSession]);

  // Tracked independently of PlayerControls (which keeps its own copy for the full-mode UI)
  // so the mini player's play/pause icon stays correct without threading state through props.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [videoKey]);

  // Drives the ">3s, still working on it" reassurance line — heavy 4K track switches can
  // legitimately spend 15-20s across the post-reload grace delay, codec fallback ladder and
  // reload escalation, and a bare spinner that long reads as a hang worth force-closing.
  useEffect(() => {
    if (!loading && !reconnecting) {
      // Deferred (timeout 0) rather than set synchronously in the effect body — same outcome,
      // without the render-cascade pattern the react-hooks/set-state-in-effect rule flags.
      const clear = setTimeout(() => setLoadingLong(false), 0);
      return () => clearTimeout(clear);
    }
    const t = setTimeout(() => setLoadingLong(true), 3000);
    return () => clearTimeout(t);
  }, [loading, reconnecting]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      // Pas tant que rien n'est chargé : un changement de source remet l'élément à zéro et émet
      // un `timeupdate` à 0 — qui écrasait la position connue, puis celle de Jellyfin au premier
      // battement (relevé le 23/09/2026). La position semée par `startPlayback` tient jusque-là.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      lastKnownTime.current = video.currentTime;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoKey]);

  // Bad-connection badge: a real stall mid-playback ('waiting' firing after the video has
  // already played at least once — excludes ordinary startup buffering) is logged with a
  // timestamp; a periodic check then looks at how many landed in the last 60s, combined with
  // the decoder's own dropped-frame ratio, to decide whether to show the badge. Both are actual
  // measured signals, not a guess — see badConnection's own comment for why not a fabricated
  // "latency" number.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => {
      hasPlayedOnce.current = true;
    };
    const onSeeking = () => {
      lastSeekAt.current = Date.now();
    };
    const onWaiting = () => {
      if (hasPlayedOnce.current && Date.now() - lastSeekAt.current > 2000) rebufferTimestamps.current.push(Date.now());
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("waiting", onWaiting);

    const interval = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      rebufferTimestamps.current = rebufferTimestamps.current.filter((t) => t > cutoff);
      const quality = video.getVideoPlaybackQuality?.();
      let droppedRatio = 0;
      if (quality) {
        const prev = lastQuality.current;
        const deltaTotal = prev ? quality.totalVideoFrames - prev.total : 0;
        const deltaDropped = prev ? quality.droppedVideoFrames - prev.dropped : 0;
        if (deltaTotal > 0) droppedRatio = deltaDropped / deltaTotal;
        lastQuality.current = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
      }
      setBadConnection(rebufferTimestamps.current.length >= 2 || droppedRatio > 0.02);
    }, 5000);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onWaiting);
      clearInterval(interval);
    };
  }, [videoKey]);

  // The native <video> "error" event is the ONLY failure signal for the DirectPlay and native
  // Safari-HLS paths (both are a plain `video.src = manifestUrl`, no hls.js involved, so none of
  // the Hls.Events.ERROR retry/recovery logic above ever applies to them). Nothing was listening
  // for it at all — a genuine failure there (e.g. Jellyfin failing to build a remux session for a
  // newly requested audio track) left `loading` stuck at `true` forever, an infinite spinner with
  // no way out. code 1 (MEDIA_ERR_ABORTED) is excluded: it fires as an expected side effect of
  // every deliberate `video.src = ...; video.load()` reassignment in startPlayback itself
  // (switching audio/subtitle, retrying) aborting whatever the previous src was doing — not a
  // real failure, and treating it as one would surface a false error on every track switch.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function onError() {
      const code = video!.error?.code;
      if (code === MediaError.MEDIA_ERR_ABORTED) return;
      /**
       * Pendant une diffusion, cet élément ne lit rien — et son erreur n'en est pas une.
       *
       * En AirPlay, le téléviseur décode et l'élément local ne sert plus que de télécommande :
       * WebKit y signale des erreurs qui décrivent sa propre situation, pas celle de la lecture.
       * L'échelle ci-dessous les prenait pour une panne, et sa toute première marche rejoue la
       * requête — `video.src = …` — ce qui **rompt la route AirPlay**. Le téléviseur s'arrête, la
       * page reprend la main, et le lecteur natif redémarre. Le journal le montrait sans qu'on
       * l'ait lu ainsi : après chaque bascule vers la diffusion, un `start` du lecteur natif
       * quarante-cinq secondes plus tard, systématiquement. Signalé le 19/09/2026 — « ça bloque au
       * bout d'environ trente secondes ».
       *
       * Une vraie panne pendant la diffusion se voit ailleurs, et de la bonne façon : c'est le
       * téléviseur qui lâche la route, et l'écouteur de `webkitcurrentplaybacktargetiswireless`
       * rend alors la main proprement, à la position atteinte.
       */
      if (castActiveRef.current) {
        reportPlayback("error", {
          itemId,
          title,
          reason: "erreur pendant une diffusion — reprise refusée, relance proposée",
          code: code ?? 0,
        });
        // Ni reprise ni échelle : voir `castInterrupted`. L'écran prend le relais.
        setReconnecting(false);
        setLoading(false);
        setCastInterrupted(true);
        return;
      }
      // Walks AUDIO_FALLBACK_RUNGS (see its comment for the why): rung 0 replays the identical
      // request (absorbs transient teardown races and learns nothing), each further rung
      // disables more audio codecs until the AAC-only rung guarantees a clean server-side audio
      // transcode. The rung whose exclusions finally make the load succeed gets persisted by the
      // 'loadeddata' handler, so future loads on this browser skip the failure dance entirely.
      if (nativeErrorRetryCount.current < AUDIO_FALLBACK_RUNGS.length) {
        const rung = AUDIO_FALLBACK_RUNGS[nativeErrorRetryCount.current];
        nativeErrorRetryCount.current += 1;
        const delay = 1200 * nativeErrorRetryCount.current;
        setReconnecting(true);
        if (nativeErrorRetryTimer.current) clearTimeout(nativeErrorRetryTimer.current);
        nativeErrorRetryTimer.current = setTimeout(() => {
          /**
           * Relu au moment d'agir, pas seulement au moment de l'erreur.
           *
           * Entre les deux il s'écoule plus d'une seconde, et c'est exactement la fenêtre dans
           * laquelle le spectateur choisit son téléviseur dans le sélecteur : l'erreur précède la
           * connexion, la garde du dessus la laisse passer, et la reprise arrive une seconde trop
           * tard pour rompre une diffusion qui vient tout juste de s'établir. Deux lectures du même
           * drapeau, aux deux instants où il peut décider.
           */
          if (castActiveRef.current) {
            reportPlayback("error", {
              itemId,
              title,
              reason: "reprise abandonnée : une diffusion s'est établie entre-temps",
            });
            setReconnecting(false);
            return;
          }
          startPlaybackRef.current({
            ...lastPlaybackOpts.current,
            resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt,
            disableAudioCodecs: [...new Set([...(lastPlaybackOpts.current?.disableAudioCodecs ?? []), ...rung])],
          });
        }, delay);
        return;
      }
      // Ladder exhausted. On WebKit, one final escalation before giving up: a fresh full page
      // reload — the only teardown that reliably releases every media-daemon session this page
      // has accumulated, including the zombie attempts each failed retry above just created —
      // whose grace-delayed restart (see fromReload) then loads into a genuinely clean slate.
      // Strictly bounded by the attempt counter carried in the intent so two exhausted ladders
      // can never reload-loop forever.
      if ((reloadAttempt ?? 0) < 1 && isWebKit() && video!.canPlayType("application/vnd.apple.mpegurl")) {
        try {
          const audioIdx = lastPlaybackOpts.current?.audioStreamIndex;
          sessionStorage.setItem(
            PLAYER_RELOAD_INTENT_KEY,
            JSON.stringify({
              itemId,
              title,
              resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt || 0,
              attempt: (reloadAttempt ?? 0) + 1,
              ...(audioIdx !== undefined ? { audioStreamIndex: audioIdx } : {}),
            })
          );
          video!.pause();
          video!.removeAttribute("src");
          video!.load();
          window.location.reload();
          return;
        } catch {
          // Storage unavailable — fall through to the error UI below.
        }
      }
      setReconnecting(false);
      setLoading(false);
      setError(t('player.playbackInterrupted'));
    }
    video.addEventListener("error", onError);
    return () => video.removeEventListener("error", onError);
    // t (from useT()) only changes on a locale switch mid-playback, not worth re-binding this
    // listener for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, itemId, title, reloadAttempt]);

  // Browser-level connectivity, independent of hls.js's own retry state — shows the "Vous êtes
  // hors ligne" banner immediately on disconnect (like YouTube), rather than waiting for a
  // fragment request to actually time out and surface as a network error first.
  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(mode === "mini", handleExpand);
  // A rotation resizes the player; it should not *animate* that resize (see the hook).
  const resizing = useViewportResizing();

  // Tab order follows DOM order, not visual stacking — without this, keyboard focus is left
  // wherever it was on the page that opened playback (e.g. Cinema Mode's "Lecture" row, which
  // stays mounted underneath at a lower z-index) instead of moving into the now-visible player,
  // so Tab/Enter appear to do nothing. One frame after mounting full-screen, land specifically on
  // play/pause (data-player-nav="playpause", not just "the first button" — the skip/rewind
  // buttons sitting either side of it in DOM order made that unpredictable) so keyboard control
  // starts on the one control every remote/keyboard user reaches for first.
  // A single requestAnimationFrame here isn't enough: PlayerControls only renders the
  // play/pause button once `!loading && !buffering` (a spinner shows until then), and mode
  // flips to "full" the instant playback.play() is called — long before the stream has actually
  // loaded. That one-shot attempt was landing on nothing, silently, so focus just stayed
  // wherever it was (a Cinema Mode menu row, hidden behind the player) — which then made
  // PlayerControls' own "don't steal Space from a focused button" guard swallow Space too,
  // since SOME button still technically had focus, just the wrong one. Poll instead, until the
  // button actually exists (or mode changes away from full).
  useEffect(() => {
    if (mode !== "full") return;
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      const btn = containerRef.current?.querySelector<HTMLButtonElement>('[data-player-nav="playpause"]');
      if (btn) {
        btn.focus();
        clearInterval(id);
      } else if (attempts > 40) {
        // ~10s cap — a fatal load error keeps `loading` true forever with no button to ever
        // find, so this has to give up eventually rather than poll indefinitely.
        clearInterval(id);
      }
    }, 250);
    return () => clearInterval(id);
  }, [mode]);

  function toggleMiniPlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  if (typeof document === "undefined") return null;

  const isMini = mode === "mini";
  const TRANSITION = "top 300ms cubic-bezier(0.4,0,0.2,1), left 300ms cubic-bezier(0.4,0,0.2,1), width 300ms cubic-bezier(0.4,0,0.2,1), height 300ms cubic-bezier(0.4,0,0.2,1), border-radius 300ms cubic-bezier(0.4,0,0.2,1)";

  const style: React.CSSProperties = isMini
    ? {
        position: "fixed",
        top: pos.y,
        left: pos.x,
        width: size.width,
        height: size.height,
        borderRadius: 16,
        zIndex: 80,
        overflow: "hidden",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
        transition: isDragging || resizing ? "none" : TRANSITION,
        touchAction: "none",
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        borderRadius: 0,
        zIndex: 80,
        background: "black",
        transition: resizing ? "opacity 200ms ease-out" : `${TRANSITION}, opacity 200ms ease-out`,
        opacity: closing ? 0 : 1,
      };

  return createPortal(
    <div
      ref={containerRef}
      style={style}
      // app-viewport rather than an inline 100dvh — see its note in globals.css: the right unit
      // for a full-screen shell differs between a browser tab and an installed PWA.
      className={isMini ? "animate-fade-in-scale" : "app-viewport"}
      {...(isMini ? handlers : {})}
    >
      {needsReauth ? (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div>
            <p className="mb-4 text-sm text-white">{t('player.sessionExpired')}</p>
            <a
              href={`/login?reason=playback&next=${encodeURIComponent(window.location.pathname)}`}
              className="btn-primary inline-flex justify-center"
            >
              {t('player.reconnect')}
            </a>
          </div>
        </div>
      ) : (
        <>
          {/* Kept mounted even while `error` is showing, so `lastKnownTime`/hls state aren't
              lost and "Réessayer" can resume from where playback actually stopped, instead of
              from the beginning. `key` changes (WebKit track switches only) intentionally force
              a full remount — see videoKey's own comment above. */}
          <video
            key={videoKey}
            ref={videoRef}
            playsInline
            autoPlay
            className={isMini ? "h-full w-full object-cover" : "h-full w-full"}
            {...{ "x-webkit-airplay": "allow" }}
          >
            {externalSubtitleTracks.map((t) => (
              <track key={t.index} kind="subtitles" src={t.url} srcLang={t.language ?? undefined} label={t.label} />
            ))}
          </video>
          {/* La diffusion interrompue passe devant l'erreur ordinaire : elle a son propre geste,
              et proposer « Réessayer » ici ne voudrait rien dire — il n'y a plus de route à
              reprendre, seulement une bascule à refaire. */}
          {/* La conséquence, dite avant le geste. Voir `requestAudioChange`. */}
          {/* `z-30`, au-dessus des contrôles (`z-10`, peints après) : à égalité, ils recouvraient ces
              deux écrans et prenaient chaque appui — aucun de leurs boutons ne répondait, le film
              restait sous un voile noir pendant une diffusion (relevé le 23/09/2026). */}
          {pendingAudioTrack !== null && !isMini && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 px-6 text-center">
              <div className="max-w-md">
                <p className="mb-4 text-sm text-white">{t("player.castAudioWarning")}</p>
                <div className="flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setPendingAudioTrack(null)}
                    className="btn btn-ghost px-4 py-2"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const id = pendingAudioTrack;
                      setPendingAudioTrack(null);
                      changeAudio(id);
                    }}
                    className="btn-primary inline-flex justify-center"
                  >
                    {t("player.castAudioContinue")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {castInterrupted && !isMini && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 px-6 text-center">
              <div>
                <p className="mb-4 text-sm text-white">{t("player.castInterrupted")}</p>
                <div className="flex justify-center gap-3">
                  <button type="button" onClick={handleClose} className="btn btn-ghost px-4 py-2">
                    {t("player.quit")}
                  </button>
                  <button type="button" onClick={relaunchCast} className="btn-primary inline-flex justify-center">
                    {t("player.castRelaunch")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {error && !castInterrupted && !isMini && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
              <div>
                <p className="mb-4 text-sm text-red-400">{error}</p>
                <div className="flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="btn btn-ghost px-4 py-2"
                  >
                    {t('player.quit')}
                  </button>
                  <button type="button" onClick={handleRetry} className="btn-primary inline-flex justify-center">
                    {t('common.retry')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* Sous la roue d'attente, et non en bas de l'écran.
              Ces messages — « le chargement est toujours en cours », « reconnexion », « hors
              ligne » — étaient collés au bord inférieur, c'est-à-dire exactement là où la barre de
              progression et les commandes se posent : elles passaient par-dessus et le message
              devenait illisible au moment précis où il sert. Signalé le 19/09/2026.

              Ils rejoignent donc la roue, qui est déjà au centre et dit la même chose sans les
              mots : un demi-écran plus deux rems et demie, soit juste sous elle. Et un plan
              au-dessus des commandes, pour que plus rien ne les recouvre. */}
          {!error && !isMini && (isOffline || reconnecting || (loading && loadingLong)) && (
            <div
              className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-6"
              style={{ top: "calc(50% + 2.5rem)" }}
            >
              <div className="rounded-full bg-black/80 px-4 py-1.5 text-center text-xs text-white shadow-lg ring-1 ring-white/10">
                {isOffline
                  ? t('player.offline')
                  : loadingLong
                    ? t('player.stillLoading')
                    : t('player.reconnecting')}
              </div>
            </div>
          )}
          {/* Non-interactive by design — a measured signal (recent rebuffers + decoder dropped-
              frame ratio, see badConnection's own comment), not a settings toggle with a detail
              view to open. En haut à droite pour ne jamais recouvrir la pastille ci-dessus, que
              les deux peuvent légitimement afficher en même temps (hors ligne *et* déjà en train
              de se remplir). Elles se croisaient d'autant moins quand celle-ci était en bas ;
              depuis qu'elle est sous la roue, l'écart reste large — un demi-écran contre 4,5 rem. */}
          {!error && !isMini && badConnection && (
            <div
              className="pointer-events-none absolute z-20 rounded-full bg-black/80 px-3 py-1 text-xs text-amber-300 shadow-lg ring-1 ring-white/10"
              style={{ top: "max(4.5rem, calc(env(safe-area-inset-top) + 6rem))", right: "max(1rem, env(safe-area-inset-right))" }}
            >
              {t("player.badConnection")}
            </div>
          )}
        </>
      )}
      {!isMini && (
        <PlayerControls
          key={videoKey}
          videoRef={videoRef}
          containerRef={containerRef}
          itemId={itemId}
          title={title}
          onClose={handleClose}
          onMinimize={playback.minimize}
          onTogglePlaybackInfo={() => setShowPlaybackInfo((v) => !v)}
          audioTracks={audioTracks}
          currentAudioId={currentAudioId}
          onChangeAudio={requestAudioChange}
          subtitleTracks={subtitleTracks}
          currentSubtitleId={currentSubtitleId}
          onChangeSubtitle={changeSubtitle}
          hidden={!!error || needsReauth}
          loading={loading}
          introSkip={introSkip}
          creditsStart={creditsStart}
          nextEpisode={nextEpisode}
          onAdvance={handleAdvance}
          /* La sortie de diffusion, et seulement quand cette séance existe pour ça. Elle ne
             dépend d'aucun événement : c'est ce qui la rend sûre là où la détection, elle, ne
             peut pas être éprouvée depuis le serveur. Voir `onCastReturn`. */
          onCastReturn={castSession ? handleCastReturn : undefined}
          castActive={castActive}
        />
      )}
      {!isMini && (
        <PlaybackInfoPanel
          open={showPlaybackInfo}
          onClose={() => setShowPlaybackInfo(false)}
          data={
            playbackInfo
              ? {
                  ...describeJellyfinPlayback(playbackInfo, networkBitrate, fallbackReason, t),
                  // Le même rapport copiable que le lecteur natif : c'est ce qui manquait ici,
                  // et c'est justement la lecture dont on a le plus de mal à rapporter l'état.
                  report: {
                    error: null,
                    elapsedMs: null,
                    title,
                    itemId,
                    file: playbackInfo as unknown as Record<string, unknown>,
                    pathReason: `Lecteur stable — ${playbackInfo.playMethod}`,
                    diagnostics: networkBitrate ? { "Débit estimé": `${(networkBitrate / 1_000_000).toFixed(1)} Mb/s` } : {},
                    running: true,
                  },
                }
              : null
          }
        />
      )}
      {isMini && !error && !needsReauth && (
        <MiniPlayerChrome title={title} playing={playing} onTogglePlay={toggleMiniPlay} onClose={handleClose} />
      )}
    </div>,
    document.body
  );
}
