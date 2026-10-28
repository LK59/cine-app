"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { useOfflineDownloadsEnabled } from "@/lib/offline/useOfflineEnabled";
import { deviceStoreSupported } from "@/lib/offline/deviceStore";
import { initOfflineDownloads, offlineAccount, useOfflineDownloads } from "@/lib/offline/downloads";
import { keptBooksCount, rememberOfflineAccount, warmOfflineEntry } from "@/lib/offline/offlineEntry";
import { ProgressRing, offlineProgress } from "./OfflineDownloadControl";

/**
 * Le rond des téléchargements hors ligne (bêta, 19/10/2026), à côté de « Tous les films / Toutes les
 * séries » (Louis, pour le dessin) : il ouvre la page des téléchargements (`#telechargements=1`,
 * `PlayerDownloadsPanel`) et montre l'avancement de celui en cours. C'est aussi lui qui relance les
 * téléchargements à l'ouverture de l'accueil — il y est toujours monté —, retient le compte dont
 * l'entrée hors ligne montrera le dossier, et demande au service worker de garder cette entrée pour
 * ce build (`offlineEntry.ts`, DECISIONS.md §109).
 */
export function OfflineDownloadsButton() {
  const t = useT();
  const enabled = useOfflineDownloadsEnabled();
  const [supported] = useState(deviceStoreSupported);
  const downloads = useOfflineDownloads();

  useEffect(() => {
    if (!enabled || !supported) return;
    void initOfflineDownloads();
    // Au retour au premier plan : la boucle a pu être suspendue (iPhone en arrière-plan).
    const onVisible = () => {
      if (document.visibilityState === "visible") void initOfflineDownloads();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, supported]);

  // Le compte et le nombre de ses téléchargements, pour l'entrée hors ligne et le bouton de l'écran
  // de chargement. Seulement une fois la liste lue (`offlineAccount` posé) : avant, la liste vide ne
  // dit rien. Un appareil sans téléchargement retient zéro, et ne garde pas l'entrée.
  const count = downloads.length;
  const account = enabled && supported ? offlineAccount() : null;
  useEffect(() => {
    if (!account) return;
    rememberOfflineAccount(account, count);
    // Les livres gardés comptent aussi (`deviceKeepsDownloads`) : leur section est dans cette même page.
    if (count > 0 || keptBooksCount() > 0) warmOfflineEntry();
  }, [account, count]);

  if (!enabled || !supported) return null;
  const active = downloads.find((d) => d.state === "preparing" || d.state === "downloading");
  const label = t("player.downloads.manager");
  return (
    <button
      type="button"
      onClick={() => cinemaNavigate({ downloads: true })}
      aria-label={label}
      title={label}
      data-liquid
      className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
    >
      {active ? <ProgressRing value={offlineProgress(active)} size={17} /> : <Download size={17} aria-hidden />}
    </button>
  );
}
