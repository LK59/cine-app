"use client";

import { useEffect, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

/**
 * L'écran verrouillé (18/11/2026, demandé par le propriétaire) : posé par « Verrouiller l'écran » du menu « ⋯ »,
 * sur un écran tactile seulement. Un voile transparent couvre tout le lecteur et **avale chaque geste** — toucher,
 * double toucher, glissement : ni pause, ni saut, ni « À l'écran », ni commandes. Pour un film regardé au lit, un
 * téléphone confié à un enfant, une poche.
 *
 * Un toucher n'importe où montre, trois secondes, un cadenas en bas ; le toucher le transforme en « Toucher encore
 * pour déverrouiller » (trois secondes encore), et un second toucher déverrouille. Deux touchers voulus au même
 * endroit : presque impossible par mégarde, et plus facile à découvrir qu'un appui long.
 *
 * Ce qu'aucune page ne peut bloquer reste au système : sur iPhone, le trait d'accueil, le centre de contrôle.
 * Rien n'est retenu : le verrou vit avec les commandes (`PlayerControls`), et rien ne part au journal.
 */

export const LOCK_HINT_MS = 3000;

type Phase = "idle" | "shown" | "armed";

export function PlayerLockVeil({ onUnlock }: { onUnlock: () => void }) {
  const t = useT();
  // Montré tout de suite : celui qui vient de verrouiller voit comment on en sort.
  const [phase, setPhase] = useState<Phase>("shown");

  useEffect(() => {
    if (phase === "idle") return;
    const timer = setTimeout(() => setPhase("idle"), LOCK_HINT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Les gestionnaires de la surface des commandes (`PlayerControls` : toucher, glissement, double clic) sont des
  // gestionnaires React posés sur l'ancêtre : arrêter la propagation ici suffit à les faire taire.
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      data-player-lock=""
      data-player-surface-ignore
      className="pointer-events-auto absolute inset-0 z-50 touch-manipulation"
      onPointerDown={swallow}
      onTouchStart={swallow}
      onTouchEnd={swallow}
      onDoubleClick={swallow}
      onClick={(e) => {
        e.stopPropagation();
        if (phase === "idle") setPhase("shown");
      }}
    >
      {phase !== "idle" && (
        <button
          type="button"
          data-player-lock-pill=""
          onClick={(e) => {
            e.stopPropagation();
            if (phase === "armed") onUnlock();
            else setPhase("armed");
          }}
          className="player-pill absolute left-1/2 flex -translate-x-1/2 items-center gap-2 py-2.5 pl-3.5 pr-4 text-sm font-medium text-white"
          style={{ bottom: "max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem))" }}
        >
          {phase === "armed" ? <LockOpen size={16} aria-hidden /> : <Lock size={16} aria-hidden />}
          {phase === "armed" ? t("player.lock.confirm") : t("player.lock.hint")}
        </button>
      )}
    </div>
  );
}
