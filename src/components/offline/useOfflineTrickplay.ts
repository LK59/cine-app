"use client";

import { useEffect, useState } from "react";
import { offlineAccount, type OfflineDownload } from "@/lib/offline/downloads";
import { readOfflineTrickplayUrls } from "@/lib/offline/trickplay";
import type { TrickplayInfo } from "@/lib/trickplayTile";

/**
 * Les aperçus de la barre du lecteur hors ligne, lus sur l'appareil (`trickplay.ts`) : une adresse
 * `blob:` par planche, libérées à la fermeture. `null` tant qu'ils ne sont pas lus, ou s'il n'y en a
 * pas — la barre demande alors ceux du serveur, comme avant.
 */
export function useOfflineTrickplay(download: OfflineDownload | null): { info: TrickplayInfo; urls: string[] } | null {
  const [loaded, setLoaded] = useState<{ id: string; info: TrickplayInfo; urls: string[] } | null>(null);
  const id = download?.id ?? null;
  const trickplay = download?.trickplay ?? null;
  useEffect(() => {
    const account = offlineAccount();
    if (!id || !trickplay || !account) return;
    let cancelled = false;
    let made: string[] = [];
    void readOfflineTrickplayUrls(account, id, trickplay.tiles).then((urls) => {
      if (!urls) return;
      if (cancelled) {
        for (const url of urls) URL.revokeObjectURL(url);
        return;
      }
      made = urls;
      setLoaded({ id, info: trickplay, urls });
    });
    return () => {
      cancelled = true;
      for (const url of made) URL.revokeObjectURL(url);
    };
    // `trickplay` garde son identité d'une avancée du téléchargement à l'autre (`patch` recopie le champ).
  }, [id, trickplay]);
  return loaded && loaded.id === id ? { info: loaded.info, urls: loaded.urls } : null;
}
