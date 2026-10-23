import type { ServerStartCause } from "@/lib/serverPlayerLog";

/** Ce que reçoit `startPlayback` — et ce que rejoue une relance. */
export interface StartOpts {
  audioStreamIndex?: number;
  resumeAt?: number;
  disableAudioCodecs?: string[];
  forceAudioTranscode?: boolean;
  /** Le recours de l'image (`H264_RUNG`, audioLadder.ts) : H.264 seul, ré-encodé par Jellyfin. Gardé par les relances. */
  videoH264Only?: boolean;
  /** Pourquoi cette négociation — le `why` de la ligne `start` (`ServerStartWhy`). */
  cause?: ServerStartCause;
}
