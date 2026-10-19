"use client";

import { useState } from "react";
import { HardDrive, Trash2, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useT } from "@/components/TranslationProvider";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { offlineDownloadCount, removeAccountDownloads } from "@/lib/offline/downloads";
import { hardNavigate, signOut } from "@/lib/signOut";

/**
 * « Se déconnecter », pour les trois boutons qui le proposent (cinéma, gestion, menu du téléphone) :
 * si ce compte a des téléchargements sur cet appareil, la question d'abord — les garder (le compte les
 * retrouve en revenant) ou les effacer (Louis, 20/10/2026 : sur un appareil partagé, ils restaient,
 * invisibles pour le compte suivant, et prenaient de la place). Sans téléchargement, rien ne change.
 */
export function useSignOut(): { logout: () => void; sheet: React.ReactNode } {
  const t = useT();
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const leave = () => void signOut(hardNavigate);
  const logout = () => {
    if (busy) return;
    void offlineDownloadCount(persistedCacheAccount()).then((n) => {
      if (n > 0) setCount(n);
      else leave();
    });
  };
  const sheet = (
    <ActionSheet
      open={count > 0}
      onClose={() => setCount(0)}
      centerOnWide
      title={t("player.downloads.signOutTitle")}
      subtitle={t("player.downloads.signOutText", { n: count })}
      actions={[
        { label: t("player.downloads.signOutKeep"), icon: <HardDrive size={18} />, onClick: leave },
        {
          label: t("player.downloads.signOutDelete"),
          icon: <Trash2 size={18} />,
          variant: "danger",
          onClick: () => {
            setBusy(true);
            void removeAccountDownloads(persistedCacheAccount()).finally(leave);
          },
        },
        { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
      ]}
    />
  );
  return { logout, sheet };
}

