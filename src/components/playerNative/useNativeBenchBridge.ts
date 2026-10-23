// Le pont du banc d'essai du lecteur natif (`ExperimentalPlayerHost.tsx`) — voir
// `playerBench/bridge.ts` —, sorti tel quel de l'hôte le 23/10/2026 : mêmes deux effets, appelés à
// la même place.
import { useEffect, useRef, type RefObject } from "react";
import { registerBenchBridge } from "@/lib/playerBench/bridge";
import { traceRecent } from "@/lib/webcodecs/trace";
import type { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { syncFacts } from "@/components/player/nativeHostHelpers";

/** Ce que le banc lit du lecteur, recopié à chaque rendu. */
export type NativeBenchState = {
  seek: (seconds: number) => void;
  changeAudio: (id: number) => void;
  changeSubtitle: (id: number | null) => void;
  ready: boolean;
  path: string | null;
  error: string | null;
  audio: { id: number; label: string }[];
  subtitles: { id: number; label: string }[];
  currentAudio: number | null;
  currentSubtitle: number | null;
  subtitle: string | null;
  fps: number | null;
};

export function useNativeBenchBridge({
  bench,
  itemId,
  videoElRef,
  remuxRef,
  lastVideoElRef,
  live,
}: {
  bench: string | undefined;
  itemId: string;
  videoElRef: RefObject<HTMLVideoElement | null>;
  remuxRef: RefObject<RemuxPlayback | null>;
  lastVideoElRef: RefObject<HTMLVideoElement | null>;
  /** L'état du rendu en cours, lu par l'effet et non pendant le rendu. */
  live: () => NativeBenchState;
}): void {
  const benchStateRef = useRef<NativeBenchState | null>(null);
  useEffect(() => {
    benchStateRef.current = live();
  });
  useEffect(() => {
    if (!bench) return;
    const state = () => benchStateRef.current;
    const media = () => videoElRef.current;
    return registerBenchBridge({
      itemId,
      media,
      path: () => state()?.path ?? null,
      ready: () => state()?.ready ?? false,
      error: () => state()?.error ?? null,
      duration: () => {
        const d = media()?.duration ?? 0;
        return Number.isFinite(d) ? d : 0;
      },
      // Comme les commandes : le signal d'abord, puis l'élément (voir `commitSeek`).
      seek: (seconds) => {
        state()?.seek(seconds);
        const element = media();
        if (element) element.currentTime = seconds;
      },
      audioTracks: () => state()?.audio ?? [],
      currentAudio: () => state()?.currentAudio ?? null,
      changeAudio: (id) => state()?.changeAudio(id),
      subtitleTracks: () => state()?.subtitles ?? [],
      currentSubtitle: () => state()?.currentSubtitle ?? null,
      changeSubtitle: (id) => state()?.changeSubtitle(id),
      subtitleText: () => state()?.subtitle ?? null,
      frames: () => {
        try {
          return videoElRef.current?.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
        } catch {
          return null;
        }
      },
      nominalFps: () => state()?.fps ?? null,
      trace: (ms) => traceRecent(ms).join(" | "),
      facts: () => syncFacts(remuxRef.current, videoElRef.current ?? lastVideoElRef.current),
    });
  }, [bench, itemId, videoElRef, remuxRef, lastVideoElRef]);
}
