"use client";

import { Download } from "lucide-react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { formatFileSize } from "@/lib/format";
import { useIsMobile } from "@/lib/useIsMobile";

/**
 * « Télécharger le fichier », dernière ligne du ⋮ du lecteur (19/10/2026) : le fichier d'origine, par
 * `/api/player/download/{id}`, que le navigateur télécharge lui-même — sa barre, sa reprise. Rendue
 * par `PlayerControls` pour un compte que Jellyfin autorise, au bureau seulement ; la route le
 * vérifie de son côté. La taille, quand Jellyfin la donne, dit ce qu'on s'apprête à recevoir.
 */
export function PlayerDownloadRow({ itemId, sizeBytes, onStart }: { itemId: string; sizeBytes: number | null; onStart: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  // Au bureau seulement : sur un téléphone ou une tablette tactile, un fichier de plusieurs dizaines de
  // Go n'a pas sa place, et une PWA iOS n'a pas de gestionnaire de téléchargements (Louis, 19/10/2026).
  // Ici et pas dans `PlayerControls` : la question n'est posée que pour un compte autorisé.
  const mobile = useIsMobile();
  if (mobile) return null;
  return (
    <a
      data-download-row=""
      href={`/api/player/download/${itemId}`}
      download
      onClick={onStart}
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-muted hover:bg-white/10"
    >
      <Download size={16} /> {t("player.download.file")}
      {sizeBytes ? ` · ${formatFileSize(sizeBytes, locale)}` : ""}
    </a>
  );
}
