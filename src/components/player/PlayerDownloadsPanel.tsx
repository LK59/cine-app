"use client";

import { useT } from "@/components/TranslationProvider";
import { openLibraryTitle } from "@/lib/cinemaRoute";
import { BetaBadge } from "@/components/offline/OfflineDownloadControl";
import { OfflineDownloadsView } from "@/components/offline/OfflineDownloadsView";
import { PlayerPanelFrame } from "./PlayerPanelFrame";

/**
 * Les téléchargements de l'appareil, plein écran (bêta, DECISIONS.md §109) — `#telechargements=1`,
 * ouvert par le rond à côté de « Tous les films / Toutes les séries ». Il remplace la fenêtre du
 * premier jour (Louis, 19/10/2026) : une page, comme Ma liste, où l'on voit ce qui est là, ce qui
 * arrive, et la place que ça prend.
 *
 * Un écran poussé, pas un onglet (`back`) : Retour ramène à l'accueil d'où l'on vient. Une fiche
 * ouverte d'ici passe par-dessus (plan 47 sur 46) et le retour y ramène — la même pile que Ma liste.
 */
export function PlayerDownloadsPanel({ leaving }: { leaving?: boolean }) {
  const t = useT();
  return (
    <PlayerPanelFrame
      title={t("player.downloads.manager")}
      subtitle={
        <span className="flex items-center gap-2">
          <BetaBadge />
          {t("player.downloads.panelHint")}
        </span>
      }
      back
      leaving={leaving}
      contentWidth="48rem"
    >
      <OfflineDownloadsView onOpenTitle={(target) => openLibraryTitle(target.type, target.id)} />
    </PlayerPanelFrame>
  );
}
