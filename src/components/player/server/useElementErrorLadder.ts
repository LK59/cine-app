import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { useT } from "@/components/TranslationProvider";
import { reportPlayback } from "@/lib/reportPlayback";
import { serverFailureFields, type ServerPlayerContext } from "@/lib/serverPlayerLog";
import { positionBucket, retrySignature } from "@/lib/retryLedger";
import type { SessionTally } from "@/lib/playerSessionTally";
import { playsHlsNatively } from "@/lib/webkitEngine";
import type { ReloadCarry } from "@/lib/serverReload";
import { AUDIO_FALLBACK_RUNGS, isLastAudioRung } from "@/components/player/server/audioLadder";
import { ladderReloadIntent, reloadServerPage } from "@/components/player/server/serverElement";
import type { StartOpts } from "@/components/player/server/startOpts";

// The native <video> "error" event is the ONLY failure signal for the DirectPlay and native
// Safari-HLS paths (both are a plain `video.src = manifestUrl`, no hls.js involved, so none of
// the Hls.Events.ERROR retry/recovery logic above ever applies to them). Nothing was listening
// for it at all — a genuine failure there (e.g. Jellyfin failing to build a remux session for a
// newly requested audio track) left `loading` stuck at `true` forever, an infinite spinner with
// no way out. code 1 (MEDIA_ERR_ABORTED) is excluded: it fires as an expected side effect of
// every deliberate `video.src = ...; video.load()` reassignment in startPlayback itself
// (switching audio/subtitle, retrying) aborting whatever the previous src was doing — not a
// real failure, and treating it as one would surface a false error on every track switch.
//
// Les dépendances restent celles de l'hôte (`videoKey`, titre, rechargement) : les références, les
// setters et `t` reçus sont lus au moment de l'erreur, comme avant.
export function useElementErrorLadder({
  videoRef,
  videoKey,
  itemId,
  title,
  reloadAttempt,
  castActiveRef,
  logContext,
  setReconnecting,
  setLoading,
  setError,
  setCastInterrupted,
  lastPlaybackOpts,
  tallyRef,
  learnedExclusions,
  lastKnownTime,
  nativeErrorRetryCount: nativeErrorRetryCountRef,
  nativeErrorRetryTimer: nativeErrorRetryTimerRef,
  startPlaybackRef,
  escalateToH264Ref,
  reloadCarryNow,
  t,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoKey: number;
  itemId: string;
  title: string;
  reloadAttempt: number | undefined;
  castActiveRef: RefObject<boolean>;
  logContext: RefObject<ServerPlayerContext>;
  setReconnecting: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setCastInterrupted: Dispatch<SetStateAction<boolean>>;
  lastPlaybackOpts: RefObject<StartOpts | undefined>;
  tallyRef: RefObject<SessionTally>;
  learnedExclusions: RefObject<string[]>;
  lastKnownTime: RefObject<number>;
  nativeErrorRetryCount: RefObject<number>;
  nativeErrorRetryTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  startPlaybackRef: RefObject<(opts?: StartOpts) => Promise<void>>;
  escalateToH264Ref: RefObject<(trigger: string) => boolean>;
  reloadCarryNow: () => ReloadCarry;
  t: ReturnType<typeof useT>;
}): void {
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
      if (nativeErrorRetryCountRef.current < AUDIO_FALLBACK_RUNGS.length) {
        const rung = AUDIO_FALLBACK_RUNGS[nativeErrorRetryCountRef.current];
        const lastRung = isLastAudioRung(nativeErrorRetryCountRef.current);
        nativeErrorRetryCountRef.current += 1;
        const attempt = nativeErrorRetryCountRef.current;
        const delay = 1200 * attempt;
        setReconnecting(true);
        if (nativeErrorRetryTimerRef.current) clearTimeout(nativeErrorRetryTimerRef.current);
        nativeErrorRetryTimerRef.current = setTimeout(() => {
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
        const reloaded = reloadServerPage(
          () =>
            ladderReloadIntent({
              itemId,
              title,
              resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt || 0,
              attempt: (reloadAttempt ?? 0) + 1,
              audioStreamIndex: lastPlaybackOpts.current?.audioStreamIndex,
              carry: reloadCarryNow(),
            }),
          video!
        );
        if (reloaded) return;
        // Storage unavailable — fall through to the error UI below.
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
}
