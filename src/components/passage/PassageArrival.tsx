"use client";

import { useEffect, useRef } from "react";
import { usePlaybackMode } from "@/components/PlaybackProvider";
import { passageFlags } from "@/lib/passage/client";
import { writePassageSettings } from "@/lib/passage/settings";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { isInstalledApp } from "@/lib/iosInstall";

/**
 * Les réglages qu'un passage a emportés, posés sur cet appareil au lancement du cinéma — sur la
 * nouvelle adresse (DECISIONS.md §119).
 *
 * Ici et pas dans la page `/passage` seulement : une application installée sur iPhone n'a pas le
 * stockage de l'onglet où le jeton a été échangé ; c'est en ouvrant le cinéma, quel que soit le
 * chemin qui a ouvert la session (jeton ou code), que l'appareil reçoit ses réglages. Une fois par
 * stockage (`cine:passage-applied`, la date de l'arrivée) ; revalidés par la liste blanche avant
 * d'être écrits. Puis la page se recharge une fois, pour que chaque réglage soit lu par ses modules
 * (l'interface, le style des sous-titres sont lus au chargement) — jamais pendant un film : c'est le
 * premier lancement, rien ne joue encore.
 */
export function PassageArrival() {
  const mode = usePlaybackMode();
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/passage/arrival", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { at?: number; settings?: unknown };
        if (cancelled || typeof data.at !== "number" || !data.settings) return;
        if (passageFlags.appliedAt() === String(data.at)) return;
        const written = writePassageSettings(window.localStorage, data.settings, persistedCacheAccount());
        passageFlags.noteApplied(data.at);
        await fetch("/api/passage/arrival", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installed: isInstalledApp() }),
        }).catch(() => undefined);
        // Un film lancé entre-temps : pas de rechargement, les réglages valent au lancement suivant.
        if (written > 0 && !cancelled && modeRef.current === "closed") window.location.reload();
      } catch {
        /* sans réglages : l'appareil garde ses valeurs par défaut */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
