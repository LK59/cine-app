"use client";

import { useEffect } from "react";
import { installViewportWatch } from "@/lib/viewportWatch";

/** Le relevé de la hauteur que iOS laisse coincée dans l'application installée (`viewportWatch.ts`). */
export function ViewportWatch() {
  useEffect(() => installViewportWatch(), []);
  return null;
}
