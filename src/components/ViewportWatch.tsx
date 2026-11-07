"use client";

import { useEffect } from "react";
import { installViewportWatch } from "@/lib/viewportWatch";
import { installReturnDiag } from "@/lib/returnDiag";

/**
 * Le relevé de la hauteur que iOS laisse coincée dans l'application installée (`viewportWatch.ts`), et
 * celui de ce que coûte un retour au premier plan sur iPhone et iPad (`returnDiag.ts`).
 */
export function ViewportWatch() {
  useEffect(() => installViewportWatch(), []);
  useEffect(() => installReturnDiag(), []);
  return null;
}
