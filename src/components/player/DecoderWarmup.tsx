"use client";

import { useEffect } from "react";
import { scheduleDecoderWarmup } from "@/lib/webcodecs/decoderWarmup";

/**
 * Rien à l'écran : le préchauffage des décodeurs, au démarrage du cinéma. Un composant plutôt
 * qu'un effet de `PlayerShell` pour pouvoir le charger en `ssr: false` — voir decoderWarmup.ts.
 */
export function DecoderWarmup({ delayMs }: { delayMs: number }) {
  useEffect(() => scheduleDecoderWarmup(delayMs), [delayMs]);
  return null;
}
