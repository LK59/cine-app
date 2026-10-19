"use client";

import { useEffect, useState } from "react";
import { offlineAccount, type OfflineDownload } from "@/lib/offline/downloads";
import { offlineImage, peekOfflineImage } from "@/lib/offline/artwork";

/**
 * Une image gardée avec un téléchargement — affiche, logo, visuel, affiche de série — en adresse
 * `blob:` **partagée** (`offlineImage`) : une par fichier pour toute la séance, libérée quand le
 * téléchargement quitte l'appareil. La carte de la grille et la fiche qu'elle ouvre montrent donc la
 * même adresse — c'est à elle que le trajet de retour de la fiche reconnaît sa carte (`sheetMorph`) —,
 * et une carte remontée (la liste bouge pendant un téléchargement) ne relit rien et ne refait pas son
 * fondu. Déjà lue, l'adresse est là dès le premier rendu.
 */
export function useOfflineImage(d: OfflineDownload | null | undefined, name: string, has: boolean | undefined): string | null {
  const id = d?.id ?? null;
  const key = `${id}/${name}`;
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    const account = offlineAccount();
    if (!id || !has || !account) return;
    let cancelled = false;
    void offlineImage(account, id, name).then((url) => {
      if (!cancelled) setLoaded({ key, url });
    });
    return () => {
      cancelled = true;
    };
  }, [id, name, has, key]);
  if (!id || !has) return null;
  if (loaded?.key === key) return loaded.url;
  const account = offlineAccount();
  return account ? (peekOfflineImage(account, id, name) ?? null) : null;
}
