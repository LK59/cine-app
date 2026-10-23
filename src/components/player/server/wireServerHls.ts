import type { Dispatch, RefObject, SetStateAction } from "react";
import type HlsClass from "hls.js";
import type { useT } from "@/components/TranslationProvider";
import { meterXhr, type LinkMeter } from "@/lib/slowLink";
import { simulatorActive, throttledHlsLoader } from "@/lib/linkSimulator";
import { hlsRecoveryPosition, hlsResetItself, livePosition } from "@/lib/hlsRecovery";
import { NETWORK_OUTAGE_GIVE_UP_MS } from "@/lib/networkOutage";
import type { ServerStartup } from "@/lib/serverStartup";
import type { Prewarm } from "@/lib/lighterPrewarm";
import type { SessionTally } from "@/lib/playerSessionTally";
import { positionBucket, retrySignature } from "@/lib/retryLedger";

/**
 * hls.js branché sur l'élément, pour une négociation du lecteur serveur : sa construction, le flux
 * annoncé pour le panneau, les étapes du démarrage (§77), la borne d'une coupure et la récupération
 * des fatales. `startPlayback` l'appelle une fois le module chargé, à la génération qui l'a lancé ;
 * le module lui-même n'est importé que là (`import("hls.js")`), ce fichier n'en prend que le type.
 */
const MAX_NETWORK_RETRIES = 6;
const MAX_MEDIA_RETRIES = 3;

export function wireServerHls({
  Hls,
  video,
  sourceUrl,
  generation,
  playbackGeneration,
  isHalted,
  warmed,
  kicked,
  resumeAt,
  linkMeter,
  linkMeterRef,
  hlsRef,
  setServedCodecs,
  startup,
  outageTimer,
  networkRetryTimer,
  networkRetryCount,
  mediaRetryCount,
  setReconnecting,
  setLoading,
  setError,
  t,
  videoRef,
  setNetworkBitrate,
  hlsDetachedAt,
  lastKnownTime,
  tallyRef,
  escalateToH264Ref,
}: {
  Hls: typeof HlsClass;
  video: HTMLVideoElement;
  sourceUrl: string;
  generation: number;
  playbackGeneration: RefObject<number>;
  /** Le chien de garde a renoncé pendant l'import de hls.js (`haltLoading`). */
  isHalted: () => boolean;
  warmed: Prewarm | null;
  kicked: boolean;
  resumeAt: number | undefined;
  linkMeter: LinkMeter;
  linkMeterRef: RefObject<LinkMeter | null>;
  hlsRef: RefObject<HlsClass | null>;
  setServedCodecs: Dispatch<SetStateAction<{ video: string | null; audio: string | null; range: string | null } | null>>;
  startup: ServerStartup;
  outageTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  networkRetryTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  networkRetryCount: RefObject<number>;
  mediaRetryCount: RefObject<number>;
  setReconnecting: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  t: ReturnType<typeof useT>;
  videoRef: RefObject<HTMLVideoElement | null>;
  setNetworkBitrate: Dispatch<SetStateAction<number | null>>;
  hlsDetachedAt: RefObject<number | null>;
  lastKnownTime: RefObject<number>;
  tallyRef: RefObject<SessionTally>;
  escalateToH264Ref: RefObject<(trigger: string) => boolean>;
}): void {
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
    // Compter ce que le lien livre, pour le chien de garde de `startPlayback` (§77) : des écouteurs de
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
  if (generation !== playbackGeneration.current || isHalted()) {
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
}
