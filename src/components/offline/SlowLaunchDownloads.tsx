"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { OFFLINE_ENTRY_PATH, rememberedOfflineAccount } from "@/lib/offline/offlineEntry";

/** Combien d'attente avant de proposer les téléchargements — un lancement ordinaire est bien en deçà. */
export const SLOW_LAUNCH_MS = 5000;

/**
 * « Accéder aux téléchargements », sur l'écran de chargement qui dure (bêta, DECISIONS.md §109).
 *
 * Au bout de cinq secondes sans catalogue — le réseau traîne, ou le serveur ne répond plus après
 * avoir servi la page —, un bouton mène à l'entrée hors ligne (`/hors-ligne`), qui ne demande rien au
 * serveur. **Seulement si ce compte a des téléchargements sur l'appareil** (le nombre retenu par le
 * cinéma, `offlineEntry.ts`, lu sans réseau) : pour tous les autres, ce serait un bouton vers une
 * page vide au moment précis où l'on attend autre chose. L'attente continue derrière : rien n'est
 * interrompu tant qu'on ne touche pas le bouton.
 *
 * Monté par l'écran de chargement de la page et par l'attente du catalogue des deux accueils —
 * et, sans attendre (`delayMs={0}`, `placement="inline"`), par l'écran « catalogue indisponible »
 * (`CatalogueUnavailable`) : la page est là mais le serveur ne répond plus, c'est le même besoin.
 */
export function SlowLaunchDownloads({ delayMs = SLOW_LAUNCH_MS, placement = "floating" }: { delayMs?: number; placement?: "floating" | "inline" }) {
  const t = useT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((rememberedOfflineAccount()?.downloads ?? 0) > 0) setShow(true);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  if (!show) return null;
  const go = () => window.location.assign(OFFLINE_ENTRY_PATH);
  if (placement === "inline") {
    return (
      <button type="button" onClick={go} className="btn btn-ghost flex items-center gap-2">
        <Download size={15} aria-hidden />
        {t("player.downloads.accessDownloads")}
      </button>
    );
  }
  return (
    <div
      className="pointer-events-none fixed inset-x-0 flex animate-fade-in justify-center px-4"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 6.5rem)", zIndex: 210 }}
    >
      <button
        type="button"
        onClick={go}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink shadow-lg"
      >
        <Download size={16} aria-hidden />
        {t("player.downloads.accessDownloads")}
      </button>
    </div>
  );
}
