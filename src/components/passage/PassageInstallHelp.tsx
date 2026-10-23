"use client";

import { useSyncExternalStore } from "react";
import { Share } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { isAppleTouchDevice, isInstalledApp } from "@/lib/iosInstall";
import { useOldAddress } from "@/lib/passage/useOldAddress";

export type InstallPlatform = "ios" | "android" | "other";

const never = () => () => {};

/** iPhone / iPad (l'iPad qui se dit Mac compris, `isAppleTouchDevice`), Android, ou le reste. */
export function installPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "other";
  if (isAppleTouchDevice()) return "ios";
  if (/Android/i.test(navigator.userAgent)) return "android";
  return "other";
}

/**
 * Les trois gestes qui finissent un passage d'adresse (DECISIONS.md §119), numérotés, dits pour
 * l'appareil qu'on tient : 1) ajouter Laterna à l'écran d'accueil — sur iPhone/iPad, depuis Safari :
 * « Passer » ouvre la nouvelle adresse dans la vue intégrée de l'ancienne application, d'où il faut
 * d'abord « Ouvrir dans Safari » (la boussole) ; sur Android, le menu du navigateur ; ailleurs, les
 * deux ; 2) ouvrir la nouvelle icône, et coller le code de passage si elle demande de se connecter ;
 * 3) supprimer l'ancienne icône. Sur iPhone/iPad, une ligne de plus : les notifications viendront
 * dans l'application installée — ici, rien ne les propose (`canOfferPush`, §17).
 *
 * Une seule écriture pour la page `/passage` et pour la bannière de l'arrivée (`InstallPrompt`).
 */
export function PassageInstallSteps({ platform, size = "page" }: { platform: InstallPlatform; size?: "page" | "banner" }) {
  const t = useT();
  const text = size === "page" ? "text-[13px]" : "text-[12.5px]";
  return (
    <>
      <ol className={`mt-2 list-decimal space-y-1.5 pl-5 ${text} leading-snug text-slate-200 marker:font-semibold marker:text-accent-400`}>
        <li>
          {platform !== "android" && <span className="block">{t("passage.install.iosAdd")}</span>}
          {platform !== "ios" && <span className={`block ${platform === "other" ? "mt-1" : ""}`}>{t("passage.install.androidAdd")}</span>}
        </li>
        <li>{t("passage.install.open")}</li>
        <li>{t("passage.install.removeOld")}</li>
      </ol>
      {platform === "ios" && <p className="mt-2 text-[12px] leading-snug text-slate-400">{t("passage.install.notifications")}</p>}
    </>
  );
}

/**
 * « Ajoutez Laterna à votre écran d'accueil » sur la page `/passage`. Rien dans l'application déjà
 * installée, ni sur l'ancienne adresse.
 */
export function PassageInstallHelp({ className = "" }: { className?: string }) {
  const t = useT();
  // Lus après l'hydratation seulement : le serveur ne connaît ni l'appareil ni le mode d'affichage.
  const platform = useSyncExternalStore(never, installPlatform, () => null);
  const installed = useSyncExternalStore(never, isInstalledApp, () => true);
  // Ni sur l'ancienne adresse (§119) : on y installerait ce qu'on quitte.
  const { old } = useOldAddress();
  if (installed || platform === null || old !== false) return null;
  return (
    <div data-passage-install="" className={`rounded-xl border border-white/10 bg-white/[0.04] p-4 text-left ${className}`}>
      <p className="flex items-center gap-2 text-sm font-semibold text-white">
        <Share size={15} className="shrink-0 text-accent-400" />
        {t("passage.install.title")}
      </p>
      <PassageInstallSteps platform={platform} />
    </div>
  );
}
