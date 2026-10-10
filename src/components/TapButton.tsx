"use client";

import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useTap } from "@/lib/useTap";

/**
 * Un bouton servi au relâchement du doigt — voir `useTap`.
 *
 * `onPress` : ce qui doit partir dès que le doigt se pose (le préchargement d'une fiche), en plus de
 * l'appui lui-même.
 */
export function TapButton({
  onTap,
  onPress,
  className,
  children,
}: {
  onTap: () => void;
  onPress?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const tap = useTap(onTap);
  return (
    <button
      type="button"
      {...tap}
      onPointerDown={(e: ReactPointerEvent) => {
        onPress?.();
        tap.onPointerDown(e);
      }}
      className={className}
    >
      {children}
    </button>
  );
}
