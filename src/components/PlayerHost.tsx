"use client";

import { OfflinePlayerHost } from "@/components/offline/OfflinePlayerHost";
import { useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import { createPortal, flushSync } from "react-dom";
import { usePlaybackSession, stopOrphanSession } from "@/lib/usePlaybackSession";
import { refreshAfterPlayback } from "@/lib/swr";
import { useSceneMode, isSceneNow, sceneCarryOf, type SceneSession } from "@/lib/sceneMode";
import { UPSTREAM_UNREACHABLE } from "@/lib/http";
import { apiErrorText } from "@/lib/apiErrorText";
import { withCode } from "@/lib/upstreamError";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { useStableFallback, takeoverFor, castCarriedTo, returningFor, returnsPaused, castHandBackPosition, type StableTakeover } from "@/lib/useStableFallback";
import { ChromecastPlayer } from "@/components/player/ChromecastPlayer";
import { choosePlayer } from "@/lib/playerRoute";
import { publishHandedOver } from "@/lib/playerBench/bridge";
import { PlayerControls, type Track } from "@/components/PlayerControls";
import { restoreRememberedVolume } from "@/lib/rememberedVolume";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { usePlayerFocus } from "@/lib/usePlayerFocus";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { pickMaxBitrate } from "@/lib/networkBitrate";
import { ServerStartup, resourceEntries } from "@/lib/serverStartup";
import { PlaybackTimeline, TIMELINE_EVERY_MS, bufferedAhead, elementState, registerTimeline } from "@/lib/playbackTimeline";
import {
  LinkMeter,
  SLOW_LINK_REASON,
  frozenReading,
  linkVerdictWord,
  meterXhr,
  readLink,
  slowLinkFields,
  slowLinkVerdict,
  streamNeedBps,
  type LinkReading,
  type SlowLink,
} from "@/lib/slowLink";
import {
  LONG_STALL_MS,
  LinkRecovery,
  PLAYBACK_MEASURE_WINDOW_MS,
  RECOVERY_WINDOW_MS,
  SlowLog,
  StutterWatch,
  mbps,
  measuredBps,
  decideOpening,
  decidePlayback,
  playbackLinkSlow,
  type LighterStep,
} from "@/lib/slowLinkPolicy";
import { cancelPrewarm, carryPrewarmAcrossReload, discardTakenPrewarm, prewarmFields, prewarmFits, takeOrdinaryPrewarm, takePrewarm, warmSegmentAt, type Prewarm } from "@/lib/lighterPrewarm";
import { directReloadIntent, reloadLighterOf, reloadPage, shouldReloadDirect, type PlayerReloadIntent } from "@/lib/serverReload";
import { SlowLinkRunner, type SeekSignal, type SlowLinkHost } from "@/lib/slowLinkRunner";
import { forgetLighterCarry, readPlaybackQuality, rememberLighter, usePlaybackQuality } from "@/lib/playbackQuality";
import { simulatorActive, throttledHlsLoader } from "@/lib/linkSimulator";
import { hlsRecoveryPosition, hlsResetItself, livePosition } from "@/lib/hlsRecovery";
import { noteSeriesLanguage } from "@/lib/noteSeriesLanguage";
import { toJellyfinLanguage } from "@/lib/trackPreferences";
import { pushSlowLinkEvent } from "@/lib/slowLinkMonitor";

/** Pas d'indice : l'état ordinaire d'un chargement (§78). */
type LinkSignal = { hint: boolean; recvBps: number | null; needBps: number | null };
const NO_LINK_SIGNAL: LinkSignal = { hint: false, recvBps: null, needBps: null };
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import { useAccountPreferencesLoader } from "@/lib/useAccountPreferences";
import { usePlayerServerFallback } from "@/lib/usePlayerEnabled";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";
import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { describeJellyfinPlayback, splitCodecs, type JellyfinPlayback, type LighterOrigin } from "@/lib/playbackPanel";
import { PLAYER_FRAME_TRANSITION } from "@/lib/playerFrame";
import { NETWORK_OUTAGE_GIVE_UP_MS } from "@/lib/networkOutage";
import { usePlayback, PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import { playsHlsNatively } from "@/lib/webkitEngine";
import { detectCodecSupport } from "@/lib/codecSupport";
import { useT, useLocale } from "@/components/TranslationProvider";
import { useWakeLock } from "@/lib/useWakeLock";
import { reportPlayback } from "@/lib/reportPlayback";
import {
  serverStartFields,
  serverFailureFields,
  castEstablishedFields,
  castEndedFields,
  castResumeFields,
  serverStopFields,
  serverSleepFields,
  isServerRestart,
  type ServerPlayerContext,
  type ServerStartCause,
  type ServerStartWhy,
  type ServerStopWhy,
} from "@/lib/serverPlayerLog";
import { saveUnsentStop, clearUnsentStop } from "@/lib/unsentStop";
import { useSleepTimer } from "@/lib/useSleepTimer";
import { sleepTimerLogFields, sleepTimerStore, type SleepMode } from "@/lib/sleepTimer";
import { CastResume } from "@/lib/castResume";
import { castRouteActive } from "@/lib/castRoute";
import { SessionTally, WatchedClock, newPlayerSessionId, watchElementWaits } from "@/lib/playerSessionTally";
import { positionBucket, retrySignature } from "@/lib/retryLedger";
import { noteWatching, openingPosition, pauseRewindTarget } from "@/lib/resumeRewind";
import { resolveResumeAt } from "@/lib/resumePosition";
import { touchHintHeaders } from "@/lib/deviceLabel";
import { subtitleStyleStore, type ChromeEdges } from "@/lib/subtitleStyle";
import { SubtitleLayer } from "@/components/player/SubtitleLayer";
import { dualSubtitleMemory, pickRememberedDual, rememberDual } from "@/lib/dualSubtitles";
import { useServerDualSubtitles } from "@/lib/useServerDualSubtitles";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { finishIntro, introAllowedFor, introCaption, introFinished, introKey, startIntroClock } from "@/lib/playbackIntro";
import { useServerIntroPicture } from "@/lib/introEnd";
import { usePlayerBackClose } from "@/lib/playerHistory";
import { PlayerReauthScreen } from "@/components/player/PlayerReauthScreen";

/** Les adresses du flux du lecteur serveur, pour les entrées de ressources de Safari (§77). */
const STREAM_PREFIX = "/api/jellyfin/stream/";

export type PlayMethod = JellyfinPlayback["playMethod"];

/**
 * Ce que la route de lecture rend au lecteur serveur : la description de `JellyfinPlayback`
 * (`playbackPanel.ts`, la même que lit le panneau) — écrite ici en double jusqu'au 22/10/2026 —,
 * plus ce que seule la négociation connaît.
 */
export interface PlaybackInfoSummary extends JellyfinPlayback {
  requestedVideoCodecs: string[];
  /** Ce que le maître annonce (HLS natif seulement : la route le lit en le préchauffant). */
  served?: { codecs: string | null; videoRange: string | null } | null;
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

/** Une piste de ce lecteur, dans les termes du choix des pistes (`trackPreferences`) — §87. */
function subtitleFacts(st: ExternalSubtitleTrack) {
  return {
    number: st.index,
    language: st.language ?? null,
    name: st.title ?? null,
    isDefault: st.isDefault,
    isForced: st.isForced ?? false,
    isHearingImpaired: st.isHearingImpaired,
  };
}

function subtitleFactsOf(tracks: readonly ExternalSubtitleTrack[], id: number | null) {
  const found = id === null ? undefined : tracks.find((st) => st.index === id);
  return found ? subtitleFacts(found) : null;
}

const MAX_NETWORK_RETRIES = 6;
/**
 * Une coupure du lecteur serveur (hls.js) : l'écran « La lecture a été interrompue » au plus tard
 * 48 s après son premier signe — comme avec hls.js 1.5.17 (décision de Louis du 15/10/2026).
 *
 * hls.js 1.7 attend lui-même le réseau : une requête sans réponse alors que `navigator.onLine` est
 * faux met le chargement en attente **sans fin** (`retryDate = Infinity`, « Waiting for connection
 * (offline) »), sans jamais déclarer de fatale — nos six relances ne partaient donc jamais, et l'écran
 * ne venait pas (mesuré dans Chrome hors ligne : plus de 5 min 30, image figée sous « hors ligne »).
 * Réduire `fragLoadPolicy.errorRetry` n'y change rien tant que `maxNumRetry` est au-dessus de zéro
 * (le chemin d'attente est pris pour un flux à niveau unique), et zéro supprimerait aussi les nouveaux
 * essais silencieux d'hls.js sur une erreur HTTP passagère. La borne est donc la nôtre, et la
 * politique d'hls.js reste la sienne : comptée dès la première requête sans réponse ou la première
 * fatale réseau, effacée au premier fragment accepté. Une coupure plus courte reprend seule, comme
 * avant ; au-delà, « Réessayer » repart de la position où l'image s'est figée (`lastKnownTime`).
 * Juste au-dessus des six relances (1 + 2 + 4 + 8 + 15 + 15 = 45 s), qui gardent la main là où hls.js
 * déclare la fatale lui-même (en ligne, serveur injoignable) : les deux bornes ne se croisent pas.
 *
 * La valeur est partagée avec le lecteur natif (`src/lib/networkOutage.ts`) ; exportée ici aussi,
 * pour qui la lit au nom du lecteur serveur.
 */
export { NETWORK_OUTAGE_GIVE_UP_MS };

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
//
// Ce qu'une marche a appris ne vaut que pour l'ouverture du lecteur en cours (`learnedExclusions`,
// épisodes enchaînés compris) : chaque nouvelle séance repart de la marche 0 (DECISIONS §67, décision
// du 11/10/2026). Les codecs exclus étaient retenus pour toujours par navigateur, quelle que soit la
// cause de l'échec — une coupure ou une image illisible suffisait à faire convertir l'E-AC3 par le
// serveur sur cet appareil, à jamais.
const AUDIO_FALLBACK_RUNGS: string[][] = [
  [], // replay the identical request first — absorbs transient teardown races, learns nothing
  ["eac3", "flac", "opus"], // keep aac+ac3, the two most reliably decoded codecs on Apple hw
  ["eac3", "flac", "opus", "ac3"], // AAC only — forces a clean server transcode, always works
];

/**
 * Après l'échelle du son, une marche pour l'image : H.264 seul, ré-encodé par Jellyfin (`videoH264Only`,
 * la route). Seulement sur une erreur de décodage (code 3, ou une erreur média de hls.js), une fois
 * par ouverture.
 *
 * L'échelle ne touchait que le son et la vidéo restait copiée telle quelle : un Android 10 dont le
 * décodeur HEVC s'était bloqué (19/10/2026, après une heure sans souci) a vu cinq ouvertures de titres
 * HEVC, film 4K comme épisode 1080p, rejouer la même image illisible jusqu'à l'écran d'erreur — alors
 * que ses films H.264 passaient dans la même soirée.
 */
const H264_RUNG = AUDIO_FALLBACK_RUNGS.length + 1;

/** L'échelon final : AAC seul, et le son ré-encodé plutôt que copié — voir `forceAudioTranscode`. */
function isLastAudioRung(index: number): boolean {
  return index === AUDIO_FALLBACK_RUNGS.length - 1;
}

/** L'ancienne mémoire permanente des codecs exclus, par navigateur — retirée le 11/10/2026 (§67). */
export const LEGACY_AUDIO_BLOCKLIST_KEY = "cine:audio-codec-blocklist:v1";
let legacyBlocklistPurged = false;

/**
 * Efface, une fois par page, ce que l'ancienne mémoire avait retenu : un appareil « banni » d'un
 * codec par un échec d'il y a des semaines repart propre, et l'échelle réessaie depuis la marche 0.
 */
export function purgeLegacyAudioBlocklist(): void {
  if (legacyBlocklistPurged) return;
  legacyBlocklistPurged = true;
  try {
    localStorage.removeItem(LEGACY_AUDIO_BLOCKLIST_KEY);
  } catch {
    // Stockage indisponible : il n'y a rien à lire non plus.
  }
}

/**
 * Ce que l'échelle a appris, porté à travers le rechargement de page du changement de piste sur
 * WebKit (`fromReload`) — qui continue la même séance : sans lui, chaque changement de langue sur un
 * iPhone rejouait les trois marches. `sessionStorage`, lu par cette seule ouverture rechargée et
 * effacé par toute autre : une nouvelle séance repart de la marche 0.
 */
const LADDER_CARRY_KEY = "cine:audio-ladder-carry:v1";

function carryLearnedExclusions(itemId: string, codecs: string[]): void {
  try {
    sessionStorage.setItem(LADDER_CARRY_KEY, JSON.stringify({ itemId, codecs }));
  } catch {
    // Stockage indisponible : le rechargement rejouera l'échelle, comme une séance neuve.
  }
}

/** Ce qu'un rechargement de la même séance a apporté — et la mémoire vidée dans tous les cas. */
function takeCarriedExclusions(itemId: string, fromReload: boolean | undefined): string[] {
  try {
    const raw = sessionStorage.getItem(LADDER_CARRY_KEY);
    sessionStorage.removeItem(LADDER_CARRY_KEY);
    if (!fromReload || !raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const { itemId: carriedFor, codecs } = parsed as { itemId?: unknown; codecs?: unknown };
    if (carriedFor !== itemId || !Array.isArray(codecs)) return [];
    return codecs.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

/** Pour les tests : la purge se refait à la prochaine négociation. */
export function __resetLegacyBlocklistPurgeForTests(): void {
  legacyBlocklistPurged = false;
}

/**
 * Couper l'élément : pause, plus de source, `load()` pour que le navigateur lâche la session HLS.
 * Écrit à l'identique à quatre endroits jusqu'au 22/10/2026 ; chaque appelant garde sa propre garde
 * (`try`) et ce qui suit (rechargement ou non). Peut lever sur un élément déjà démonté.
 */
function releaseHlsElement(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/**
 * Écrit l'intention que la page rechargée relira (`PlaybackProvider`). Faux si le stockage la refuse :
 * l'appelant garde alors son chemin d'avant (la lecture dans la page, ou l'écran d'erreur).
 */
function reloadIntoServerPlayer(intent: PlayerReloadIntent): boolean {
  try {
    sessionStorage.setItem(PLAYER_RELOAD_INTENT_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
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
  // Les préférences du compte (langue, défilement guidé, disposition de l'accueil) : ce composant,
  // monté sur toutes les pages, en porte le chargeur. Le lecteur n'en dépend plus — le choix
  // « lecteur legacy » d'un compte a disparu le 13/10/2026, le natif ouvre toujours.
  useAccountPreferencesLoader();
  // Whether this install has a server-side player at all. When it does not, nothing below can
  // hand a file to Jellyfin: a refusal by the native path ends on a playback error instead.
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
  /**
   * La séance du journal que le lecteur serveur poursuit, quand il prend la main.
   *
   * Tenue à part du relais (`StableTakeover`) : un renoncement avant la première image n'en porte
   * pas — sa position serait inventée —, et c'est pourtant le repli le plus courant. Un lecteur
   * serveur ouvert directement n'en reçoit pas et crée la sienne. Même règle d'appartenance que le
   * relais : comparée par identité à la lecture en cours, pour qu'une réouverture du même film ne
   * se range pas dans la séance d'hier.
   */
  const [continued, setContinued] = useState<{ owner: unknown; id: string } | null>(null);
  // La séance est jointe au relais ici, et non par le lecteur natif : c'est ce niveau qui la
  // possède, et le relais ne doit valoir que pour elle — voir `StableTakeover.owner`.
  const handOver = useCallback(
    (reason: string, resumeInto?: StableTakeover, sessionId?: string) => {
      if (!itemId) return;
      // WebKit : le lecteur serveur lirait en HLS natif dans une page qui vient de servir le lecteur
      // natif — ce que WebKit refuse (code 4, aucun segment demandé, trois marches de l'échelle pour
      // rien : ~10 s perdues à chaque bascule le 12/10/2026). On passe directement par le rechargement
      // qui, lui, a toujours marché (`serverReload.ts`, DECISIONS §78). Une fois par séance.
      if (
        session &&
        shouldReloadDirect({ nativeHls: playsHlsNatively(), serverFallback, takeover: resumeInto, reloadAttempt: session.reloadAttempt, bench: session.bench }) &&
        reloadIntoServerPlayer(directReloadIntent(session, resumeInto, sessionId, reason))
      ) {
        // Le préchauffage prêt de la version allégée passe à la page suivante ; tout autre est arrêté
        // chez Jellyfin — le démontage qui l'aurait fait n'aura pas lieu.
        if (!(resumeInto?.lighter && carryPrewarmAcrossReload(itemId))) cancelPrewarm();
        reloadPage();
        return;
      }
      if (sessionId) setContinued({ owner: session, id: sessionId });
      stepAside(itemId, reason, resumeInto ? { ...resumeInto, owner: session } : undefined);
    },
    [itemId, session, stepAside, serverFallback]
  );

  /**
   * La diffusion s'est arrêtée : on rend la main au lecteur natif.
   *
   * `stepBack` ne le fait que si la bascule était une diffusion — une bascule d'échec qui
   * reviendrait rejouerait son échec en boucle. La règle vit là-bas, pas ici.
   */
  const handCastBack = useCallback(
    (resumeAt: number, paused = false) => {
      if (!itemId) return;
      // Un relais, pas une reprise : le lecteur natif ne recule pas de cinq secondes au retour
      // d'une diffusion de plus de dix minutes, pendant laquelle rien n'avait noté la lecture
      // (relu le 24/09/2026 — voir `resumeRewind.ts`).
      if (!session?.bench && !(session && isSceneNow(session))) noteWatching(itemId);
      stepBack(itemId, resumeAt, session, paused);
    },
    [itemId, session, stepBack]
  );

  if (!session) return null;
  // Un fichier téléchargé (bêta) : son propre lecteur, lu depuis l'appareil, sans attendre la
  // configuration du serveur ni passer par l'aiguillage — rien de la lecture en ligne n'est en jeu.
  if (session.offline) {
    return <OfflinePlayerHost key={`offline:${session.offline.id}:${session.openId ?? 0}`} session={session} mode={mode === "mini" ? "mini" : "full"} />;
  }
  // Waited for rather than assumed. Whichever player is assumed while the answer is in flight
  // mounts and *starts* — and for the server-side one that means negotiating a stream and
  // warming a transcode, which was then thrown away a round trip later. One request, once per
  // session, against an abandoned transcode on every playback. (La configuration publique est
  // gardée sur l'appareil et répond aussi sur une adresse publique : ce `return null` ne coupe pas
  // une séance en cours.)
  if (serverFallback === undefined) return null;

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
  const playing = back !== null ? { ...session, resumeAt: back, ...(returnsPaused(returning, session) ? { startPaused: true } : {}) } : session;

  const carried = castCarriedTo(takeover, session);
  // Natif, Chromecast ou serveur : la règle vit dans `choosePlayer` (`playerRoute.ts`).
  const route = choosePlayer(session, { serverFallback, handedOver, carried, takeover });
  if (route === "native") {
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

  // Vers un Chromecast, le relais n'est pas un lecteur mais une télécommande : le récepteur lit lui-même
  // le flux que Jellyfin lui prépare (DECISIONS.md §64). Même clé que le lecteur serveur, pour la
  // même raison : il enchaîne lui-même les épisodes, le relais reporté par `castCarriedTo`.
  if (route === "chromecast") {
    return (
      <ChromecastPlayer
        key={session.openId ?? 0}
        session={session}
        mode={mode === "mini" ? "mini" : "full"}
        takeover={carried ?? takeoverFor(takeover, session)}
        continuesSession={continued?.owner === session ? continued.id : undefined}
        onCastEnded={handCastBack}
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
        // La cause emportée par un rechargement direct : `useStableFallback` vit dans la page, et la page
        // rechargée ne la connaissait plus — la note « a cédé la main » disparaissait du panneau.
        fallbackReason={fallbackReason ?? session.reloadCarry?.reason ?? null}
        takeover={carried ?? takeover}
        // Un rechargement direct poursuit la séance que le natif avait ouverte (`reloadCarry.continues`).
        continuesSession={continued?.owner === session ? continued.id : session.reloadCarry?.continues}
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
 * L'ouverture, côté lecteur serveur : la même que celle du lecteur natif, et — quand il prend la
 * relève avant la première image — la même *instance visuelle* : l'horloge posée à l'appui la fait
 * reprendre au point où l'autre en était (`startIntroClock`), sans rejouer son apparition.
 *
 * Décidée au montage, comme chez le natif : une lecture qui a déjà montré une image — un relais en
 * plein film, une diffusion — n'en a pas. Ni une séance qui existe pour diffuser (`allowed`).
 */
function ServerPlayerIntro({
  session,
  allowed,
  loading,
  trouble,
  hidden,
  resumeSeconds,
  videoRef,
  onCoverChange,
  note,
  onClose,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  /** Le mot d'une attente longue (« toujours en cours… »), dit sous la ligne de l'ouverture. */
  note?: string | null;
  /** Le calque couvre-t-il le lecteur — l'hôte en tait la roue et le fil de ses commandes. */
  onCoverChange?: (covering: boolean) => void;
  allowed: boolean;
  /** Pas encore d'image : `loading` de ce lecteur, qui tombe à `loadeddata`. */
  loading: boolean;
  trouble: boolean;
  hidden: boolean;
  resumeSeconds: number | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const key = introKey(session.openId, session.itemId);
  const [eligible] = useState(() => allowed && introAllowedFor(session) && !introFinished(key));
  const [startedAt] = useState(() => startIntroClock(key));
  // Une image a été montrée : l'ouverture est finie pour cette lecture, quoi qu'il arrive ensuite
  // (un nouvel essai, un changement de piste remettent `loading` — ce n'est plus une ouverture).
  //
  // `loading` tombe à `loadeddata`, c'est-à-dire *avant* le saut vers la position de reprise : une
  // reprise laissait ~3 s d'écran noir entre l'ouverture effacée et l'image (vu en capture le
  // 10/10/2026, Forrest Gump repris à 21 min). L'image compte donc quand l'élément en a une à sa
  // position actuelle — plus de saut en cours, `readyState` ≥ 2 —, attendue par ses événements.
  const pictured = useServerIntroPicture(loading, videoRef);
  useEffect(() => {
    if (pictured) finishIntro(key);
  }, [pictured, key]);
  const phase: IntroPhase = !eligible || hidden ? "gone" : pictured ? "picture" : trouble ? "gone" : "waiting";
  if (phase === "gone") return null;
  return (
    <PlaybackIntro
      phase={phase}
      startedAt={startedAt}
      clockKey={key}
      art={session.introArt ?? null}
      // Ici l'image et la fin ne font qu'un (`useServerIntroPicture`) : l'ouverture posée au montage
      // s'efface sur elle — même règle que chez le natif.
      imageShown={pictured}
      onCoverChange={onCoverChange}
      fallbackName={session.title}
      caption={introCaption({ ...session.introArt, resumeSeconds }, t)}
      note={note ?? null}
      onClose={onClose}
      closeLabel={t("common.close")}
      className="absolute inset-0 z-[25]"
    />
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

/** Ce que reçoit `startPlayback` — et ce que rejoue une relance. */
interface StartOpts {
  audioStreamIndex?: number;
  resumeAt?: number;
  disableAudioCodecs?: string[];
  forceAudioTranscode?: boolean;
  /** Le recours de l'image (`H264_RUNG`) : H.264 seul, ré-encodé par Jellyfin. Gardé par les relances. */
  videoH264Only?: boolean;
  /** Pourquoi cette négociation — le `why` de la ligne `start` (`ServerStartWhy`). */
  cause?: ServerStartCause;
}

function ActivePlayer({
  session,
  mode,
  fallbackReason,
  takeover,
  continuesSession,
  onCastEnded,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  mode: "full" | "mini";
  /** Set when this player took over from the experimental one, and why. Shown in its panel. */
  fallbackReason?: string | null;
  /** Where to resume and on which track, when the handover happened mid-playback. */
  takeover?: StableTakeover | null;
  /** La séance du lecteur natif qui a passé la main, que ce lecteur poursuit dans le journal. */
  continuesSession?: string;
  /** Appelé quand la diffusion s'arrête, avec la position où elle s'est arrêtée. */
  /** `paused` : la diffusion s'est arrêtée d'elle-même — voir `returnsPaused`. */
  onCastEnded?: (resumeAt: number, paused?: boolean) => void;
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
    bench,
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
  /**
   * Une scène ouverte depuis une réplique (`sceneMode.ts`, DECISIONS.md §91) : rien de rapporté ni
   * de gardé pour une reprise tant qu'elle n'a pas joué dix minutes. Le décompte est celui de la
   * lecture : un relais du lecteur natif le continue. `isSceneRef` pour les écouteurs et les
   * fonctions aux dépendances figées.
   */
  const scene = useSceneMode(
    session,
    useCallback(() => {
      const video = videoRef.current;
      return !!video && !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    }, [])
  );
  const isSceneRef = useRef(scene.isScene);
  const sceneSessionRef = useRef<SceneSession>(session);
  useEffect(() => {
    isSceneRef.current = scene.isScene;
    sceneSessionRef.current = session;
  }, [scene.isScene, session]);
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
  /** La borne d'une coupure (`NETWORK_OUTAGE_GIVE_UP_MS`), armée au premier signe, effacée au premier fragment. */
  const outageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * La position de l'élément juste avant le dernier détachement d'hls.js (`MEDIA_DETACHING`) : quand
   * hls.js récupère lui-même (1.7, `hlsRecovery.ts`), l'élément est déjà remis à zéro quand notre
   * écouteur d'erreur passe — c'est la seule trace de l'endroit où il en était (un saut compris).
   */
  const hlsDetachedAt = useRef<number | null>(null);
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
  /** La reprise que l'élément n'a pas encore prise — reposée sur le téléviseur s'il la manque. */
  const [castResume] = useState(() => new CastResume());
  const loadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Le lien lu chaque seconde pendant le chargement (hls.js seulement, §77) : l'indice « Connexion
   * lente… » et le verdict anticipé. Arrêté partout où le chien de garde l'est.
   */
  const linkWatch = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Le segment de la reprise, demandé avant de lancer hls.js (LECTEUR-2) : interrompu par une négociation
   * qui remplace celle-ci, par le chien de garde et au démontage — jamais une requête pour un flux mort.
   */
  const resumeKick = useRef<AbortController | null>(null);
  // Belt-and-braces for the native (non-hls.js) path: iOS's media daemon releases HLS sessions
  // asynchronously, so even with the reload-based track switch a fresh load can race the old
  // session's teardown and get refused (SRC_NOT_SUPPORTED). One automatic, delayed re-attempt
  // absorbs that race invisibly; only a second consecutive failure surfaces the error UI.
  // Reset on every successful load ('loadeddata'), NOT at the top of startPlayback — the retry
  // itself goes through startPlayback, which would otherwise clear its own budget.
  const nativeErrorRetryCount = useRef(0);
  /**
   * Les codecs qu'une marche de l'échelle a dû exclure pour que cette ouverture se charge. Gardés le
   * temps de l'ouverture — un changement de piste ou l'épisode suivant ne rejoue pas l'échelle —, et
   * jamais au-delà : la prochaine séance repart de la marche 0 (DECISIONS §67).
   */
  const [carried] = useState(() => takeCarriedExclusions(itemId, fromReload));
  const learnedExclusions = useRef<string[]>(carried);
  const nativeErrorRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The opts of the most recent startPlayback call, so an automatic retry replays the SAME
  // request (audio track included) — state like currentAudioId would be stale inside the
  // error listener's closure.
  const lastPlaybackOpts = useRef<StartOpts | undefined>(undefined);
  // La séance Jellyfin a été close par la fin de l'épisode, lecteur resté ouvert (voir l'effet
  // `ended`) : le prochain `play` doit la rouvrir. Une ref et non une variable de l'effet : celui-ci
  // se réinstalle quand le lecteur passe en mini-lecteur ou revient en plein écran, et l'état remis
  // à faux laissait un second visionnage, relancé après ce passage, sans aucun rapport à Jellyfin
  // (audit du 29/09/2026). Remise à faux seulement là où une séance s'ouvre vraiment : à la relance,
  // ou par `startPlayback`, dont la négociation en ouvre une neuve (autre épisode, autre piste).
  const endStoppedRef = useRef(false);
  // Un élément <video> neuf (par la `key` plus bas) à chaque négociation qui, sur WebKit, trouve
  // une source déjà posée (`startPlayback`) : Réessayer, marches de l'échelle du son, marche H.264,
  // relance de diffusion, bascule allégée. Né le 14/08 pour le changement de piste (ebc2d2d, retiré,
  // puis remis pour être retesté isolément) — mais le changement de piste sur WebKit recharge la page
  // depuis le même jour (`changeAudio`, dont le commentaire dit que l'échec est identique avec un
  // élément neuf). Pour les autres relances, on ne sait pas s'il aide. Il n'est pas neutre pour
  // autant : les effets qui écoutent l'élément se réinstallent sur lui, `PlayerControls` est clé
  // dessus, `useServerDualSubtitles` le lit. Ne pas le retirer sans essai sur iPhone.
  const [videoKey, setVideoKey] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(true);
  // L'ouverture de la lecture couvre-t-elle encore l'écran (`ServerPlayerIntro`) ? La roue et le fil
  // des commandes se taisent dessous — même règle que chez le natif (DECISIONS.md §60).
  const [introCovering, setIntroCovering] = useState(false);
  // True only while hls.js is mid-retry after a fatal network/media error — distinct from
  // `loading` (the initial "fetching a fresh manifest" spinner) and from `error` (retries
  // exhausted, playback truly stopped). Drives the small non-blocking "Reconnexion..." banner.
  const [reconnecting, setReconnecting] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  // Non-interactive — a measured signal, not a settings toggle (not an invented "latency" a
  // browser can't actually observe for HLS segments): how often playback has stalled to rebuffer
  // in the last minute. The decoder's dropped-frame rate used to count too, and named the network
  // for what the device could not decode (LECTEUR-8, 15/10/2026). Reset per session in
  // startPlayback.
  const [badConnection, setBadConnection] = useState(false);
  const rebufferTimestamps = useRef<number[]>([]);
  const hasPlayedOnce = useRef(false);
  // A deliberate seek always fires 'waiting' too (the video briefly reloads at the new
  // position) — reported live as a false-positive trigger during normal scrubbing, nothing to
  // do with connection quality. 'waiting' within this long after a 'seeking' event is ignored.
  const lastSeekAt = useRef(0);
  // Estimated actual network throughput (hls.js's own adaptive-bitrate estimate) — distinct
  // from playbackInfo.video.bitRate/audio.bitRate, which are the STATIC target bitrate Jellyfin
  // encoded/is streaming at. Only meaningful on the hls.js path (Transcode/DirectStream on
  // Chrome/Firefox); native Safari HLS has no equivalent and this just stays null there.
  const [networkBitrate, setNetworkBitrate] = useState<number | null>(null);
  /**
   * Le lien mesuré (§77) : le compteur des requêtes d'hls.js de la négociation en cours, le débit du
   * flux négocié, et la lecture figée au moment d'un échec par connexion trop lente. Le panneau
   * technique les montre ; le bilan `stop` en porte le verdict.
   */
  const linkMeterRef = useRef<LinkMeter | null>(null);
  /** Les étapes du démarrage de la négociation en cours (§77) — pour la ligne `stop`. */
  const startupRef = useRef<ServerStartup | null>(null);
  const streamNeedRef = useRef<number | null>(null);
  const [linkFailure, setLinkFailure] = useState<LinkReading | null>(null);
  const [linkLive, setLinkLive] = useState<LinkReading | null>(null);
  /**
   * Ce que l'ouverture dit du lien pendant le chargement (§78, hls.js seulement, `openingAdvice`) :
   * l'indice « Connexion lente… », et la mesure qui l'a décidé.
   */
  const [linkSignal, setLinkSignal] = useState<LinkSignal>(NO_LINK_SIGNAL);
  /**
   * Le fil de ce que la lenteur a fait paraître et fait faire (§78), porté par les lignes `start`,
   * `error` et `stop` — un par séance (l'épisode suivant en ouvre un autre).
   */
  const slowLogRef = useRef(new SlowLog());
  /** Les saccades en pleine lecture (§78) — une par séance. */
  const stutterRef = useRef(new StutterWatch());
  /** La bascule en pleine lecture — posée par un effet plus bas, appelée par les écouteurs de l'élément. */
  const offerStutterRef = useRef<() => void>(() => {});
  /** Le début de la mesure du chargement, et le chien de garde à réarmer au retour du premier plan (§78). */
  const measureStartRef = useRef(0);
  const watchdogFireRef = useRef<(() => void) | null>(null);
  /** Un saut sans image depuis 10 s, traité comme une ouverture (§78). */
  const [seekSignal, setSeekSignal] = useState<SeekSignal | null>(null);
  /** Le palier de version allégée de la négociation en cours (§78), pour le panneau et le bilan. */
  const [lighterStep, setLighterStep] = useState<LighterStep | null>(null);
  /** Le même, lu par le bilan (`reportStop`) : seule une séance réellement allégée est retenue. */
  const negotiatedStepRef = useRef<LighterStep | null>(null);
  /**
   * D'où vient la version allégée en cours (§78), pour le panneau d'infos techniques : une bascule —
   * relais du lecteur natif, renégociation d'ici, ou emportée par un rechargement — et sa position ;
   * ou la règle des deux minutes. Le ref suit l'état pour `reloadCarryNow`, aux dépendances figées.
   */
  const [lighterOrigin, setLighterOrigin] = useState<LighterOrigin | null>(() => {
    const handover = takeoverFor(takeover, session);
    if (handover?.lighter) return { kind: "switch", at: handover.resumeAt };
    const carried = session.reloadCarry?.lighter;
    if (carried) return carried.real ? { kind: "switch", at: carried.at ?? null } : { kind: "inherited" };
    return null;
  });
  const lighterOriginRef = useRef(lighterOrigin);
  const noteLighterOrigin = useCallback((origin: LighterOrigin | null) => {
    lighterOriginRef.current = origin;
    setLighterOrigin(origin);
  }, []);
  /** La cause du relais, emportée par un rechargement de page (`reloadCarry.reason`) comme le palier. */
  const fallbackReasonRef = useRef(fallbackReason);
  useEffect(() => {
    fallbackReasonRef.current = fallbackReason;
  }, [fallbackReason]);
  /**
   * Ce que le flux transcodé est réellement (panneau, section « Diffusé ») : codecs et plage annoncés
   * par la liste maître — hls.js les lit, Safari HLS natif par la route —, et la taille que le
   * navigateur décode, suivie sur `resize`. Rien d'inventé : inconnu, `null`.
   */
  const [servedCodecs, setServedCodecs] = useState<{ video: string | null; audio: string | null; range: string | null } | null>(null);
  const [decodedSize, setDecodedSize] = useState<{ width: number; height: number } | null>(null);
  /**
   * Vrai quand le palier en cours n'est qu'hérité (règle des deux minutes) et qu'aucune bascule n'a
   * eu lieu dans cette séance : elle ne réarme pas la mémoire. Sinon chaque séance héritée repoussait
   * les deux minutes, et un appareil restait au lecteur serveur tant qu'on relançait vite (12/10/2026).
   */
  const carriedOnlyRef = useRef(false);
  /**
   * Le palier choisi pour ce titre par une bascule — ici, ou au relais du lecteur natif (`lighter` du
   * relais) — et que chaque négociation de ce titre redemande (réessai, piste audio).
   */
  const switchStepRef = useRef<{ itemId: string; step: LighterStep } | null>(
    (() => {
      const step = takeoverFor(takeover, session)?.lighter;
      return step ? { itemId, step } : null;
    })()
  );
  /**
   * L'exécution des décisions (§78, `slowLinkRunner.ts`, commune aux deux lecteurs) : le préchauffage
   * tenu, et le saut qui attend son image. Ce qu'elle lit de ce lecteur lui est rattaché plus bas.
   */
  const [runner] = useState(() => new SlowLinkRunner());
  /** La décision en pleine lecture, rappelée quand un préchauffage de saccades est prêt. */
  const playbackDecisionRef = useRef<(triggered?: boolean, early?: boolean) => void>(() => {});
  /**
   * La bascule en cours : son instant (`Date.now()`), pour mesurer l'interruption jusqu'à la première
   * image du flux allégé — posé par une bascule d'ici ou par le relais du lecteur natif.
   */
  const switchedAtRef = useRef<number | null>(takeoverFor(takeover, session)?.switchedAt ?? session.reloadCarry?.switchedAt ?? null);
  const switchGapRef = useRef<number | null>(null);
  /**
   * Le rechargement direct (bascule natif → serveur sur WebKit, `serverReload.ts`) : l'instant de sa
   * décision, et l'interruption jusqu'à la première image — `reloadGapMs` au bilan.
   */
  const reloadDecidedAtRef = useRef<number | null>(session.reloadCarry?.direct?.decidedAt ?? null);
  const reloadGapRef = useRef<number | null>(null);
  /** Le palier emporté par le rechargement (`reloadCarry.lighter`) : vient-il d'une vraie bascule ? */
  const reloadLighterRef = useRef(session.reloadCarry?.lighter);
  /**
   * Safari a refusé de reprendre seul après le rechargement d'une bascule allégée (pas de geste du
   * spectateur dans la page neuve) : le message reste, avec ce qu'il faut faire, jusqu'à la lecture.
   * Disparu au bout de 5 s, il laissait une image figée sans explication à qui avait posé son
   * téléphone pendant le chargement (12/10/2026).
   */
  const [awaitingTap, setAwaitingTap] = useState(false);
  /** « Passage en vidéo allégée en raison d'une connexion lente. » — bref, en bas à gauche. */
  const [switchNotice, setSwitchNotice] = useState(
    () =>
      (takeoverFor(takeover, session)?.lighter !== undefined && takeoverFor(takeover, session)?.switchedAt !== undefined) ||
      (session.reloadCarry?.direct !== undefined && session.reloadCarry.lighter !== undefined && session.reloadCarry.switchedAt !== undefined)
  );
  /**
   * Pendant une lecture allégée, la capacité du lien comparée au besoin du fichier d'origine (§78) :
   * rétablie, la mémoire des deux minutes s'efface. Le besoin d'origine vient de la négociation.
   */
  const recoveryRef = useRef(new LinkRecovery());
  const classicNeedRef = useRef<number | null>(null);
  const lighterClearedRef = useRef(false);
  /**
   * Ce qu'un rechargement de page emporte de la version allégée (`serverReload.ts`) : le palier
   * négocié, et s'il vient d'une vraie bascule — un palier seulement hérité, ou dont le lien s'est
   * rétabli (`lighterCleared`), ne réarmera pas la mémoire des deux minutes de l'autre côté.
   */
  const reloadCarryNow = useCallback(() => {
    const origin = lighterOriginRef.current;
    const at = origin?.kind === "switch" ? origin.at : null;
    return {
      ...(negotiatedStepRef.current
        ? { lighter: reloadLighterOf(negotiatedStepRef.current, !carriedOnlyRef.current && !lighterClearedRef.current, at) }
        : {}),
      // La cause du relais survit à un rechargement de plus (piste audio, échelle) : le panneau la garde.
      ...(fallbackReasonRef.current ? { reason: fallbackReasonRef.current } : {}),
      // Une scène reste une scène dans la page rechargée, avec ce qu'elle a déjà joué (§91).
      ...(sceneCarryOf(sceneSessionRef.current) ? { scene: sceneCarryOf(sceneSessionRef.current) } : {}),
    };
  }, []);
  /** La version allégée est-elle permise à ce compte (réponse de la négociation, §78) ? */
  const [lighterAllowed, setLighterAllowed] = useState(true);
  /** Le réglage « Qualité » (§78) : en « Originale », jamais de bascule ; ni pour le banc d'essai. */
  const quality = usePlaybackQuality();
  const autoLighterRef = useRef(false);
  useEffect(() => {
    autoLighterRef.current = quality === "auto" && lighterAllowed && !bench;
  }, [quality, lighterAllowed, bench]);
  /** Ce flux passe-t-il par hls.js — le seul qui mesure (§78) ? Safari et la lecture directe : non. */
  const [hlsJs, setHlsJs] = useState(false);
  /** Une coupure en cours — hls.js réessaie, ou le navigateur est hors ligne : jamais une lenteur (§78). */
  const unstableRef = useRef(false);
  /**
   * Les commandes : leur hauteur — les messages brefs se posent au-dessus. Suivie seulement pendant
   * qu'un de ces messages est affiché : chaque apparition des commandes re-rendait sinon tout le
   * lecteur pour rien.
   */
  const [chromeEdges, setChromeEdges] = useState<ChromeEdges | null>(null);
  /**
   * Le palier hérité de la règle des deux minutes (`session.lighter`, §78), lu par `startPlayback` —
   * dont les dépendances sont figées. Tenu à jour avant l'effet qui négocie (déclaré plus bas).
   */
  const sessionLighterRef = useRef(session.lighter);
  /** Le sous-titre du relais allégé, à rallumer une fois (`takeSubtitleCarry`). */
  const subtitleCarryRef = useRef<number | null>(
    (() => {
      const handover = takeoverFor(takeover, session);
      if (handover?.lighter && typeof handover.subtitleStreamIndex === "number") return handover.subtitleStreamIndex;
      // Le même relais, emporté par un rechargement direct.
      const carried = session.reloadCarry?.subtitleStreamIndex;
      return typeof carried === "number" ? carried : null;
    })()
  );
  const takeSubtitleCarry = useCallback(() => {
    const value = subtitleCarryRef.current;
    subtitleCarryRef.current = null;
    return value;
  }, []);
  useEffect(() => {
    sessionLighterRef.current = session.lighter;
    reloadLighterRef.current = session.reloadCarry?.lighter;
  }, [session]);
  /** Une génération de sous-titres était en cours au passage en allégée : dit brièvement (§78). */
  const [subtitleGenNotice, setSubtitleGenNotice] = useState(() => takeoverFor(takeover, session)?.subtitleGenerating === true);
  // True once loading/reconnecting has been ongoing for >3s — drives the "still loading, don't
  // close the player" reassurance line for heavy flows (a 4K track switch can legitimately take
  // 15-20s across the grace delay, codec ladder and reload escalation).
  const [loadingLong, setLoadingLong] = useState(false);
  const [closing, setClosing] = useState(false);
  const [playSession, setPlaySession] = useState<{
    itemId: string;
    playSessionId: string;
    mediaSourceId: string;
    /** Repris d'un préchauffage (§78) : la séance s'annonce elle-même à Jellyfin. */
    announce?: boolean;
  } | null>(null);

  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [currentAudioId, setCurrentAudioId] = useState<number | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<Track[]>([]);
  const [currentSubtitleId, setCurrentSubtitleId] = useState<number | null>(null);
  // The server's own name for the item — the only one that knows an episode is an episode. What
  // the caller passed stands until it arrives, so the title never blinks in empty.
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  /** Jellyfin's stream index → the track's language, from the last negotiation. */
  const audioLanguagesRef = useRef<Map<number, string | null>>(new Map());
  const title = serverTitle ?? openedAs;
  // Ce que chaque ligne du journal de ce lecteur porte — voir `serverPlayerLog`. Tenu dans une
  // référence : `startPlayback` a des dépendances volontairement figées, et y lire `title` ou
  // `castSession` directement nommerait l'épisode d'avant.
  // Une séance par titre ouvert : l'épisode suivant en commence une autre. Un relais du lecteur
  // natif poursuit la sienne — une séance, et non deux dont une à zéro seconde (24/09/2026).
  const [firstSession] = useState(() => continuesSession ?? newPlayerSessionId());
  const logSession = useRef({ itemId, id: firstSession });
  const agent = typeof navigator === "undefined" ? undefined : navigator.userAgent;
  /**
   * Quelque chose diffuse-t-il vraiment ?
   *
   * Tenu par l'écouteur de route plus bas et par lui seul. Deux endroits qui observeraient le même état
   * finiraient par ne plus être d'accord, et celui-ci décide d'un mot que le spectateur lit.
   */
  const [castActive, setCastActive] = useState(false);
  const castActiveRef = useRef(false);
  /** La croix a été pressée : la fin de diffusion qu'elle provoque n'est pas un retour au téléphone. */
  const closingRef = useRef(false);
  // Déclaré avant le contexte du journal, qui le lit.
  const logContext = useRef<ServerPlayerContext>({ itemId, title, cast: castSession, bench: session.bench, scene: scene.logFields, session: firstSession, agent });
  /**
   * Le décompte de la séance pour son bilan (`stop`) — le même que celui du lecteur natif
   * (`SessionTally`) : attentes d'au moins 250 ms, sauts et leur attente, pistes, arrière-plan. Plus
   * les relances par motif et les changements de sous-titres. Une séance par titre : l'épisode
   * suivant repart de zéro (voir l'effet du contexte du journal, juste en dessous).
   */
  const tallyRef = useRef(new SessionTally());
  const restartsRef = useRef<Partial<Record<ServerStartWhy, number>>>({});
  const subtitleSwitchesRef = useRef(0);
  /** Une image a joué dans cette séance — sinon le bilan dit combien de temps on a attendu. */
  const sessionPlayedRef = useRef(false);
  /**
   * Le saut de reprise que pose la négociation elle-même (`video.currentTime = resumeAt` à
   * `loadeddata`), consommé par le `seeking` qu'il provoque : ce n'est pas un geste du spectateur.
   * Sur hls.js, une renégociation en plein film (piste en place, « Réessayer », marche de l'échelle,
   * bascule allégée) garde l'effet du décompte et son `playedOnce` : ce saut-là était compté au bilan
   * (`seeks: 1` sans geste) et armait `runner.seekStarted()` (§78) — audit du 22/10/2026. Sur WebKit
   * l'élément est remonté à chaque négociation et le décompte repart de zéro : rien n'y change.
   */
  const resumeSeekPendingRef = useRef(false);
  const [mountedAt] = useState(() => Date.now());
  const sessionStartedAtRef = useRef(mountedAt);
  /**
   * La séance s'est terminée autrement que par un `stop` d'ici : la main rendue au lecteur natif à
   * la fin d'une diffusion (sa ligne `fallback` le dit). Ni bilan perdu gardé, ni `stop` au démontage.
   */
  const handedOverRef = useRef(false);
  useEffect(() => {
    if (logSession.current.itemId !== itemId) {
      logSession.current = { itemId, id: newPlayerSessionId() };
      tallyRef.current = new SessionTally();
      restartsRef.current = {};
      subtitleSwitchesRef.current = 0;
      sessionPlayedRef.current = false;
      sessionStartedAtRef.current = Date.now();
      handedOverRef.current = false;
      slowLogRef.current = new SlowLog();
      stutterRef.current = new StutterWatch();
      recoveryRef.current = new LinkRecovery();
      lighterClearedRef.current = false;
    }
    // `cast` ne se lit plus « séance ouverte pour diffuser » seulement : une route établie depuis
    // les commandes de la vidéo compte aussi, pour les lignes qui suivent (arrêt compris).
    logContext.current = { itemId, title, cast: castSession || castActive, bench: session.bench, scene: scene.logFields, session: logSession.current.id, agent };
  }, [itemId, title, castSession, castActive, session.bench, agent, scene.logFields]);
  const [introSkip, setIntroSkip] = useState<{ start: number; end: number } | null>(null);
  const [recapSkip, setRecapSkip] = useState<{ start: number; end: number } | null>(null);
  const [creditsStart, setCreditsStart] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Le temps joué, porté par ses lignes `stop` et de fin de diffusion — voir `WatchedClock`.
  const [watched] = useState(() => new WatchedClock());
  useEffect(() => {
    if (!playing) return;
    watched.run(Date.now());
    return () => watched.halt(Date.now());
  }, [playing, watched]);
  // Tant que ça joue, l'écran reste allumé — voir useWakeLock pour ce que chaque chemin
  // obtient déjà tout seul et ce qu'il n'obtient pas.
  useWakeLock(playing);
  const [externalSubtitleTracks, setExternalSubtitleTracks] = useState<ExternalSubtitleTrack[]>([]);
  /**
   * « Deux sous-titres » (DECISIONS.md §87) : le second, et le principal tenu aussi en référence —
   * les deux gestes lisent l'autre au moment de l'appui, pas au rendu qui a créé le gestionnaire.
   */
  const [secondSubtitleId, setSecondSubtitleId] = useState<number | null>(null);
  const secondSubtitleRef = useRef<number | null>(null);
  const currentSubtitleRef = useRef<number | null>(null);
  const subtitleTrackIds = useMemo(() => externalSubtitleTracks.map((st) => st.index), [externalSubtitleTracks]);
  const subtitleStyle = useSyncExternalStore(subtitleStyleStore.subscribe, subtitleStyleStore.snapshot, subtitleStyleStore.serverSnapshot);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfoSummary | null>(null);
  /**
   * Le lecteur natif a passé la main parce que l'appareil ne sait pas lire ce fichier, et le serveur
   * le réencode : la première image demande une ou deux secondes de plus (13/10/2026 — un téléphone
   * Android devant un HEVC 4K 10 bits refermait le lecteur au bout de quatre secondes de roue muette).
   * Dit dès le début du chargement, pas après le délai de « toujours en cours ». Ni la version allégée
   * (elle a ses propres mots), ni une diffusion.
   */
  const compatPrep = loading && !!fallbackReason && !lighterStep && !castSession && playbackInfo?.playMethod === "Transcode";
  const [showPlaybackInfo, setShowPlaybackInfo] = useState(false);
  // Le lien en direct dans le panneau technique (§77), lu seulement quand il est ouvert.
  useEffect(() => {
    if (!showPlaybackInfo) return;
    const read = () => setLinkLive(readLink(linkMeterRef.current?.measure(), streamNeedRef.current));
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [showPlaybackInfo]);
  const playMethod = playbackInfo?.playMethod ?? "Transcode";

  const { stop: stopPlaybackNow, resume: resumePlaybackSession, savePaused, reportNow: reportPositionNow } = usePlaybackSession(
    useCallback(() => lastKnownTime.current, []),
    // Named as this app rather than as its engine: this player hands the file to Jellyfin, which
    // is what the server's own dashboard should show.
    // Rien pour un banc d'essai, comme le lecteur natif : il saute à la fin des films, et ses
    // battements puis son arrêt marquaient le film vu sur le compte qui le lançait (27/09/2026).
    // Le prix : sans arrêt, Jellyfin ne tue pas le transcodage sur-le-champ — il est censé le faire
    // de lui-même quand plus aucun segment n'est demandé (non mesuré ici). L'arrêter tout de suite
    // demanderait de passer par ses encodages actifs, sans écrire de position.
    //
    // Rien non plus pendant une scène (§91). Devenue lecture ordinaire, la séance s'annonce elle-même :
    // sa négociation, faite en scène, n'avait rien dit à Jellyfin (`scene` dans le corps, voir la route).
    playSession && !bench && !scene.active
      ? { ...playSession, playMethod, client: PLAYBACK_CLIENTS.stable, ...(session.scene ? { announce: true } : {}) }
      : null,
    useCallback(() => videoRef.current?.paused ?? false, [])
  );

  // Pas d'épisode suivant pendant une scène (§91) : on est venu voir une réplique.
  const nextEpisode = scene.active ? null : (session.getNextEpisode?.(itemId) ?? null);

  /**
   * La minuterie de veille, la même que celle du lecteur natif (`useSleepTimer`) : ses commandes
   * sont les mêmes, son décompte vit au-dessus des deux lecteurs, et un relais de l'un à l'autre le
   * garde. Quand elle arrête le film : la ligne `pause` et la position à Jellyfin tout de suite.
   */
  const onSlept = useCallback(
    (sleptMode: SleepMode) => {
      reportPlayback("pause", serverSleepFields(logContext.current, sleptMode, lastKnownTime.current));
      savePaused();
    },
    [savePaused]
  );
  const { holdAtEnd } = useSleepTimer(videoRef, onSlept);

  /**
   * La séance est déjà fermée — une seule fois, comme `lifecycle.claimStop` côté lecteur natif.
   *
   * Deux appuis pendant le fondu (Quitter sur l'écran d'erreur, puis la croix ; la croix, puis la
   * fin du fichier) écrivaient deux lignes `stop`, la seconde avec zéro seconde regardée — le
   * temps venait d'être pris par la première —, et lançaient deux relectures des vues (relevé le
   * 27/09/2026 en cartographiant le lecteur, docs/cycle-de-vie-lecteur.md). L'hôte natif tient la
   * même règle par `lifecycle.noteClosing()` / `isOver()` — DECISIONS.md « Une séance close ».
   */
  const closedRef = useRef(false);

  // L'erreur affichée, lue par le bilan sans le recréer à chaque rendu.
  const errorRef = useRef<string | null>(null);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  /**
   * Le bilan de la séance à cet instant — la ligne `stop`, et la copie gardée sur l'appareil au cas
   * où elle ne pourrait pas partir (`unsentStop`, `why: "lost"`). `consume` : le temps regardé est
   * pris (il ne comptera pas deux fois) ; la copie gardée le lit seulement.
   */
  const stopFields = useCallback(
    (why: ServerStopWhy, consume: boolean) => {
      const now = Date.now();
      const video = videoRef.current;
      // Le lien de la séance (§77), sous les mêmes noms que le bilan du lecteur natif (`diag.*`) —
      // rien quand hls.js n'a rien compté (Safari, lecture directe).
      const link = readLink(linkMeterRef.current?.measure(), streamNeedRef.current);
      const linkDiag =
        link.recvBps !== null
          ? {
              diag: {
                linkMbps: Math.round((link.recvBps / 1e6) * 10) / 10,
                ...(link.needBps !== null ? { needMbps: Math.round((link.needBps / 1e6) * 10) / 10 } : {}),
                linkVerdict: linkVerdictWord(link),
                linkS: Math.round((linkMeterRef.current?.measure().receivingMs ?? 0) / 100) / 10,
              },
            }
          : {};
      // La reprise (LECTEUR-2) : ce que l'image à la position demandée a coûté, sous `diag` avec le lien.
      const resumeDiag = startupRef.current?.resumeFields() ?? {};
      const diagFields = Object.keys(resumeDiag).length ? { diag: { ...("diag" in linkDiag ? linkDiag.diag : {}), ...resumeDiag } } : linkDiag;
      return { ...diagFields, ...(startupRef.current?.fields(true) ?? {}), ...serverStopFields(logContext.current, why, lastKnownTime.current, consume ? watched.take(now) : watched.seconds(now), {
        ...sleepTimerLogFields(sleepTimerStore.get()),
        duration: video?.duration,
        ended: video?.ended ?? false,
        tally: tallyRef.current.summary(now),
        subtitleSwitches: subtitleSwitchesRef.current,
        restarts: restartsRef.current,
        error: errorRef.current,
        ...(sessionPlayedRef.current ? {} : { gaveUpAfterMs: now - sessionStartedAtRef.current }),
      }),
      // Ce que la lenteur a fait paraître et les choix faits (§78), et la mémoire allégée effacée.
      ...slowLogRef.current.fields(),
      ...(switchGapRef.current !== null ? { switchGapMs: switchGapRef.current } : {}),
      ...(reloadGapRef.current !== null ? { reloadGapMs: reloadGapRef.current } : {}),
      ...(lighterClearedRef.current ? { lighterCleared: true } : {}) };
    },
    [watched]
  );
  /** La main est rendue au lecteur natif (fin de diffusion) : la copie gardée n'a plus lieu d'être. */
  const markHandedOver = useCallback(() => {
    handedOverRef.current = true;
    if (logContext.current.session) clearUnsentStop(logContext.current.session);
  }, []);
  /**
   * La séance du journal dont le bilan est déjà parti — un seul `stop` par séance.
   *
   * L'épisode suivant (`handleAdvance`) écrit `stop "next"` sans fermer le lecteur : il compte rester
   * monté pour l'enchaîner. Mais quand l'épisode suivant repart par l'aiguillage ordinaire (le natif
   * d'abord, pour un titre qu'il n'a pas encore passé au serveur), ce lecteur est démonté aussitôt,
   * et son démontage écrivait un second `stop "unmount"` à zéro seconde pour la même séance — celui
   * que la page Activité retient, le dernier (passe de nuit du 15/10/2026, LECTEUR-12). Une séance
   * par épisode : quand le lecteur enchaîne en place, l'épisode suivant ouvre une séance neuve
   * (`logSession`), et la garde se rouvre d'elle-même.
   */
  const stoppedSessionRef = useRef<string | null>(null);
  const stopAlreadySent = useCallback(() => {
    const id = logContext.current.session;
    return !!id && stoppedSessionRef.current === id;
  }, []);
  /** Envoie le bilan et efface sa copie gardée sur l'appareil — une seule fois par séance. */
  const reportStop = useCallback(
    (why: ServerStopWhy) => {
      if (stopAlreadySent()) return;
      stoppedSessionRef.current = logContext.current.session ?? null;
      // Une séance réellement allégée qui s'arrête est retenue deux minutes (§78) — sauf si le lien a
      // retrouvé de quoi porter la lecture classique pendant qu'elle jouait. Une séance ordinaire du
      // lecteur serveur ne retient rien.
      const step = negotiatedStepRef.current;
      if (step && !carriedOnlyRef.current && !lighterClearedRef.current && !logContext.current.bench) rememberLighter(step);
      reportPlayback("stop", stopFields(why, true));
      if (logContext.current.session) clearUnsentStop(logContext.current.session);
    },
    [stopFields, stopAlreadySent]
  );

  // Swaps to the next episode in place — reports the current one's final
  // position first, same as a manual close, but never triggers the
  // close/unmount fade since the player stays open for the new episode.
  const handleAdvance = useCallback(() => {
    // Rien à enchaîner sur une séance qu'on vient de fermer : le compte à rebours de l'épisode
    // suivant peut arriver à zéro pendant le fondu.
    if (!nextEpisode || closedRef.current) return;
    reportStop("next");
    stopPlaybackNow();
    playback.advance(nextEpisode);
  }, [nextEpisode, playback, stopPlaybackNow, reportStop]);

  // Un épisode choisi dans le menu « Épisodes » (19/10/2026) : le même passage que l'épisode suivant —
  // arrêt rapporté (`next`), lecture coupée, `advance` —, avec la position que la liste connaît de lui.
  const handlePlayEpisode = useCallback(
    (episode: { itemId: string; title: string; resumeAt: number }) => {
      if (closedRef.current || episode.itemId === itemId) return;
      reportStop("next");
      stopPlaybackNow();
      playback.advance(episode);
    },
    [itemId, playback, stopPlaybackNow, reportStop]
  );

  // Fades out instead of vanishing instantly — an abrupt unmount back to the
  // underlying page reads as a glitch, especially mid-transcode. Reports the
  // stop position right now (not whenever React gets around to unmounting)
  // so Jellyfin's resume point reflects the exact moment the user closed,
  // not wherever currentTime drifts to during the fade delay.
  const CLOSE_MS = 200;
  const handleClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    reportStop("close");
    const reported = stopPlaybackNow();
    /**
     * En diffusion, fermer le lecteur arrête aussi le téléviseur.
     *
     * Retirer l'élément de la page ne coupe pas une session AirPlay : le téléviseur continuait de
     * jouer sans nous, et la reprise suivante partait de l'instant de la croix, pas de celui où la
     * télé s'était arrêtée — vingt secondes d'écart le 26/09/2026, les segments demandés par
     * l'Apple TV après la fermeture en témoignent. Arrêté ici, la position rapportée juste
     * au-dessus reste la bonne.
     */
    const video = videoRef.current;
    if (video && castActiveRef.current) {
      closingRef.current = true;
      try {
        releaseHlsElement(video);
      } catch {
        // Déjà démonté : il n'y a plus rien à arrêter.
      }
    }
    setClosing(true);
    // Cette lecture-ci seulement : voir `close(openId)`.
    const openId = session.openId;
    setTimeout(() => playback.close(openId), CLOSE_MS);
    // La fiche et la rangée « Reprendre » décrivent ce film : elles sont fausses dès l'instant
    // où on le quitte, et rien ne les relisait. Volontairement hors du chemin de la fermeture —
    // l'écran doit partir tout de suite, la relecture peut attendre son tour.
    // Une scène (§91) n'a rien changé de ce qu'elles montrent.
    if (!isSceneRef.current()) void refreshAfterPlayback(reported, itemId);
  }, [playback, stopPlaybackNow, itemId, session.openId, reportStop]);
  // Retour ferme le lecteur comme sa croix (`playerHistory.ts`).
  usePlayerBackClose(handleClose);

  /**
   * Le bilan gardé sur l'appareil, réécrit tant que la séance vit — comme le lecteur natif.
   *
   * Toutes les 30 s, et à chaque passage en arrière-plan : le dernier instant où une page qu'iOS va
   * tuer peut encore écrire. Renvoyé au lancement suivant en `why: "lost"` (`flushOrphanStops`).
   * Jamais après l'arrêt, ni une fois la main rendue au lecteur natif. Rien pour un banc d'essai.
   * L'arrière-plan nourrit aussi le décompte (`backgrounds`, `backgroundMs`) : une attente en cours
   * au départ n'en est plus une, c'est l'absence.
   */
  useEffect(() => {
    const save = () => {
      const id = logContext.current.session;
      if (!id || bench || closedRef.current || handedOverRef.current || stopAlreadySent()) return;
      saveUnsentStop(id, stopFields("lost", false), Date.now(), { livesHere: true });
    };
    save();
    const timer = setInterval(save, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        tallyRef.current.hidden(Date.now());
        save();
      } else {
        tallyRef.current.shown(Date.now());
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [bench, stopFields, stopAlreadySent]);

  /**
   * La page qui se ferme, et le lecteur qui disparaît sans avoir été fermé : un bilan quand même.
   *
   * Sans eux, la séance finissait sur son dernier `start` — « commencée, jamais finie » — dès que la
   * page partait (onglet fermé, rechargement) ou qu'un autre écran remplaçait ce lecteur. `pagehide`
   * part avec `keepalive` (`reportPlayback`) ; le démontage seulement s'il n'y a pas eu de fermeture,
   * ni de main rendue au lecteur natif (sa ligne `fallback` raconte déjà la fin).
   */
  const reportStopRef = useRef(reportStop);
  useEffect(() => {
    reportStopRef.current = reportStop;
  }, [reportStop]);
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      // Mise en cache (bfcache) : la page peut revenir, la séance avec. Le bilan gardé suffit.
      if (e.persisted || closedRef.current || handedOverRef.current) return;
      closedRef.current = true;
      reportStopRef.current("page");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (closedRef.current || handedOverRef.current) return;
      closedRef.current = true;
      reportStopRef.current("unmount");
    };
  }, []);
  /**
   * La chronologie des deux dernières minutes (§77) : un échantillon toutes les 5 s, en mémoire —
   * débit d'après ce que hls.js reçoit (rien en HLS natif), tampon devant d'après `buffered`. Jointe
   * par `reportPlayback` aux lignes de panne et au bilan. Une par séance : l'épisode suivant en
   * ouvre une autre. Déclarée après l'arrêt au démontage, qui part donc encore avec elle.
   */
  useEffect(() => {
    const timeline = new PlaybackTimeline(() => {
      const video = videoRef.current;
      return {
        pos: video && Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : lastKnownTime.current,
        recvMbps: linkMeterRef.current?.recentMbps(TIMELINE_EVERY_MS) ?? null,
        aheadS: bufferedAhead(video),
        reserveMB: null,
        state: elementState(video),
      };
    }).start();
    const unregister = registerTimeline(logSession.current.id, timeline);
    return () => {
      timeline.stop();
      unregister();
    };
  }, [itemId]);

  // (Re)starts playback, optionally at a specific audio track / resume point.
  // Jellyfin only ever transcodes ONE audio stream into the HLS output (unlike
  // subtitles, which it exposes as switchable renditions), so changing audio
  // means asking for a brand new transcode. Jellyfin's HLS output here is a
  // full VOD playlist covering the whole runtime regardless of StartTimeTicks
  // (seeking already works by jumping within it) — so instead of trusting
  // Jellyfin to start the new stream at the right offset, we seek the video
  // to resumeAt ourselves once the new manifest's metadata is ready.
  const startPlayback = useCallback(
    async (opts?: StartOpts) => {
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

      // Ce qu'une marche a appris pendant cette ouverture (voir AUDIO_FALLBACK_RUNGS), joint aux
      // exclusions de l'appel — un changement de piste ne redécouvre pas le même échec.
      purgeLegacyAudioBlocklist();
      const disableAudioCodecs = [...new Set([...learnedExclusions.current, ...(opts?.disableAudioCodecs ?? [])])];
      lastPlaybackOpts.current = opts;
      // Une négociation ouvre sa propre séance : la fin de la précédente n'a plus rien à rouvrir.
      endStoppedRef.current = false;

      // WebKit only — hls.js (Firefox, Chrome/Edge desktop & Android) already handles reusing
      // the element correctly via its own MediaSource and was never affected by this.
      if (video.src && playsHlsNatively(video)) {
        flushSync(() => setVideoKey((k) => k + 1));
        video = videoRef.current;
        if (!video) return;
      }

      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
      networkRetryTimer.current = null;
      if (outageTimer.current) clearTimeout(outageTimer.current);
      outageTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
      if (linkWatch.current) clearInterval(linkWatch.current);
      linkWatch.current = null;
      resumeKick.current?.abort();
      resumeKick.current = null;
      setLinkSignal(NO_LINK_SIGNAL);
      networkRetryCount.current = 0;
      mediaRetryCount.current = 0;
      hlsDetachedAt.current = null;
      setError(null);
      setReconnecting(false);
      setLoading(true);
      rebufferTimestamps.current = [];
      hasPlayedOnce.current = false;
      resumeSeekPendingRef.current = false;
      lastSeekAt.current = 0;
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
      /** La séance qu'une négociation remplacée a fait ouvrir chez Jellyfin — voir plus bas. */
      const closeOrphan = (data: { playSessionId?: string; mediaSourceId?: string } | null) => {
        // Un banc n'annonce rien : il n'y a rien à refermer.
        // Une scène (§91) non plus : cet arrêt écrirait sa position comme reprise.
        if (bench || isSceneRef.current() || !data?.playSessionId || !data?.mediaSourceId) return;
        void stopOrphanSession(
          { itemId, playSessionId: data.playSessionId, mediaSourceId: data.mediaSourceId },
          opts?.resumeAt ?? lastKnownTime.current
        );
      };
      const nativeHls = playsHlsNatively(video);
      const hlsModule = nativeHls ? null : import("hls.js");
      hlsModule?.catch(() => {});

      // La version allégée (§78) : le palier choisi pour ce titre par une bascule, ou celui qu'hérite une
      // lecture lancée moins de deux minutes après une séance allégée (`session.lighter`) — retenu pour
      // ce titre, la mesure continue et le palier suivant en part. Jamais en « Originale », jamais pour
      // une diffusion (le téléviseur a son propre lien), jamais pour le banc d'essai.
      const allowed = !castSession && !bench && readPlaybackQuality() === "auto";
      let lighterCarried = false;
      let lighterReloaded = false;
      if (allowed && switchStepRef.current?.itemId !== itemId && sessionLighterRef.current) {
        switchStepRef.current = { itemId, step: sessionLighterRef.current };
        // Emporté par un rechargement de page (`reloadCarry.lighter`) : la séance d'avant le rechargement
        // continue — une vraie bascule reste une vraie bascule (son arrêt retiendra le palier), un palier
        // hérité reste hérité (il ne réarme pas la mémoire des deux minutes).
        const reloaded = reloadLighterRef.current;
        lighterReloaded = reloaded !== undefined;
        lighterCarried = !reloaded?.real;
        carriedOnlyRef.current = !reloaded?.real;
        // Seulement hérité (règle des deux minutes), sans rechargement qui en dirait l'origine : dit tel quel.
        if (!reloaded) noteLighterOrigin({ kind: "inherited" });
        const mbpsText = (sessionLighterRef.current.targetBps / 1e6).toFixed(1);
        slowLogRef.current.note(
          reloaded
            ? `allégée ${mbpsText} Mb/s palier ${sessionLighterRef.current.tier} (repris au rechargement, ${reloaded.real ? "bascule" : "hérité"})`
            : `allégée ${mbpsText} Mb/s palier ${sessionLighterRef.current.tier} (moins de 2 min après une séance allégée)`
        );
      }
      const step = allowed && switchStepRef.current?.itemId === itemId ? switchStepRef.current.step : null;
      const maxBitrate = step ? Math.min(pickMaxBitrate(), step.targetBps) : pickMaxBitrate();
      const cap = { maxBitrate, step };
      negotiatedStepRef.current = step;
      setLighterStep(step);
      if (!step) noteLighterOrigin(null);
      // L'instant de la demande : la décision de l'ouverture et le résultat d'une version allégée en partent.
      const startedAt = performance.now();
      const startedAtWall = Date.now();

      // Les étapes du démarrage, comptées depuis cette demande (§77) — voir `ServerStartup`.
      const startup = new ServerStartup(performance.now());
      if (opts?.resumeAt) startup.resumeAsked(opts.resumeAt);
      // Le préchauffage de ce palier (§78), s'il y en a un : sa négociation est reprise TELLE QUELLE —
      // même PlaySessionId, mêmes adresses —, et hls.js part à sa position (`startPosition`) : Jellyfin
      // sert le segment déjà produit et poursuit le même ffmpeg (vérifié sur la prod le 12/10/2026 : un
      // seul ffmpeg, segments en moins de 10 ms). Un préchauffage d'un autre palier est arrêté.
      // Pris, il n'appartient plus qu'à cette négociation : écarté (autre palier, autre piste audio —
      // `prewarmFits` —, échec, négociation remplacée), il est refermé par `discardTakenPrewarm`.
      // `cancelPrewarm` ne touche pas un préchauffage pris : la séance restait ouverte chez Jellyfin.
      //
      // Sans palier, le relais préparé avant une zone illisible (§93) : la négociation ordinaire que
      // le lecteur natif a faite pour la position du relais, reprise de même — si elle convient (même
      // position, même piste : `takeOrdinaryPrewarm`), et seulement pour la négociation qu'elle
      // remplace : hls.js, sans exclusion de son ni diffusion. Sinon elle est arrêtée chez Jellyfin.
      const ordinaryUsable = !castSession && !bench && !nativeHls && disableAudioCodecs.length === 0 && !opts?.forceAudioTranscode && !opts?.videoH264Only;
      const warmedCandidate = cap.step
        ? takePrewarm(itemId)
        : takeOrdinaryPrewarm(itemId, ordinaryUsable ? opts?.resumeAt : undefined, opts?.audioStreamIndex);
      let warmed: Prewarm | null = null;
      if (warmedCandidate) {
        if ((cap.step ? prewarmFits(warmedCandidate, cap.step, opts?.audioStreamIndex) : true) && (await warmedCandidate.ready) && warmedCandidate.data) warmed = warmedCandidate;
        else discardTakenPrewarm(warmedCandidate);
        if (generation !== playbackGeneration.current) {
          if (warmed) discardTakenPrewarm(warmed);
          return;
        }
      }
      const res = warmed
        ? new Response(JSON.stringify(warmed.data), { status: 200, headers: { "Content-Type": "application/json" } })
        : await fetch("/api/jellyfin/playback/start", {
        method: "POST",
        // L'indice tactile : cette négociation annonce la séance à Jellyfin, sous le nom de
        // l'appareil — un iPad s'y nommerait « Mac » sans lui (`deviceLabel.ts`).
        headers: { "Content-Type": "application/json", ...touchHintHeaders() },
        body: JSON.stringify({
          itemId,
          // Abaissé seulement en version allégée (§78) : le palier de ce titre, demandé par le
          // spectateur ou hérité d'une séance allégée de moins de deux minutes — le serveur en tire
          // le codec (HEVC ou H.264), le SDR et la largeur maximale. Sans palier, la demande d'avant.
          maxBitrate: cap.maxBitrate,
          ...(cap.step ? { lighter: true } : {}),
          audioStreamIndex: opts?.audioStreamIndex,
          startTicks: opts?.resumeAt ? Math.floor(opts.resumeAt * 10_000_000) : undefined,
          codecSupport,
          disableAudioCodecs,
          // Le dernier échelon de l'échelle : le son ré-encodé quoi qu'il soit — voir la route.
          ...(opts?.forceAudioTranscode ? { forceAudioTranscode: true } : {}),
          // Le recours de l'image : H.264 seul — voir `H264_RUNG`.
          ...(opts?.videoH264Only ? { videoH264Only: true } : {}),
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
          // Rien d'annoncé à Jellyfin pour un banc d'essai — voir la route.
          ...(bench ? { bench: true } : {}),
          // Ni annonce pour une scène (§91) : la séance s'annoncera si elle devient une lecture.
          ...(isSceneRef.current() ? { scene: true } : {}),
        }),
      });
      // Avant la lecture du corps, donc avant setNeedsReauth / setError : l'échec d'une
      // négociation déjà remplacée n'a rien à afficher, c'est la nouvelle qui décide. Sa réussite
      // non plus — mais Jellyfin a ouvert une séance pour elle, qu'il faut lui refermer.
      if (generation !== playbackGeneration.current) {
        if (res.ok) void res.json().then(closeOrphan, () => {});
        return;
      }
      if (res.status === 401) {
        const body = await res.json().catch(() => null);
        // Revérifiée après chaque lecture de corps, et non seulement avant : la réponse d'une
        // négociation remplacée pendant qu'on la lisait n'a rien à afficher non plus.
        if (generation !== playbackGeneration.current) return;
        if (body?.code === "jellyfin_reauth_required") {
          reportPlayback("error", serverFailureFields(logContext.current, "reconnexion à Jellyfin demandée", { status: 401 }));
          setNeedsReauth(true);
          setLoading(false);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (generation !== playbackGeneration.current) return;
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
            // Le texte de la route, traduit par son code — jamais du français à un compte qui ne
            // le lit pas (`apiErrorText`, 13/10/2026).
            : apiErrorText(withCode(new Error(body?.error ?? ""), body?.code), t, locale, t("errors.playbackUnavailable"))
        );
        setLoading(false);
        return;
      }
      const data = await res.json();
      /**
       * Remplacée — ou le lecteur fermé — pendant qu'on lisait la réponse.
       *
       * La génération n'était vérifiée qu'avant cette lecture. Une réponse lue après coup écrivait
       * encore la ligne `start`, posait la séance et lançait la lecture sur un élément que plus
       * personne ne regarde ; et une séance fermée pendant la négociation laissait chez Jellyfin un
       * transcodage que rien ne refermait : son identifiant n'était jamais gardé, donc jamais
       * arrêté (relevé le 27/09/2026, docs/cycle-de-vie-lecteur.md). Jellyfin l'a ouverte : on la
       * lui referme, à la position qu'elle devait prendre.
       */
      if (generation !== playbackGeneration.current) {
        closeOrphan(data);
        return;
      }
      // Pourquoi cette négociation : chaque appelant le dit (`StartOpts.cause`). Une relance — tout
      // ce qui n'ouvre pas la séance — compte au bilan, par motif.
      const cause = opts?.cause;
      if (cause && isServerRestart(cause.why)) restartsRef.current[cause.why] = (restartsRef.current[cause.why] ?? 0) + 1;
      startup.negotiated();
      startupRef.current = startup;
      reportPlayback("start", {
        ...serverStartFields(
          logContext.current,
          {
            directPlay: !!data.isDirectPlay,
            nativeHls,
            resumeAt: opts?.resumeAt,
            audioStreamIndex: opts?.audioStreamIndex,
          },
          cause
        ),
        // Une reprise de l'échelle audio rejoue la négociation : la ligne dit laquelle.
        ...(nativeErrorRetryCount.current > 0 ? { retry: nativeErrorRetryCount.current } : {}),
        // La version allégée (§78) : débit demandé, palier, s'il vient de la règle des deux minutes, et le
        // préchauffage repris (son délai, son codec, sa résolution).
        ...(cap.step
          ? {
              lighterMbps: Math.round(cap.step.targetBps / 1e5) / 10,
              lighterTier: cap.step.tier,
              ...(lighterCarried ? { lighterCarried: true } : {}),
              ...(lighterReloaded ? { lighterReloaded: true } : {}),
            }
          : {}),
        ...(warmed ? { prewarm: { ...prewarmFields(warmed), used: true } } : {}),
        ...startup.fields(),
        ...slowLogRef.current.fields(),
      });
      // Le besoin du fichier d'origine en pleine qualité : ce que le lien doit retrouver pour que la
      // lecture suivante revienne au lecteur natif (`LinkRecovery`, §78).
      setLighterAllowed(data.lighterAllowed !== false);
      classicNeedRef.current = typeof data.sourceBitrateBps === "number" && data.sourceBitrateBps > 0 ? data.sourceBitrateBps : null;

      // Un préchauffage n'a rien annoncé à Jellyfin (`prewarm: true`) : la séance l'annonce elle-même.
      setPlaySession({ itemId, playSessionId: data.playSessionId, mediaSourceId: data.mediaSourceId, ...(warmed ? { announce: true } : {}) });
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
      // La langue de chaque piste, pour dire au serveur celle choisie à la main (`changeAudio`).
      audioLanguagesRef.current = new Map(faitsAudio.map((t) => [t.index, t.language]));
      setCurrentAudioId(opts?.audioStreamIndex ?? data.audioTracks?.find((t: { isDefault: boolean }) => t.isDefault)?.index ?? null);
      setServerTitle(data.title ?? null);
      setIntroSkip(data.introSkip ?? null);
      setRecapSkip(data.recapSkip ?? null);
      setCreditsStart(data.creditsStart ?? null);
      setPlaybackInfo(data.playbackInfo ?? null);
      // Ce que le maître annonce (HLS natif : lu par la route ; repris d'un préchauffage : son maître) —
      // hls.js le redira plus bas, d'après ses propres niveaux.
      const announced = (data.playbackInfo as PlaybackInfoSummary | undefined)?.served ?? (warmed?.variant ? { codecs: warmed.variant.codecs, videoRange: null } : null);
      setServedCodecs(announced ? { ...splitCodecs(announced.codecs), range: announced.videoRange } : null);

      const resumeAt = opts?.resumeAt;
      // Avant le chargement, et pas seulement dans son rappel plus bas : entre cet instant et
      // l'arrivée des métadonnées il s'écoule plusieurs secondes sur un gros fichier, et c'est
      // exactement la fenêtre pendant laquelle une fermeture rapportait zéro.
      lastKnownTime.current = resumeAt ?? 0;
      castResume.planned(resumeAt);
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
          if (linkWatch.current) clearInterval(linkWatch.current);
          linkWatch.current = null;
          setLinkSignal(NO_LINK_SIGNAL);
          nativeErrorRetryCount.current = 0;
          if (nativeHls || data.isDirectPlay) startup.fromResources(resourceEntries(), STREAM_PREFIX);
          startup.picture();
          // Le résultat d'une version allégée (§78) : l'image, en combien de temps depuis la demande, et
          // l'interruption depuis la bascule.
          if (cap.step) slowLogRef.current.note(`image en ${Math.round(performance.now() - startedAt)} ms (allégée palier ${cap.step.tier}${warmed ? ", préchauffée" : ""})`);
          // L'image est là : un préchauffage d'ouverture ne sert plus — arrêté chez Jellyfin.
          if (runner.held && runner.held.cause !== "lecture") runner.drop("image");
          if (switchedAtRef.current !== null) {
            switchGapRef.current = Date.now() - switchedAtRef.current;
            slowLogRef.current.note(`bascule : image ${switchGapRef.current} ms après`);
            switchedAtRef.current = null;
          }
          if (reloadDecidedAtRef.current !== null) {
            reloadGapRef.current = Date.now() - reloadDecidedAtRef.current;
            slowLogRef.current.note(`rechargement direct : image ${reloadGapRef.current} ms après la décision`);
            reloadDecidedAtRef.current = null;
          }
          // Une marche qui se charge a trouvé le coupable : retenu pour le reste de cette ouverture
          // seulement (voir AUDIO_FALLBACK_RUNGS et `learnedExclusions`).
          if (opts?.disableAudioCodecs?.length) {
            learnedExclusions.current = [...new Set([...learnedExclusions.current, ...opts.disableAudioCodecs])];
            carryLearnedExclusions(itemId, learnedExclusions.current);
          }
          if (resumeAt) {
            // L'image à la position de reprise, au bilan (`diag.resume*`, LECTEUR-2) : `pictureMs` ci-dessus
            // est celle d'avant ce saut.
            startup.resumeSeek();
            video.addEventListener("seeked", () => startup.resumePicture(), { once: true });
            resumeSeekPendingRef.current = true;
            video.currentTime = resumeAt;
          }
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
      //
      // Avant de dire « trop long », on regarde ce que le lien a livré pendant ces vingt secondes
      // (hls.js seulement : c'est lui qui fait les requêtes et peut les compter — Safari lit son HLS
      // lui-même, sans rien en dire). Une connexion trop lente, validée par ses chiffres, est nommée
      // au journal et à l'écran (§77) ; sans preuve, tout reste comme avant.
      const linkMeter = new LinkMeter();
      const needBps = streamNeedBps(data.playbackInfo);
      linkMeterRef.current = linkMeter;
      streamNeedRef.current = needBps;
      setLinkFailure(null);
      setHlsJs(!nativeHls && !data.isDirectPlay);
      measureStartRef.current = startedAtWall;
      /**
       * L'écran d'échec du chien de garde arrête ce chargement-ci (passe de nuit du 15/10/2026,
       * LECTEUR-5). Il ne faisait que s'afficher : hls.js continuait de charger, et sur un lien lent
       * le film démarrait 6 à 30 s plus tard *sous* « Le chargement prend trop de temps », le son
       * derrière un écran qui ne partait jamais. L'écran dit « Réessayer », qui renégocie de zéro
       * (`handleRetry` → `startPlayback`) : rien de ce chargement ne lui sert. hls.js est détruit —
       * comme au bout du budget de récupération, sans quoi sa MediaSource se rechargerait seule
       * (`autoStartLoad`, `autoPlay`) ; le HLS natif et la lecture directe sont mis en pause, sans
       * toucher à leur `src` (WebKit et sa session HLS unique : « Réessayer » remonte l'élément).
       * `halted` arrête aussi un hls.js dont le module n'était pas encore arrivé.
       */
      let halted = false;
      const haltLoading = () => {
        halted = true;
        resumeKick.current?.abort();
        if (generation !== playbackGeneration.current) return;
        const current = hlsRef.current;
        if (current) {
          current.destroy();
          hlsRef.current = null;
        } else {
          video.pause();
        }
      };
      const fireWatchdog = () => {
        if (linkWatch.current) clearInterval(linkWatch.current);
        linkWatch.current = null;
        setLinkSignal(NO_LINK_SIGNAL);
        let slow: ReturnType<typeof slowLinkVerdict> = null;
        try {
          // Jamais pendant une coupure (hls.js réessaie, ou le navigateur est hors ligne) : une coupure
          // n'est pas une lenteur, et n'appelle jamais la version allégée (§78). Sur le compteur
          // courant — réarmé au retour du premier plan, jamais une mesure d'arrière-plan.
          slow = unstableRef.current ? null : slowLinkVerdict(linkMeterRef.current?.measure(), needBps);
        } catch {
          slow = null;
        }
        // Où en était le démarrage — la liste, un segment, son décodage, l'image (§77).
        if (nativeHls || data.isDirectPlay) startup.fromResources(resourceEntries(), STREAM_PREFIX);
        const stages = startup.fields(true);
        if (cap.step) slowLogRef.current.note(`échec (allégée palier ${cap.step.tier}) : pas d'image en 20 s`);
        // La décision au délai du renoncement (§78) : lenteur prouvée et un palier encore possible en
        // « Automatique » → la bascule au palier suivant, au lieu de l'écran.
        const { action } = decideOpening({
          measure: slow ? { bytes: slow.bytes, receivingMs: slow.measuredMs } : null,
          needBps,
          elapsedMs: 20_000,
          unstable: unstableRef.current,
          auto: autoLighterRef.current && !nativeHls && !data.isDirectPlay,
          prewarm: "failed",
          currentStep: cap.step,
          giveUpMs: 20_000,
        });
        if (slow && action.kind === "switch") {
          runner.execute(action, "ouverture", resumeAt ?? 0, slow);
          return;
        }
        // Un écran, pas une bascule : un préchauffage lancé pendant le chargement ne servira pas — arrêté
        // chez Jellyfin, comme le natif quand il renonce (`execute` : `screen` / `giveUp`). Il tournait
        // derrière l'écran jusqu'à la fermeture du lecteur (13/10/2026).
        runner.drop(slow ? "écran final" : "renoncement sans lenteur prouvée");
        if (slow) {
          slowLogRef.current.noteAt("écran trop lente", Date.now() - startedAtWall, slow.recvBps, slow.needBps);
          reportPlayback("error", serverFailureFields(logContext.current, SLOW_LINK_REASON, { ...slowLinkFields(slow), ...stages, quality: autoLighterRef.current ? "auto" : "original", ...slowLogRef.current.fields() }));
          setLinkFailure(frozenReading(slow));
          // « Lecture impossible : la connexion est trop lente. » — sans chiffres (§78).
          setError(t("player.slowLink.failed"));
        } else {
          reportPlayback("error", serverFailureFields(logContext.current, "pas de première image en 20 s", { ...stages, ...slowLogRef.current.fields() }));
          setError(t('player.loadingTooLong'));
        }
        // Après la ligne `error`, qui lit encore le démarrage tel qu'il était.
        try {
          haltLoading();
        } catch {
          // L'arrêt n'est qu'un ménage : l'écran d'échec doit paraître quoi qu'il arrive.
        }
        setReconnecting(false);
        setLoading(false);
      };
      watchdogFireRef.current = fireWatchdog;
      loadWatchdog.current = setTimeout(fireWatchdog, 20_000);
      // Chaque seconde du chargement, le lien mesuré (§78 — hls.js seulement : Safari lit son HLS
      // lui-même et la lecture directe n'est pas comptée ; rien n'y change). L'indice ; en
      // « Automatique », le préchauffage du palier suivant dès 8 s et la bascule à 10 s (très lente) ou
      // à 20 s (moyenne) si l'image n'est toujours pas là. Aucune requête sur un bon lien, rien sous une
      // erreur, rien pendant une coupure ; arrêté avec le chien de garde, à la première image, à la
      // négociation suivante et au démontage.
      if (!nativeHls && !data.isDirectPlay) {
        let shown: LinkSignal = NO_LINK_SIGNAL;
        linkWatch.current = setInterval(() => {
          if (generation !== playbackGeneration.current || errorRef.current) return;
          if (document.visibilityState === "hidden") return;
          let measure: ReturnType<LinkMeter["measure"]> | null = null;
          try {
            measure = linkMeterRef.current?.measure() ?? null;
          } catch {
            measure = null;
          }
          // Avant le chien de garde : le renoncement reste à lui, comme avant.
          const elapsed = Math.min(Date.now() - measureStartRef.current, 20_000 - 1);
          const { advice, action } = decideOpening({
            measure,
            needBps,
            elapsedMs: elapsed,
            unstable: unstableRef.current,
            auto: autoLighterRef.current,
            prewarm: runner.status("ouverture"),
            currentStep: cap.step,
            giveUpMs: 20_000,
          });
          if (advice.hint !== shown.hint) {
            slowLogRef.current.noteAt(advice.hint ? "indice" : "indice retiré", elapsed, advice.recvBps, advice.needBps);
            shown = { hint: advice.hint, recvBps: advice.recvBps, needBps: advice.needBps };
            setLinkSignal(shown);
          }
          runner.execute(action, "ouverture", resumeAt ?? 0, advice);
        }, 1000);
      }

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
      // Le sous-titre que le lecteur natif montrait, rallumé une fois quand la version allégée prend
      // le relais (§78) — seulement s'il existe dans ce flux ; sinon aucun, comme avant.
      const carriedSubtitle = takeSubtitleCarry();
      const carried = carriedSubtitle !== null && tracks.some((st) => st.index === carriedSubtitle) ? carriedSubtitle : null;
      // « Deux sous-titres » retenu sur l'appareil (§87), réappliqué à chaque négociation si ses langues
      // sont dans ce flux : chaque négociation repose ses pistes `<track>`, et les sous-titres avec.
      const dual = pickRememberedDual(tracks.map(subtitleFacts), carried, dualSubtitleMemory.read());
      const wantedSubtitle = dual ? dual.primary.number : carried;
      currentSubtitleRef.current = wantedSubtitle;
      secondSubtitleRef.current = dual ? dual.second.number : null;
      setCurrentSubtitleId(wantedSubtitle);
      setSecondSubtitleId(secondSubtitleRef.current);
      if (wantedSubtitle !== null) {
        video.addEventListener(
          "loadeddata",
          () => {
            // En mode deux sous-titres, c'est `useServerDualSubtitles` qui pose les modes.
            if (secondSubtitleRef.current !== null) return;
            const position = tracks.findIndex((st) => st.index === wantedSubtitle);
            for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = i === position ? "showing" : "disabled";
          },
          { once: true }
        );
      }

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
            if (session.reloadCarry?.direct !== undefined && session.reloadCarry.lighter !== undefined) setAwaitingTap(true);
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
       * porter son laissez-passer — et ce dans toute lecture, parce que le bouton AirPlay de la
       * vidéo peut l'envoyer à la télé sans passer par « Diffuser » (24/09/2026 : une heure de
       * refus au téléviseur, et une image qui sautait). `manifestUrl` ne sert plus qu'à un
       * serveur d'avant ce changement.
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

      /**
       * Une reprise ouverte par hls.js part du segment de la reprise (LECTEUR-2, 15/10/2026).
       *
       * Sans cela, hls.js demandait l'init puis le segment 0 : Jellyfin lançait ffmpeg au début du film,
       * puis — le saut de reprise posé au `loadeddata` — le relançait au segment voulu (*L'Exorciste* à
       * 2 205 s, Chrome : 0.mp4, puis 1.mp4 annulé, puis 734.mp4 en 3,8 s). Poser `startPosition` seul ne
       * suffit pas : la demande de l'init suffit à lancer ffmpeg au début. Le préchauffage (§78, §93) le
       * savait déjà : il demande le segment de la position **avant** tout le reste. Le même mécanisme
       * (`warmSegmentAt`, pas une copie), sur la négociation de cette séance elle-même : maître, variante,
       * puis le segment de la reprise, jusqu'à ses en-têtes (Jellyfin ne répond qu'une fois le segment
       * produit ; le corps est laissé à hls.js, pour ne pas le payer deux fois sur un lien lent) ; ffmpeg
       * part là, une seule fois, et hls.js part de ce segment (`startPosition`) — Jellyfin le sert de son
       * disque et poursuit le même ffmpeg.
       *
       * Seulement hls.js en transcodage (`Transcode`) : le seul cas mesuré (*American Beauty*, Chrome,
       * 15/10/2026 — un job `-ss` par séance au lieu de la paire début puis `-ss`). DirectStream (vidéo
       * copiée) reste tel quel tant qu'un gain n'y est pas mesuré ; jamais un préchauffage repris (il a déjà
       * fait tout cela), ni une diffusion, ni le banc. Safari en HLS natif et la lecture directe sont partis
       * plus haut, inchangés. Un échec, ou une réponse en erreur : rien de posé —
       * l'ouverture d'avant, à l'octet. Interrompu si la négociation est remplacée (`resumeKick`). Ses
       * requêtes sont comptées par le compteur du lien comme celles d'hls.js : l'ouverture les attend.
       */
      let kicked = false;
      if (!warmed && typeof resumeAt === "number" && resumeAt > 0 && !castSession && !bench && data.playbackInfo?.playMethod === "Transcode") {
        const controller = new AbortController();
        resumeKick.current = controller;
        try {
          const segment = await warmSegmentAt(sourceUrl, resumeAt, controller.signal, { meter: linkMeterRef.current ?? linkMeter, strict: true, headersOnly: true });
          startup.resumeKicked(segment.index);
          kicked = true;
        } catch {
          kicked = false;
        }
        if (resumeKick.current === controller) resumeKick.current = null;
        if (generation !== playbackGeneration.current || halted) return;
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
        // Repris d'un préchauffage (§78), ou ffmpeg lancé à la reprise juste au-dessus (LECTEUR-2) :
        // partir directement de ce segment. Sans cela hls.js demande le segment 0, puis saute — et
        // Jellyfin relance ffmpeg deux fois (1,85 s mesurées).
        ...(warmed || kicked ? { startPosition: resumeAt ?? 0 } : {}),
        // Compter ce que le lien livre, pour le chien de garde ci-dessus (§77) : des écouteurs de
        // plus sur chaque requête, rien d'autre — `meterXhr` ne lève jamais.
        // Le compteur courant : réarmé au retour du premier plan pendant le chargement (§78).
        // Sous le simulateur de connexion de la page de test (§78), le chargeur bridé compte lui-même,
        // au rythme simulé ; partout ailleurs, `xhrSetup` comme avant.
        ...(simulatorActive()
          ? { loader: throttledHlsLoader(Hls.DefaultConfig.loader, () => (linkMeterRef.current ?? linkMeter).open()) }
          : { xhrSetup: (xhr: XMLHttpRequest) => meterXhr(linkMeterRef.current ?? linkMeter, xhr) }),
      });
      // Dernier recours : l'import de hls.js est lui aussi un await, et l'instance vient d'être
      // construite. Sans ce garde elle s'écrirait par-dessus celle d'un appel plus récent, qui
      // resterait vivante et sans propriétaire.
      // Ou le chien de garde a déjà renoncé pendant l'import (`haltLoading`) : pas de chargement
      // qui démarrerait sous son écran.
      if (generation !== playbackGeneration.current || halted) {
        hls.destroy();
        return;
      }
      hlsRef.current = hls;
      // Le flux réellement envoyé, d'après le maître que hls.js a lu (panneau, « Diffusé ») : `attrs`
      // brut pour la plage — son `videoRange` répond « SDR » quand le maître ne dit rien.
      const noteLevel = (level: { videoCodec?: string; audioCodec?: string; attrs?: Record<string, unknown> } | undefined) => {
        try {
          if (!level || generation !== playbackGeneration.current) return;
          const range = level.attrs?.["VIDEO-RANGE"];
          setServedCodecs({ video: level.videoCodec ?? null, audio: level.audioCodec ?? null, range: typeof range === "string" ? range : null });
        } catch {
          /* le panneau se passe de cette ligne */
        }
      };
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => noteLevel(d?.levels?.[0]));
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => noteLevel(hls.levels?.[d?.level]));

      // A successfully buffered fragment means the stream is healthy again — reset both
      // counters so a later, unrelated blip gets its own full retry budget instead of
      // inheriting an exhausted one from an earlier, already-recovered outage.
      // Les étapes du démarrage (§77), d'après hls.js lui-même : les deux listes, le premier
      // segment demandé, reçu, puis accepté par le tampon. Seule la première fois compte.
      hls.on(Hls.Events.MANIFEST_LOADED, (_e, d) => startup.master(d?.stats));
      hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => startup.variant(d?.stats));
      hls.on(Hls.Events.FRAG_LOADING, () => startup.fragAsked());
      hls.on(Hls.Events.FRAG_LOADED, (_e, d) => startup.fragLoaded(d?.frag?.stats, d?.payload?.byteLength));
      // La borne d'une coupure (`NETWORK_OUTAGE_GIVE_UP_MS`) : armée au premier signe, une seule fois
      // par coupure ; à l'échéance, l'écran final — hls.js arrêté et détaché, comme au bout du budget
      // média, pour qu'il ne reprenne pas sous l'écran quand le réseau revient.
      const armOutage = () => {
        if (outageTimer.current) return;
        outageTimer.current = setTimeout(() => {
          outageTimer.current = null;
          if (generation !== playbackGeneration.current || hlsRef.current !== hls) return;
          if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
          networkRetryTimer.current = null;
          try {
            hls.stopLoad();
            hls.detachMedia();
          } catch {
            // L'arrêt n'est qu'un ménage : l'écran doit paraître quoi qu'il arrive.
          }
          setReconnecting(false);
          setLoading(false);
          setError(t('player.playbackInterruptedCheckConnection'));
        }, NETWORK_OUTAGE_GIVE_UP_MS);
      };
      const disarmOutage = () => {
        if (outageTimer.current) clearTimeout(outageTimer.current);
        outageTimer.current = null;
      };
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        startup.buffered();
        disarmOutage();
        networkRetryCount.current = 0;
        // Un fragment reçu ne prouve pas qu'il se décode : seulement si l'élément tient une image.
        // Remis à zéro à chaque fragment, le compte des erreurs média ne bornait plus rien sur un
        // décodeur qui refuse tout — 109 reprises identiques en 20 s (Android, 19/10/2026).
        if ((videoRef.current?.readyState ?? 0) >= HTMLMediaElement.HAVE_CURRENT_DATA) mediaRetryCount.current = 0;
        setReconnecting(false);
        // hls.js keeps refining this per fragment even with a single-rendition stream (no real
        // ABR ladder from Jellyfin's transcoder) — piggybacking on the same event that already
        // resets the retry counters avoids adding a separate polling interval just for this.
        if (typeof hls.bandwidthEstimate === "number" && hls.bandwidthEstimate > 0) {
          setNetworkBitrate(Math.round(hls.bandwidthEstimate));
        }
      });

      // Où en était l'élément au moment où hls.js le détache — le sien (récupération qu'il fait
      // lui-même, 1.7) comme le nôtre. Lu par `recoveryPosition` ci-dessous.
      hls.on(Hls.Events.MEDIA_DETACHING, () => {
        if (generation !== playbackGeneration.current) return;
        hlsDetachedAt.current = livePosition(videoRef.current);
      });
      /**
       * D'où relancer après une récupération. `startLoad()` sans argument, et le rattachement qui suit
       * un `recoverMediaError()` après une fatale, repartent de `config.startPosition` — la position de
       * reprise d'origine d'une séance préchauffée (§78) : la récupération ramenait le spectateur au
       * point d'ouverture (lu dans hls.js 1.7.3, `onMediaAttached` ; déjà vrai en 1.5.17).
       */
      const recoveryPosition = () => hlsRecoveryPosition(videoRef.current, hlsDetachedAt.current, lastKnownTime.current) ?? -1;
      const noteMediaFailure = () =>
        tallyRef.current.retries.noteFailure(retrySignature("hls.js : média", { pos: positionBucket(lastKnownTime.current) }));

      // hls.js's own per-request retry/backoff (fragLoadingMaxRetry etc.) already absorbs a
      // short stall before ever raising a *fatal* error — a fatal here means that budget is
      // already exhausted. hls.js's documented recovery for that case is to call startLoad()
      // (network) or recoverMediaError() (media) ourselves rather than tearing the player down;
      // bounded so a genuinely dead stream still surfaces an error instead of retrying forever.
      hls.on(Hls.Events.ERROR, (_evt, data2) => {
        // hls.js 1.7 récupère lui-même une `MEDIA_SOURCE_REQUIRES_RESET` (`hlsRecovery.ts`) — avant
        // nous, son écouteur passant le premier. Non fatale (une variante SDR a pris le relais), il
        // recharge déjà à la bonne position : la récupération est seulement comptée, au registre et
        // au budget, pour qu'une série de remises à zéro reste bornée comme les nôtres.
        const resetByHls = data2.type === Hls.ErrorTypes.MEDIA_ERROR && hlsResetItself(data2);
        if (!data2.fatal) {
          if (resetByHls) {
            noteMediaFailure();
            mediaRetryCount.current += 1;
          } else if (data2.type === Hls.ErrorTypes.NETWORK_ERROR && data2.response?.code === 0) {
            // Une requête restée sans aucune réponse (statut 0 : la connexion est coupée). hls.js 1.5
            // déclarait aussitôt la fatale, qui posait « Connexion perdue ou instable… » ; 1.7 réessaie
            // d'abord lui-même ce segment — et, `navigator.onLine` faux, attend le réseau sans fin —
            // avant toute fatale. Sans ce marquage, cette coupure ne disait rien et une attente
            // pendant ce temps était jugée comme une lenteur — préchauffage, bascule vers la version
            // allégée, ce que §78 interdit pour une coupure. Effacé au prochain fragment accepté
            // (`FRAG_BUFFERED`). Une expiration (lien lent, octets qui arrivent) n'a pas de statut et
            // n'est pas une coupure. La borne de la coupure part d'ici (`armOutage`).
            setReconnecting(true);
            armOutage();
          }
          return;
        }
        switch (data2.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: {
            tallyRef.current.retries.noteFailure(retrySignature("hls.js : réseau", { pos: positionBucket(lastKnownTime.current) }));
            if (networkRetryCount.current >= MAX_NETWORK_RETRIES) {
              disarmOutage();
              setReconnecting(false);
              setLoading(false);
              setError(t('player.playbackInterruptedCheckConnection'));
              return;
            }
            networkRetryCount.current += 1;
            setReconnecting(true);
            armOutage();
            // Exponential backoff (1s, 2s, 4s... capped at 15s) — covers a brief network
            // handoff (e.g. mobile switching between 5G and Wi-Fi, which drops connectivity
            // for roughly 1-3s) without hammering the server if it's actually down.
            const delay = Math.min(1000 * 2 ** (networkRetryCount.current - 1), 15_000);
            if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
            // À la position d'alors, pas au départ de la séance : voir `recoveryPosition`.
            networkRetryTimer.current = setTimeout(() => hls.startLoad(recoveryPosition()), delay);
            return;
          }
          case Hls.ErrorTypes.MEDIA_ERROR: {
            noteMediaFailure();
            if (mediaRetryCount.current >= MAX_MEDIA_RETRIES) {
              if (escalateToH264Ref.current("hls.js : média")) {
                hls.detachMedia();
                return;
              }
              // hls.js vient peut-être de rattacher l'élément à une MediaSource neuve : à son
              // ouverture, il rechargerait de lui-même (`autoStartLoad`) et l'élément (`autoPlay`)
              // repartirait sous l'écran d'erreur. Détaché, il reste vide — « Réessayer » repart de zéro.
              if (resetByHls) hls.detachMedia();
              setReconnecting(false);
              setLoading(false);
              setError(t('player.playbackInterrupted'));
              return;
            }
            mediaRetryCount.current += 1;
            setReconnecting(true);
            // Une seule récupération par incident : si hls.js vient de la faire, il ne reste qu'à
            // relancer le chargement que sa fatale a arrêté (`stopLoad`) — un second
            // `recoverMediaError()` détachait la MediaSource qu'il venait d'ouvrir.
            const at = recoveryPosition();
            if (!resetByHls) hls.recoverMediaError();
            hls.startLoad(at);
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
  /**
   * La marche H.264 (`H264_RUNG`) : vrai si elle part, faux si elle a déjà été tentée pour cette
   * ouverture — ou si l'élément diffuse, où une relance romprait la route (voir l'écouteur d'erreur).
   * Les deux écouteurs (élément, hls.js) peuvent signaler la même panne : le premier la prend.
   */
  const h264Tried = useRef(false);
  const escalateToH264 = (trigger: string): boolean => {
    if (h264Tried.current || lastPlaybackOpts.current?.videoH264Only || castActiveRef.current) return false;
    h264Tried.current = true;
    // Lue tout de suite : hls.js détache l'élément juste après, et le remet à zéro.
    const at = livePosition(videoRef.current) ?? (lastKnownTime.current || lastPlaybackOpts.current?.resumeAt);
    setReconnecting(true);
    if (nativeErrorRetryTimer.current) clearTimeout(nativeErrorRetryTimer.current);
    nativeErrorRetryTimer.current = setTimeout(() => {
      if (castActiveRef.current) return;
      startPlaybackRef.current({
        ...lastPlaybackOpts.current,
        resumeAt: at,
        videoH264Only: true,
        forceAudioTranscode: true,
        cause: { why: "ladder", rung: H264_RUNG, trigger: `${trigger} → image en H.264` },
      });
    }, 1200);
    return true;
  };
  const escalateToH264Ref = useRef(escalateToH264);
  useEffect(() => {
    startPlaybackRef.current = startPlayback;
  }, [startPlayback]);

  const changeAudio = useCallback(
    (id: number) => {
      // Un choix à la main : la langue retenue par série en tient compte (`seriesLanguage.ts`), comme
      // depuis le lecteur natif.
      if (!bench) noteSeriesLanguage(itemId, toJellyfinLanguage(audioLanguagesRef.current.get(id) ?? null));
      // La position à Jellyfin tout de suite, avant la renégociation : le battement ne part plus
      // que toutes les 30 s (13/10/2026, `usePlaybackSession`).
      reportPositionNow();
      const video = videoRef.current;
      // La position connue, pas celle de l'élément : pendant un chargement, il est encore à 0, et
      // changer de piste à ce moment relançait le film depuis le début (23/09/2026).
      const resumeAt = video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? video.currentTime : lastKnownTime.current;
      // Au bilan, comme le lecteur natif — rechargement de page compris (la page suivante ouvre
      // sa propre séance, qui le dira dans son `start`, `why: "audio-reload"`).
      tallyRef.current.audioSwitched();
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
      if (video && playsHlsNatively(video)) {
        try {
          sessionStorage.setItem(
            PLAYER_RELOAD_INTENT_KEY,
            // `server` : la page rechargée revient au lecteur serveur — voir `reloadedOnServer`.
            // `carry.lighter` : le palier en cours voyage avec la piste, pas par la mémoire des deux
            // minutes (qui pouvait avoir expiré : la séance repartait en pleine qualité, 12/10/2026).
            JSON.stringify({ itemId, title, audioStreamIndex: id, resumeAt, server: true, carry: reloadCarryNow() } satisfies PlayerReloadIntent)
          );
          // Tear the current media session down BEFORE reloading, not merely as a side effect of
          // the page dying: iOS's media daemon (mediaserverd) releases HLS sessions asynchronously
          // and independently of the page lifecycle, so a reload issued while the old stream is
          // still actively playing can bring the new page up before the old session is gone.
          // Starting teardown explicitly here buys that release as much head start as possible.
          releaseHlsElement(video);
          window.location.reload();
          return;
        } catch {
          // Storage unavailable (private browsing, quota): falls through to the in-place switch
          // below, which will most likely fail on WebKit and show the error screen with « Réessayer ».
          // Coupure et rechargement sont dans le `try`, comme à la fin de l'échelle : du 14/08 au
          // 22/10/2026 ils le suivaient, la page revenait sans intention et le film se fermait sans
          // rien dire (audit du 22/10/2026).
        }
      }
      startPlayback({ audioStreamIndex: id, resumeAt, cause: { why: "audio" } });
    },
    [startPlayback, itemId, title, reloadCarryNow, reportPositionNow, bench]
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
  //
  // La même demande que la précédente, comme les deux autres relances (l'échelle audio, la
  // relance d'une diffusion) : ce bouton ne passait que la position, et perdait la piste audio
  // de la séance — celle du menu, du relais venu du natif, de la reprise WebKit — ainsi que les
  // codecs que l'échelle venait d'écarter. Le film repartait dans la langue par défaut du fichier,
  // souvent la VO que le natif venait de confier à ce lecteur, et rejouait la négociation qui
  // avait échoué (audit A8, 29/09/2026).
  //
  // La position : `lastKnownTime` d'abord, la position de la demande précédente s'il vaut zéro.
  // Zéro ne dit pas toujours « le spectateur était au début » : une négociation qui échoue avant
  // d'avoir semé la référence la laisse à sa valeur de montage, zéro quand la séance n'en portait
  // pas, alors que la demande, elle, avait une position résolue. Le même choix que les deux autres
  // relances, pour qu'un même échec ne reparte pas de deux endroits selon le chemin.
  const handleRetry = useCallback(() => {
    // Un appui du spectateur, et non une reprise automatique : il rouvre l'échelle audio en
    // entier. Sans cela, l'échelle déjà épuisée qui a conduit à cet écran faisait retomber le
    // moindre nouvel échec directement dessus, sans un seul des essais de repli.
    nativeErrorRetryCount.current = 0;
    if (!slowLogRef.current.empty) slowLogRef.current.choose("réessayer", Date.now() - sessionStartedAtRef.current);
    runner.seekDone();
    startPlayback({
      ...lastPlaybackOpts.current,
      resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt,
      cause: { why: "retry" },
    });
  }, [startPlayback, runner]);

  /** Les messages brefs de la version allégée (§78) : quelques secondes, puis retirés seuls. */
  useEffect(() => {
    if (!subtitleGenNotice) return;
    const id = setTimeout(() => setSubtitleGenNotice(false), 6000);
    return () => clearTimeout(id);
  }, [subtitleGenNotice]);
  useEffect(() => {
    if (!switchNotice) return;
    const id = setTimeout(() => setSwitchNotice(false), 5000);
    return () => clearTimeout(id);
  }, [switchNotice]);

  // Always toggles the native <track> elements rendered from externalSubtitleTracks below —
  // regardless of PlayMethod, since subtitles are now uniformly external VTT (see startPlayback).
  // video.textTracks is indexed by DOM position, not by Jellyfin's own stream index (`id`
  // here), so the position has to be looked up in externalSubtitleTracks (rendered in the same
  // order) rather than assuming textTracks[id].
  const changeSubtitle = useCallback((id: number | null) => {
    const video = videoRef.current;
    if (!video) return;
    reportPositionNow();
    // Le second ne survit pas à un principal éteint, ni à devenir le principal (§87).
    const wasDual = secondSubtitleRef.current !== null;
    if (wasDual && (id === null || id === secondSubtitleRef.current)) {
      secondSubtitleRef.current = null;
      setSecondSubtitleId(null);
    }
    currentSubtitleRef.current = id;
    const position = id === null ? -1 : externalSubtitleTracks.findIndex((t) => t.index === id);
    subtitleSwitchesRef.current += 1;
    // Toujours deux sous-titres : `useServerDualSubtitles` repose les modes, le navigateur ne doit pas
    // dessiner le nouveau principal entre-temps.
    if (secondSubtitleRef.current === null || castActive) {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = i === position ? "showing" : "disabled";
      }
    }
    setCurrentSubtitleId(id);
    if (wasDual) rememberDual(subtitleFactsOf(externalSubtitleTracks, id), subtitleFactsOf(externalSubtitleTracks, secondSubtitleRef.current));
  }, [externalSubtitleTracks, reportPositionNow, castActive]);

  /** Le second sous-titre (§87) : jamais le principal, jamais sans principal. */
  const changeSecondSubtitle = useCallback((id: number | null) => {
    const primary = currentSubtitleRef.current;
    if (id !== null && (primary === null || id === primary)) return;
    reportPositionNow();
    subtitleSwitchesRef.current += 1;
    secondSubtitleRef.current = id;
    setSecondSubtitleId(id);
    rememberDual(subtitleFactsOf(externalSubtitleTracks, primary), subtitleFactsOf(externalSubtitleTracks, id));
  }, [externalSubtitleTracks, reportPositionNow]);

  const primarySubtitleNow = useCallback(() => currentSubtitleRef.current, []);
  const dualSubtitles = useServerDualSubtitles({
    videoRef,
    trackIds: subtitleTrackIds,
    primaryNow: primarySubtitleNow,
    primary: currentSubtitleId,
    second: secondSubtitleId,
    // Pendant une diffusion, la télévision ne reçoit que le principal : rien n'est dessiné ici.
    enabled: !castActive,
    videoKey,
  });

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
    // it on top of whatever the video's actual live volume already is). Le lecteur natif fait de
    // même, par la même fonction — DECISIONS.md §35.
    restoreRememberedVolume(videoRef.current);

    const graceMs = fromReload ? 3000 : 0;
    // Une position absente veut dire « demande au serveur », pas « du début » — voir
    // `resolveResumeAt`. Ce lecteur la lisait comme un zéro, et c'est lui qui s'ouvre quand le
    // compte a choisi le lecteur stable : sa séance repartait du début, puis ses rapports de
    // progression effaçaient la position chez Jellyfin.
    let abandoned = false;
    const graceTimer = setTimeout(() => {
      void resolveResumeAt(itemId, initialResumeAt).then((resumeAt) => {
        if (abandoned) return;
        /**
         * Reprendre quelques secondes avant, comme le lecteur natif — DECISIONS §28.
         *
         * Ce lecteur ouvrait pile à la position : un compte qui a choisi le lecteur stable ne
         * profitait pas du recul que tout le monde a depuis le 25/09 (relevé le 27/09/2026). À la
         * première ouverture seulement : pas un relais (`mine`, qui porte la position exacte où le
         * natif s'est arrêté, ou le retour d'une télé), pas un rechargement pour changer de piste,
         * pas le banc. La durée n'est pas encore connue ici : le recul près de la fin n'est donc
         * pas retenu, ce qui ne coûte que cinq secondes rejouées.
         */
        // Un rechargement direct d'avant toute image est une ouverture qui a changé de lecteur : même recul.
        const opening = !fromReload || session.reloadCarry?.direct?.opening === true;
        // Ni pour une scène (§91) : elle part déjà cinq secondes avant la réplique.
        const at = !mine && opening && !bench && !isSceneRef.current() ? openingPosition(itemId, resumeAt, null) : resumeAt;
        // Pourquoi cette première négociation : une page rechargée (piste WebKit, ou dernier
        // recours de l'échelle audio), le relais du lecteur natif — la séance qu'il passe, pas
        // l'épisode suivant que ce lecteur enchaîne ensuite —, ou une ouverture.
        // Le rechargement direct d'une bascule natif → serveur (WebKit) a son propre motif.
        const why: ServerStartWhy = fromReload
          ? session.reloadCarry?.direct
            ? "reload-direct"
            : (reloadAttempt ?? 0) > 0
              ? "retry-reload"
              : "audio-reload"
          : continuesSession && logSession.current.id === continuesSession
            ? "handover"
            : "open";
        startPlayback({ resumeAt: at, audioStreamIndex: initialAudioStreamIndex, cause: { why } });
      }, () => {
        // Position inconnue, Jellyfin muet (14/10/2026, §92) : `resolveResumeAt` lève plutôt que de
        // rendre zéro — ouvrir au début aurait laissé nos rapports effacer la reprise. Le dire.
        if (abandoned) return;
        setError(t("player.libraryUnreachable"));
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
      if (outageTimer.current) clearTimeout(outageTimer.current);
      outageTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
      if (linkWatch.current) clearInterval(linkWatch.current);
      linkWatch.current = null;
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
    const video = videoRef.current;
    // Pas `currentTime || 0` : une diffusion quittée pendant son chargement n'a pas encore posé sa
    // position, et le film repartait du début — voir `castHandBackPosition`.
    const at = castHandBackPosition(video?.currentTime ?? 0, lastKnownTime.current, lastPlaybackOpts.current?.resumeAt);
    /**
     * Revenir sur le téléphone arrête le téléviseur, et le dit — comme la croix.
     *
     * Ce bouton rendait la main sans rien toucher : or démonter l'élément ne coupe pas une session
     * AirPlay (constaté le 26/09/2026 pour la croix), et la télé pouvait continuer pendant que le
     * téléphone reprenait. Il n'écrivait pas non plus de ligne : le temps regardé sur la télé
     * disparaissait du journal, puisque le démontage retire l'écoute de la route avant tout
     * événement (relevé le 27/09/2026, docs/cycle-de-vie-lecteur.md). `closingRef` fait taire
     * cette écoute, qui sinon rendrait la main une seconde fois, en pause.
     */
    //
    // Seulement si une diffusion avait vraiment pris : sélecteur refermé sur le téléphone, télé
    // jamais connectée, il n'y a pas de fin de diffusion à écrire — et le temps regardé ici l'a été
    // sur le téléphone, il ne doit pas partir dans une ligne de télé (relu le 27/09/2026).
    if (castActiveRef.current) {
      reportPlayback("fallback", castEndedFields(logContext.current, "retour demandé sur le téléphone", at, watched.take(Date.now())));
    }
    if (video && castActiveRef.current) {
      closingRef.current = true;
      try {
        releaseHlsElement(video);
      } catch {
        // Déjà démonté : il n'y a plus rien à arrêter.
      }
    }
    // La main passe au lecteur natif : sa séance continue là-bas, ni bilan perdu ni `stop` ici.
    markHandedOver();
    onCastEnded?.(at);
  }, [onCastEnded, watched, markHandedOver]);

  const castAttempted = useRef(false);
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
      cause: { why: "cast-relaunch" },
    });
  }
  useEffect(() => {
    const video = videoRef.current as CastCapableVideo | null;
    // Écouté dans toutes les séances de ce lecteur, pas seulement celles ouvertes pour diffuser
    // (24/09/2026). Le bouton AirPlay des commandes de la vidéo marche partout : un film rouvert
    // sur ce lecteur, puis envoyé à la télé de là, a joué vingt-sept minutes sur un téléviseur —
    // le relais voyait l'appareil AirPlay chercher chaque morceau — pendant que le journal disait
    // « sans diffusion », faute d'écouteur. Hors séance de diffusion, rien d'autre ne change : ni
    // sélecteur ouvert d'office, ni main rendue au lecteur natif à la fin.
    if (!video) return;

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
    if (castSession) {
      if (video.readyState >= 1) openPicker();
      else video.addEventListener("loadedmetadata", openPicker, { once: true });
    }

    /**
     * Rendre la main, en disant d'où vient la décision.
     *
     * Sans cette ligne, une diffusion qui s'arrête ne laisse aucune trace : le journal ne montre
     * que le lecteur natif qui redémarre, sans dire si c'est le téléviseur qui a lâché, le centre
     * de contrôle du téléphone, ou nous. C'est précisément ce qui a coûté une demi-journée à
     * comprendre le 19/09/2026, et la question se reposera.
     */
    const ended = (source: string) => {
      // Provoquée par la croix : la séance est déjà close, et la rendre au téléphone rouvrirait le
      // lecteur natif pendant la fermeture.
      if (closingRef.current) return;
      // Avec la séance et la marque de diffusion : sans elles, la ligne se rangeait dans une séance
      // « reconstituée » et comptait comme un repli raté sur la page Activité (24/09/2026).
      // Avec le temps joué jusque-là, pris et remis à zéro : le lecteur est démonté juste après s'il
      // avait été ouvert pour diffuser, et sinon son `stop` ne comptera que la suite.
      reportPlayback("fallback", castEndedFields(logContext.current, source, video.currentTime || 0, watched.take(Date.now())));
      // En pause : la route est tombée sans que personne ne demande à continuer sur le téléphone.
      if (castSession) {
        markHandedOver();
        onCastEnded?.(castHandBackPosition(video.currentTime, lastKnownTime.current, lastPlaybackOpts.current?.resumeAt), true);
      }
    };
    // La reprise que la route vient peut-être d'emporter à 0, reposée quand la télé joue — voir
    // `CastResume`. Une fois par établissement, et retirée avec les autres écouteurs.
    let resumeOnTv: (() => void) | null = null;
    const armCastResume = () => {
      if (resumeOnTv) video.removeEventListener("playing", resumeOnTv);
      resumeOnTv = () => {
        if (resumeOnTv) video.removeEventListener("playing", resumeOnTv);
        resumeOnTv = null;
        const from = video.currentTime || 0;
        const target = castResume.take(from);
        if (target === null) return;
        reportPlayback("cast", castResumeFields(logContext.current, from, target));
        try {
          video.currentTime = target;
        } catch {
          /* la télé garde sa position ; le spectateur peut encore y aller lui-même */
        }
      };
      video.addEventListener("playing", resumeOnTv);
      // Déjà en train de jouer : la télé a fini de charger avant que la route ne se dise établie.
      if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) resumeOnTv();
    };
    const setActive = (active: boolean) => {
      // Établie, et pas seulement demandée : sans cette ligne, un téléviseur resté en chargement
      // ne se distinguait pas d'un téléviseur qui jouait (22/09/2026).
      if (active && !castActiveRef.current) {
        reportPlayback("cast", castEstablishedFields(logContext.current, video.currentTime || 0, castResume.pending));
        if (castResume.pending !== null) armCastResume();
      }
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
    // Une route déjà établie ne se signale plus : l'écouteur arrive après l'événement quand le
    // lecteur est remonté pendant la diffusion (une relance, l'épisode suivant). Lue une fois ici.
    if (castRouteActive(video)) setActive(true);

    return () => {
      if (resumeOnTv) video.removeEventListener("playing", resumeOnTv);
      video.removeEventListener("loadedmetadata", openPicker);
      video.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWirelessChanged);
      video.remote?.removeEventListener?.("connect", onConnect);
      video.remote?.removeEventListener?.("disconnect", onDisconnect);
    };
    // Les lignes du journal se nomment par `logContext`, lu au moment d'écrire : ni le titre ni
    // l'épisode ne sont des dépendances, et un changement d'épisode ne réarme pas les écouteurs —
    // ce qui perdrait la route en cours.
  }, [castSession, onCastEnded, videoKey, watched, castResume, markHandedOver]);

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
    function onEnded() {
      if (!hasNextEpisode) {
        handleClose();
        return;
      }
      endStoppedRef.current = true;
      void stopPlaybackNow();
      // « Fin de l'épisode » : les commandes n'ont montré ni carte ni décompte, le lecteur reste sur
      // la dernière image — il n'a pas d'écran de fin — et la mise en veille part au journal.
      holdAtEnd();
    }
    function onPlay() {
      if (!endStoppedRef.current) return;
      endStoppedRef.current = false;
      resumePlaybackSession();
    }
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    return () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
    };
  }, [handleClose, videoKey, hasNextEpisode, stopPlaybackNow, resumePlaybackSession, holdAtEnd]);

  // Tracked independently of PlayerControls (which keeps its own copy for the full-mode UI)
  // so the mini player's play/pause icon stays correct without threading state through props.
  // La taille que le navigateur décode réellement (panneau, « Diffusé ») — celle du flux, pas du fichier.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const read = () =>
      setDecodedSize(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    video.addEventListener("emptied", read);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
      video.removeEventListener("emptied", read);
    };
  }, [videoKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    // Le temps regardé s'arrête pendant une attente de l'élément (`WatchedClock.stall`).
    const unwatch = watchElementWaits(video, watched);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      unwatch();
    };
  }, [videoKey, watched]);

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
    // Retenu toutes les quinze secondes de lecture, et à la pause : ce qui distingue, à la
    // prochaine ouverture, un retour rapide d'une vraie reprise (`resumeRewind.ts`). Sans lui, ce
    // lecteur aurait reculé à chaque ouverture, même une minute après l'avoir quitté.
    let notedAt = 0;
    const onTimeUpdate = () => {
      // Pas tant que rien n'est chargé : un changement de source remet l'élément à zéro et émet
      // un `timeupdate` à 0 — qui écrasait la position connue, puis celle de Jellyfin au premier
      // battement (relevé le 23/09/2026). La position semée par `startPlayback` tient jusque-là.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      lastKnownTime.current = video.currentTime;
      // Trois secondes vraiment jouées : la preuve qui efface les échecs du registre (§67).
      tallyRef.current.retries.notePosition(video.currentTime);
      castResume.observed(video.currentTime);
      // Rien de noté pendant une scène (§91) : ce n'est pas une lecture qu'on reprendra.
      if (!video.paused && !bench && !isSceneRef.current() && Date.now() - notedAt > 15_000) {
        notedAt = Date.now();
        noteWatching(itemId);
      }
    };
    // Après une longue pause, quelques secondes en arrière pour se remettre dans la scène — la règle
    // du lecteur natif (`pauseRewindTarget`). Seule une pause sur une image compte : celle d'un
    // changement de source (élément vidé) n'est pas une pause du spectateur.
    let pausedAt: number | null = null;
    const onPause = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      pausedAt = Date.now();
      if (!bench && !isSceneRef.current()) noteWatching(itemId);
    };
    const onPlay = () => {
      const target = !video.ended && !video.seeking && !bench ? pauseRewindTarget(pausedAt, Date.now(), video.currentTime, video.duration) : null;
      pausedAt = null;
      if (target !== null) video.currentTime = target;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
    };
  }, [videoKey, itemId, bench, castResume]);

  /**
   * Les attentes et les sauts de la séance, pour son bilan — les règles du lecteur natif
   * (`SessionTally`) : une attente compte à partir de 250 ms, en pleine lecture seulement (ni
   * l'ouverture ni un saut) ; un saut compte du geste à la reprise de l'image, ou au `seeked` s'il
   * arrive en pause. Les sauts de l'ouverture (la position de reprise posée par `startPlayback`)
   * précèdent la première lecture et ne comptent pas.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let playedOnce = false;
    let seekSince: number | null = null;
    /**
     * Les saccades (§78), hls.js seulement — c'est lui qui compte ses octets. Une attente est du
     * réseau quand le tampon était vide en son début (moins d'une seconde devant : sinon c'est le
     * décodeur) et que la capacité mesurée sur 30 s est sous le besoin du flux ; jamais pendant une
     * coupure, jamais page cachée. Les attentes d'un saut ne comptent jamais.
     */
    let waitStart: { at: number; ahead: number | null } | null = null;
    let longTimer: ReturnType<typeof setTimeout> | null = null;
    const networkStall = (ahead: number | null) =>
      hlsRef.current !== null &&
      (ahead === null || ahead < 1) &&
      document.visibilityState !== "hidden" &&
      !unstableRef.current &&
      playbackLinkSlow(linkMeterRef.current?.recentMeasure(PLAYBACK_MEASURE_WINDOW_MS), streamNeedRef.current);
    const endWait = (now: number) => {
      if (longTimer !== null) clearTimeout(longTimer);
      longTimer = null;
      const started = waitStart;
      waitStart = null;
      if (started && now - started.at > 1000) pushSlowLinkEvent(`blocage de ${now - started.at} ms (serveur)`);
      if (!started) return;
      // Le 2e blocage préchauffe, le 3e bascule (§78) — la règle de bascule, elle, est inchangée.
      const signal = stutterRef.current.waitEndedSignal(now, now - started.at, networkStall(started.ahead));
      if (signal === "switch") offerStutterRef.current();
      else if (signal === "prewarm") playbackDecisionRef.current(false, true);
    };
    const onPlaying = () => {
      const now = Date.now();
      setAwaitingTap(false);
      playedOnce = true;
      sessionPlayedRef.current = true;
      tallyRef.current.waitEnded(now);
      endWait(now);
      // L'image est là : un saut qui l'attendait n'attend plus (§78).
      runner.seekDone();
      if (seekSince !== null) {
        tallyRef.current.seekArrived(now - seekSince);
        seekSince = null;
      }
    };
    const onWaiting = () => {
      if (playedOnce && !video.seeking && seekSince === null) {
        tallyRef.current.waitStarted(Date.now());
        const ahead = bufferedAhead(video);
        waitStart = { at: Date.now(), ahead };
        if (longTimer !== null) clearTimeout(longTimer);
        longTimer = setTimeout(() => {
          longTimer = null;
          if (waitStart && networkStall(waitStart.ahead) && stutterRef.current.longWait(Date.now(), true)) offerStutterRef.current();
        }, LONG_STALL_MS);
      }
    };
    const onSeeking = () => {
      const resumeSeek = resumeSeekPendingRef.current;
      resumeSeekPendingRef.current = false;
      if (!playedOnce) return;
      tallyRef.current.waitAbandoned();
      if (longTimer !== null) clearTimeout(longTimer);
      longTimer = null;
      waitStart = null;
      // Le saut de reprise de la négociation : ni compté, ni traité comme un saut qui attend (§78).
      if (resumeSeek) return;
      seekSince ??= Date.now();
      // Un saut attend son image : au-delà de 10 s, traité comme une ouverture (§78). Compté depuis le
      // premier d'une série de sauts.
      if (runner.seekPending === null) runner.seekStarted();
    };
    const onSeeked = () => {
      // Posé en pause, ou de quoi repartir aussitôt : ce saut n'attend plus son image (§78).
      if (video.paused || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) runner.seekDone();
      if (seekSince === null || !video.paused) return;
      tallyRef.current.seekArrived(Date.now() - seekSince);
      seekSince = null;
    };
    const onPause = () => {
      tallyRef.current.waitEnded(Date.now());
      endWait(Date.now());
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("pause", onPause);
    return () => {
      if (longTimer !== null) clearTimeout(longTimer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("pause", onPause);
    };
  }, [videoKey, runner]);

  /** La coupure en cours, lue par les rappels figés (§78). */
  useEffect(() => {
    unstableRef.current = reconnecting || isOffline;
  }, [reconnecting, isOffline]);

  /**
   * Ce que l'exécution commune des décisions (§78, `SlowLinkRunner`) lit de ce lecteur. Seule la bascule
   * lui est propre : une renégociation (`startPlayback`, `why: "lighter"`) qui reprend le préchauffage
   * tel quel.
   */
  useEffect(() => {
    runner.attach({
      itemId,
      log: () => slowLogRef.current,
      audioStreamIndex: () => lastPlaybackOpts.current?.audioStreamIndex,
      over: () => false,
      switchTo: (step, resumeAt, cause, _held, reading) => {
        switchStepRef.current = { itemId, step };
        carriedOnlyRef.current = false;
        noteLighterOrigin({ kind: "switch", at: resumeAt });
        switchedAtRef.current = Date.now();
        setSwitchNotice(true);
        startPlayback({
          ...lastPlaybackOpts.current,
          resumeAt,
          cause: { why: "lighter", trigger: `${cause}, palier ${step.tier}, ${mbps(step.targetBps)} Mb/s (${mbps(reading.recvBps)} reçus)` },
        });
      },
      screen: (slow, cause) => {
        reportPlayback(
          "error",
          serverFailureFields(logContext.current, SLOW_LINK_REASON, {
            ...slowLinkFields(slow),
            ...(cause === "saut" ? { afterSeek: true } : {}),
            quality: autoLighterRef.current ? "auto" : "original",
            ...slowLogRef.current.fields(),
          })
        );
        setLinkFailure(frozenReading(slow));
        setError(t("player.slowLink.failed"));
      },
      // Le chien de garde des 20 s renonce lui-même (`fireWatchdog`).
      giveUp: () => {},
      playbackDecision: () => playbackDecisionRef.current(),
      seekBlocked: () => hlsRef.current === null || !!errorRef.current || document.visibilityState === "hidden",
      paused: () => videoRef.current?.paused === true,
      seekMeasure: (elapsedMs) => linkMeterRef.current?.recentMeasure(elapsedMs) ?? null,
      needBps: () => streamNeedRef.current,
      unstable: () => unstableRef.current,
      auto: () => autoLighterRef.current,
      currentStep: () => negotiatedStepRef.current,
      // Pendant un saut, la cible du saut : la position connue ne bouge plus (`timeupdate` l'ignore tant
      // que l'élément n'a pas d'image), et un saut resté sans image se préchauffait puis basculait à la
      // position d'avant le saut — le spectateur revenait en arrière de tout ce qu'il avait sauté (13/10/2026).
      position: () => {
        const video = videoRef.current;
        return video?.seeking && Number.isFinite(video.currentTime) ? video.currentTime : lastKnownTime.current;
      },
      seekSignal: setSeekSignal,
    } satisfies SlowLinkHost);
  }, [runner, itemId, startPlayback, t, noteLighterOrigin]);

  /**
   * Les saccades en pleine lecture (§78) : un problème visible (`StutterWatch`). `decidePlayback` :
   * préchauffer le palier suivant à la position courante, puis basculer dès qu'il est prêt.
   */
  useEffect(() => {
    playbackDecisionRef.current = (triggered = false, early = false) => {
      const reading = { recvBps: measuredBps(linkMeterRef.current?.recentMeasure(PLAYBACK_MEASURE_WINDOW_MS)), needBps: streamNeedRef.current };
      const action = decidePlayback({
        triggered: runner.armPlayback(triggered),
        early,
        auto: autoLighterRef.current,
        prewarm: runner.status("lecture"),
        currentStep: negotiatedStepRef.current,
        ...reading,
      });
      if (triggered && action.kind === "prewarm") slowLogRef.current.note(`saccades à ${Math.round(lastKnownTime.current)} s (${mbps(reading.recvBps)}/${mbps(reading.needBps)})`);
      runner.execute(action, "lecture", lastKnownTime.current, reading);
    };
    offerStutterRef.current = () => playbackDecisionRef.current(true);
  }, [runner]);
  // Démonté : un préchauffage qui n'a pas servi est arrêté chez Jellyfin, et le saut n'est plus suivi.
  useEffect(
    () => () => {
      runner.drop("lecteur fermé");
      runner.dispose();
    },
    [runner]
  );
  // Démonté pendant que le segment de la reprise se chargeait (LECTEUR-2) : la requête est interrompue.
  useEffect(
    () => () => {
      resumeKick.current?.abort();
      resumeKick.current = null;
    },
    []
  );
  useEffect(() => {
    const onVisibility = () => {
      // Revenu pendant le chargement (§78) : ce qui a été mesuré en arrière-plan ne vaut rien
      // (minuteurs bridés, réseau en veille). La mesure repart de zéro, et le chien de garde avec elle :
      // aucun verdict sur une mesure d'arrière-plan.
      if (document.visibilityState !== "hidden" && linkWatch.current && loadWatchdog.current && watchdogFireRef.current) {
        linkMeterRef.current = new LinkMeter();
        measureStartRef.current = Date.now();
        clearTimeout(loadWatchdog.current);
        loadWatchdog.current = setTimeout(watchdogFireRef.current, 20_000);
        slowLogRef.current.noteAt("mesure reprise au retour", Date.now() - sessionStartedAtRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /**
   * Pendant une version allégée, le lien retrouve-t-il de quoi porter la lecture classique (§78,
   * `LinkRecovery`) ? Sa capacité sur les 10 dernières secondes contre 110 % du besoin du fichier
   * d'origine ; tenue 10 s, la mémoire des deux minutes s'efface : la lecture suivante revient au
   * lecteur natif. Le film en cours reste allégé jusqu'à sa fin.
   */
  useEffect(() => {
    if (!lighterStep) return;
    const id = setInterval(() => {
      if (lighterClearedRef.current) return;
      const recovery = recoveryRef.current;
      if (!recovery.check(Date.now(), linkMeterRef.current?.recentMeasure(RECOVERY_WINDOW_MS), classicNeedRef.current)) return;
      lighterClearedRef.current = true;
      forgetLighterCarry();
      slowLogRef.current.note(`lien rétabli : ${mbps(recovery.capacityBps)} Mb/s de capacité pour ${mbps(classicNeedRef.current)} en lecture classique`);
    }, 1000);
    return () => clearInterval(id);
  }, [lighterStep]);

  // Bad-connection badge: a real stall mid-playback ('waiting' firing after the video has
  // already played at least once — excludes ordinary startup buffering) is logged with a
  // timestamp; a periodic check then looks at how many landed in the last 60s to decide whether
  // to show the badge (the dropped-frame ratio no longer counts since LECTEUR-8, see below). A
  // measured signal, not a guess — see badConnection's own comment for why not a fabricated
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
      // Les attentes seules. Les images perdues (`getVideoPlaybackQuality`) allumaient aussi la
      // pastille, au-delà de 2 % : c'est un décodeur ou un processeur qui ne suit pas — Fire TV,
      // vieux téléphone, machine chargée —, pas le réseau. Passe de nuit du 15/10/2026 (LECTEUR-8) :
      // « Connexion instable » toute une séance servie à 445 Mb/s, segments en 0,1–0,7 s.
      setBadConnection(rebufferTimestamps.current.length >= 2);
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
        reportPlayback("error", serverFailureFields(logContext.current, "erreur pendant une diffusion — reprise refusée, relance proposée", { code: code ?? 0 }));
        // Ni reprise ni échelle : voir `castInterrupted`. L'écran prend le relais.
        setReconnecting(false);
        setLoading(false);
        setCastInterrupted(true);
        return;
      }
      // Walks AUDIO_FALLBACK_RUNGS (see its comment for the why): rung 0 replays the identical
      // request (absorbs transient teardown races and learns nothing), each further rung
      // disables more audio codecs until the AAC-only rung guarantees a clean server-side audio
      // transcode. The rung whose exclusions finally make the load succeed is kept by the
      // 'loadeddata' handler for the rest of this opening only (`learnedExclusions`).
      // Le registre des tentatives (§67), en observation : la négociation qui vient d'échouer, telle
      // qu'elle serait rejouée. Il compte, il ne décide rien.
      const failed = lastPlaybackOpts.current;
      tallyRef.current.retries.noteFailure(
        retrySignature(`élément : code ${code ?? "?"}`, {
          codecs: [...new Set([...learnedExclusions.current, ...(failed?.disableAudioCodecs ?? [])])].sort().join("+") || "-",
          transcode: failed?.forceAudioTranscode === true,
          pos: positionBucket(lastKnownTime.current || failed?.resumeAt),
        })
      );
      if (nativeErrorRetryCount.current < AUDIO_FALLBACK_RUNGS.length) {
        const rung = AUDIO_FALLBACK_RUNGS[nativeErrorRetryCount.current];
        const lastRung = isLastAudioRung(nativeErrorRetryCount.current);
        nativeErrorRetryCount.current += 1;
        const attempt = nativeErrorRetryCount.current;
        const delay = 1200 * attempt;
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
            reportPlayback("error", serverFailureFields(logContext.current, "reprise abandonnée : une diffusion s'est établie entre-temps"));
            setReconnecting(false);
            return;
          }
          startPlaybackRef.current({
            ...lastPlaybackOpts.current,
            resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt,
            disableAudioCodecs: [...new Set([...(lastPlaybackOpts.current?.disableAudioCodecs ?? []), ...rung])],
            // Le dernier échelon ne copie plus le son, même en AAC : l'AAC dont la disposition est
            // un PCE se dit lisible et ne l'est pas (« Elle s'appelle Ruby », Fire TV, 10/10/2026 —
            // les quatre essais finissaient sur le même refus). Jamais retenu pour la suite : c'est
            // ce fichier-là qui le demande, pas l'appareil.
            ...(lastRung ? { forceAudioTranscode: true } : {}),
            // L'échelon et l'erreur qui l'a provoqué : une échelle qui échoue se distingue ainsi,
            // au journal, d'un changement de piste ou d'un « Réessayer ».
            cause: { why: "ladder", rung: attempt, trigger: `élément : code ${code ?? "?"}` },
          });
        }, delay);
        return;
      }
      // L'échelle du son épuisée sur une image que l'appareil ne décode pas : la marche H.264.
      if (code === MediaError.MEDIA_ERR_DECODE && escalateToH264Ref.current(`élément : code ${code}`)) return;
      // Ladder exhausted. On WebKit, one final escalation before giving up: a fresh full page
      // reload — the only teardown that reliably releases every media-daemon session this page
      // has accumulated, including the zombie attempts each failed retry above just created —
      // whose grace-delayed restart (see fromReload) then loads into a genuinely clean slate.
      // Strictly bounded by the attempt counter carried in the intent so two exhausted ladders
      // can never reload-loop forever.
      if ((reloadAttempt ?? 0) < 1 && playsHlsNatively(video)) {
        try {
          const audioIdx = lastPlaybackOpts.current?.audioStreamIndex;
          sessionStorage.setItem(
            PLAYER_RELOAD_INTENT_KEY,
            JSON.stringify({
              itemId,
              title,
              resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt || 0,
              attempt: (reloadAttempt ?? 0) + 1,
              server: true,
              ...(audioIdx !== undefined ? { audioStreamIndex: audioIdx } : {}),
              carry: reloadCarryNow(),
            } satisfies PlayerReloadIntent)
          );
          releaseHlsElement(video!);
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
  // Commun aux deux lecteurs depuis le 13/10/2026 : `usePlayerFocus`.
  usePlayerFocus(containerRef, mode === "full");

  function toggleMiniPlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  if (typeof document === "undefined") return null;

  const isMini = mode === "mini";
  // Le même mouvement que le lecteur natif et celui des téléchargements (`playerFrame.ts`) : la
  // chaîne était recopiée ici au caractère près.
  const TRANSITION = PLAYER_FRAME_TRANSITION;

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
      // Rien à sélectionner dans le lecteur, vidéo et sous-titres compris (globals.css).
      data-player-frame
      ref={containerRef}
      style={style}
      // app-viewport rather than an inline 100dvh — see its note in globals.css: the right unit
      // for a full-screen shell differs between a browser tab and an installed PWA.
      className={isMini ? "animate-fade-in-scale" : "app-viewport"}
      {...(isMini ? handlers : {})}
    >
      {needsReauth ? (
        // Avec une sortie — voir `PlayerReauthScreen` (BUREAU-22).
        <PlayerReauthScreen onClose={handleClose} keyboard={!isMini} />
      ) : (
        <>
          {/* Kept mounted even while `error` is showing, so `lastKnownTime`/hls state aren't
              lost and "Réessayer" can resume from where playback actually stopped, instead of
              from the beginning. `key` changes (WebKit renegotiations only) intentionally force
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
          {/* Deux sous-titres (§87) : dessinés par la page, au calque du lecteur natif — voir
              `useServerDualSubtitles`. Un seul : le navigateur, comme avant. */}
          {dualSubtitles.active && !isMini && !error && (
            <SubtitleLayer
              dual
              primary={dualSubtitles.primary}
              second={dualSubtitles.second}
              style={subtitleStyle}
              chromeEdges={chromeEdges}
            />
          )}
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
                  {/* « Lecture impossible : la connexion est trop lente. » (§78) : Réessayer et Quitter seulement —
                      la bascule automatique a déjà été tentée, ou n'est pas permise. */}
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
          {/* Sous l'ouverture, la pastille n'a pas de place : posée à mi-écran, elle tombait sur la
              ligne de chargement (iPhone de Louis, 10/10/2026). L'ouverture dit le même mot, sous sa
              ligne — voir `note` ci-dessous. */}
          {!error && !isMini && !introCovering && (isOffline || reconnecting || (loading && loadingLong) || seekSignal?.hint || compatPrep) && (
            <div
              className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-6"
              style={{ top: "calc(50% + 2.5rem)" }}
            >
              <div className="rounded-full bg-black/80 px-4 py-1.5 text-center text-xs text-white shadow-lg ring-1 ring-white/10">
                {isOffline
                  ? t('player.offline')
                  : seekSignal?.hint
                    ? t("player.slowLink.hint")
                    : compatPrep
                    ? t("player.compatPrep")
                    : loadingLong
                    ? t('player.stillLoading')
                    : hlsJs
                      ? t("player.slowLink.unstable")
                      : t('player.reconnecting')}
              </div>
            </div>
          )}
          {/* Non-interactive by design — a measured signal (recent rebuffers, see badConnection's
              own comment), not a settings toggle with a detail
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
      {/* L'ouverture de la lecture (DECISIONS.md §60), au-dessus de la roue des commandes et sous les
          écrans qui ont quelque chose à dire. Clé par lecture et par épisode : ce lecteur enchaîne
          les épisodes sans être remonté, et chacun a sa propre ouverture. */}
      <ServerPlayerIntro
        key={introKey(session.openId, itemId)}
        session={session}
        allowed={!castSession}
        loading={loading}
        trouble={!!error || needsReauth || castInterrupted || pendingAudioTrack !== null}
        hidden={isMini}
        resumeSeconds={initialResumeAt ?? null}
        videoRef={videoRef}
        onCoverChange={setIntroCovering}
        // L'indice d'une connexion lente (§77) passe avant « toujours en cours » : il dit pourquoi.
        note={
          isOffline
            ? t("player.offline")
            : reconnecting && hlsJs
              ? t("player.slowLink.unstable")
              : loading && linkSignal.hint
              ? t("player.slowLink.hint")
              : compatPrep
              ? t("player.compatPrep")
              : loading && loadingLong
                ? t("player.stillLoading")
                : reconnecting
                  ? t("player.reconnecting")
                  : null
        }
        onClose={handleClose}
      />
      {/* Les messages brefs de la version allégée (§78), en bas à gauche, au-dessus des commandes, retirés
          seuls : la bascule, et une génération de sous-titres qui ne suivra pas. */}
      {/* Jamais sur l'écran d'erreur ni sur celui de la reconnexion : une négociation allégée refusée
          laissait « Passage en vidéo allégée… » posé sur « Quitter · Réessayer », et « Touchez Lecture »
          y désignait un bouton que l'écran venait de cacher (chasse aux défauts du 13/10/2026). */}
      {!isMini && !error && !needsReauth && (switchNotice || subtitleGenNotice || awaitingTap) && (
        <div
          className="subtitle-lift pointer-events-none absolute z-40 flex max-w-[min(80vw,22rem)] flex-col gap-2"
          style={{
            left: "max(1rem, env(safe-area-inset-left))",
            bottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem))",
            transform: chromeEdges?.bottom ? `translateY(-${Math.round(chromeEdges.bottom)}px)` : undefined,
          }}
          role="status"
        >
          {awaitingTap ? (
            <p data-lighter-tap-notice="" className="nav-glass animate-fade-in rounded-2xl px-3 py-2 text-xs leading-snug text-white">
              {t("player.slowLink.tapToResume")}
            </p>
          ) : (
            switchNotice && (
              <p data-lighter-switch-notice="" className="nav-glass animate-fade-in rounded-2xl px-3 py-2 text-xs leading-snug text-white">
                {t("player.slowLink.switched")}
              </p>
            )
          )}
          {subtitleGenNotice && (
            <p data-subtitle-gen-notice="" className="nav-glass animate-fade-in rounded-2xl px-3 py-2 text-xs leading-snug text-white">
              {t("player.slowLink.subtitlesGenerating")}
            </p>
          )}
        </div>
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
          secondSubtitle={{ currentId: secondSubtitleId, onChange: changeSecondSubtitle }}
          hidden={!!error || needsReauth}
          loading={loading}
          openingQuiet={introCovering}
          onChromeEdges={switchNotice || subtitleGenNotice || awaitingTap || dualSubtitles.active ? setChromeEdges : undefined}
          introSkip={introSkip}
          recapSkip={recapSkip}
          creditsStart={creditsStart}
          nextEpisode={nextEpisode}
          onPlayEpisode={scene.active || session.bench ? undefined : handlePlayEpisode}
          onAdvance={handleAdvance}
          /* La sortie de diffusion, et seulement quand cette séance existe pour ça. Elle ne
             dépend d'aucun événement : c'est ce qui la rend sûre là où la détection, elle, ne
             peut pas être éprouvée depuis le serveur. Voir `onCastReturn`. */
          onCastReturn={castSession ? handleCastReturn : undefined}
          castActive={castActive}
          /* Le logo du titre à la place du titre écrit, comme l'hôte natif (d5652ddd) : celui de
             l'ouverture, déjà là. Oublié ici jusqu'au 22/10/2026 — une ouverture sur six montrait le
             titre écrit, et le lecteur changeait d'apparence en passant au serveur. Absent après un
             rechargement WebKit : `PlayerTitle` retombe alors sur le titre écrit. */
          logoUrl={session.introArt?.logoUrl ?? null}
        />
      )}
      {!isMini && (
        <PlaybackInfoPanel
          open={showPlaybackInfo}
          onClose={() => setShowPlaybackInfo(false)}
          data={
            playbackInfo
              ? {
                  ...describeJellyfinPlayback(
                    playbackInfo,
                    networkBitrate,
                    fallbackReason,
                    t,
                    { ...(linkFailure ?? linkLive ?? readLink(null, null)), lighter: lighterStep },
                    {
                      served: {
                        videoCodec: servedCodecs?.video ?? null,
                        audioCodec: servedCodecs?.audio ?? null,
                        videoRange: servedCodecs?.range ?? null,
                        width: decodedSize?.width ?? null,
                        height: decodedSize?.height ?? null,
                      },
                      origin: lighterOrigin,
                    }
                  ),
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
