"use client";

import { useEffect } from "react";
import { installViewportHeal } from "@/lib/viewportHeal";

/** La hauteur de l'application installée remesurée quand iOS la laisse coincée (`viewportHeal.ts`). */
export function ViewportHeal() {
  useEffect(() => installViewportHeal(), []);
  return null;
}
