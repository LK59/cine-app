import type { CodecSupport } from "@/lib/codecSupport";
import type { LighterStep } from "@/lib/slowLinkPolicy";
import type { StartOpts } from "@/components/player/server/startOpts";

/**
 * Le corps de la demande `/api/jellyfin/playback/start` du lecteur serveur — champ pour champ, dans
 * l'ordre où la négociation l'écrivait.
 */
export function negotiationBody({
  itemId,
  cap,
  opts,
  codecSupport,
  disableAudioCodecs,
  castSession,
  nativeHls,
  bench,
  scene,
}: {
  itemId: string;
  cap: { maxBitrate: number; step: LighterStep | null };
  opts: StartOpts | undefined;
  codecSupport: CodecSupport;
  disableAudioCodecs: string[];
  castSession: boolean;
  nativeHls: boolean;
  bench: string | undefined;
  scene: boolean;
}) {
  return {
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
    ...(scene ? { scene: true } : {}),
  };
}
