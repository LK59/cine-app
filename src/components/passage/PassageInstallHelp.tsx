"use client";

import { useSyncExternalStore } from "react";
import { Share } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { isInstalledApp } from "@/lib/iosInstall";

export type InstallPlatform = "ios" | "android" | "other";

const never = () => () => {};

/** iPhone / iPad (l'iPad qui se dit Mac compris), Android, ou le reste. */
export function installPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && typeof document !== "undefined" && "ontouchend" in document)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/**
 * « Ajoutez Laterna à votre écran d'accueil », dit pour l'appareil qu'on tient (DECISIONS.md §119) —
 * sur la page `/passage` et, juste après l'arrivée, dans la bannière d'installation (`InstallPrompt`).
 * iPhone/iPad : Partager, puis « Sur l'écran d'accueil » ; Android : le menu du navigateur. Ailleurs,
 * les deux. Rien dans l'application déjà installée.
 */
export function PassageInstallHelp({ className = "" }: { className?: string }) {
  const t = useT();
  // Lus après l'hydratation seulement : le serveur ne connaît ni l'appareil ni le mode d'affichage.
  const platform = useSyncExternalStore(never, installPlatform, () => null);
  const installed = useSyncExternalStore(never, isInstalledApp, () => true);
  if (installed || platform === null) return null;
  return (
    <div data-passage-install="" className={`rounded-xl border border-white/10 bg-white/[0.04] p-4 text-left ${className}`}>
      <p className="flex items-center gap-2 text-sm font-semibold text-white">
        <Share size={15} className="shrink-0 text-accent-400" />
        {t("passage.install.title")}
      </p>
      {platform !== "android" && <p className="mt-2 text-[13px] leading-snug text-slate-300">{t("passage.install.ios")}</p>}
      {platform !== "ios" && <p className="mt-2 text-[13px] leading-snug text-slate-300">{t("passage.install.android")}</p>}
      <p className="mt-2 text-[12px] leading-snug text-slate-400">{t("passage.install.then")}</p>
    </div>
  );
}
