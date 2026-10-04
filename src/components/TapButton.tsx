"use client";

import type { ReactNode } from "react";
import { useTap } from "@/lib/useTap";

/** Un bouton servi au relâchement du doigt — voir `useTap`. */
export function TapButton({ onTap, className, children }: { onTap: () => void; className?: string; children: ReactNode }) {
  const tap = useTap(onTap);
  return (
    <button type="button" {...tap} className={className}>
      {children}
    </button>
  );
}
