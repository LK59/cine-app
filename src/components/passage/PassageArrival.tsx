"use client";

import { useEffect, useRef } from "react";
import { usePlaybackMode } from "@/components/PlaybackProvider";
import { passageFlags } from "@/lib/passage/client";
import { writePassageSettings } from "@/lib/passage/settings";
import { keepPassageOffer } from "@/lib/passage/offer";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { isAppleTouchDevice, isInstalledApp } from "@/lib/iosInstall";

/**
 * Ce qu'un passage a emporté, posé sur cet appareil au lancement du cinéma — sur la nouvelle adresse
 * (DECISIONS.md §119).
 *
 * Ici et pas dans la page `/passage` seulement : une application installée sur iPhone n'a pas le
 * stockage de l'onglet où le jeton a été échangé ; c'est en ouvrant le cinéma, quel que soit le
 * chemin qui a ouvert la session (jeton ou code), que l'appareil reçoit ce qui le concerne.
 *
 * - **Les réglages** : une fois par stockage (`cine:passage-applied`, la date de l'arrivée) ;
 *   revalidés par la liste blanche avant d'être écrits. Puis la page se recharge une fois, pour que
 *   chaque réglage soit lu par ses modules (l'interface, le style des sous-titres sont lus au
 *   chargement) — jamais pendant un film : c'est le premier lancement, rien ne joue encore.
 * - **Les téléchargements emportés** (la liste, déjà filtrée par le serveur de ce que le compte ne
 *   voit plus) : gardés sur ce stockage pour l'invitation « Retélécharger » (`PassageDownloadsPrompt`),
 *   puis le serveur les oublie — proposés une seule fois. Sur iPhone/iPad, seulement dans
 *   l'application installée : un onglet de Safari les rangerait dans un stockage qu'on va quitter
 *   (l'aide d'installation est là), et l'application les recevra par sa propre arrivée.
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
        const data = (await res.json()) as { at?: number; settings?: unknown; downloads?: unknown };
        if (cancelled || typeof data.at !== "number") return;
        const account = persistedCacheAccount();
        const installed = isInstalledApp();
        // Les téléchargements d'abord : un rechargement pour les réglages ne doit pas les perdre.
        const takeDownloads = Array.isArray(data.downloads) && !!account && (installed || !isAppleTouchDevice());
        if (takeDownloads) keepPassageOffer(account, data.at, data.downloads);
        const applySettings = !!data.settings && passageFlags.appliedAt() !== String(data.at);
        let written = 0;
        if (applySettings) {
          written = writePassageSettings(window.localStorage, data.settings, account);
          passageFlags.noteApplied(data.at);
        }
        if (!applySettings && !takeDownloads) return;
        await fetch("/api/passage/arrival", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installed, settings: applySettings, downloads: takeDownloads }),
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
