"use client";

import { useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useT } from "@/components/TranslationProvider";

/** Ce que la confirmation montre du titre — ce que l'écran affiche déjà, rien de plus. */
export interface RequestConfirmTarget {
  type: "movie" | "series";
  title: string;
  year?: number | null;
  poster?: string | null;
}

/**
 * « Demander » se confirme (15/10/2026, décision de Louis, DECISIONS.md §94).
 *
 * Une demande part chez Jellyseerr, s'approuve d'elle-même et lance un téléchargement dans Radarr ou
 * Sonarr. Elle partait au premier appui : un pouce qui remonte la fiche sur téléphone, un double
 * Entrée au clavier — cette nuit-là, « Matchbox – Le film » a été téléchargé ainsi sans que personne
 * ne l'ait voulu (MOBILE-7, BUREAU-8). La question tient dans la feuille d'actions de verre qu'utilise
 * déjà l'annulation (§49) — en bas au téléphone, petite fenêtre centrée à l'ordinateur —, avec le
 * titre, l'année et l'affiche. Le focus d'arrivée va sur « Annuler », jamais sur « Demander ».
 *
 * Une seule fonction pour toutes les fiches qui demandent : la fiche découverte, film comme série,
 * au téléphone comme à l'ordinateur. Une confirmation écrite deux fois finit par différer.
 */
export function useRequestConfirmation(target: RequestConfirmTarget | null, request: () => Promise<void> | void): { ask: () => void; open: boolean; sheet: ReactNode } {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sheet = (
    <ActionSheet
      open={open && target !== null}
      onClose={() => setOpen(false)}
      role="alertdialog"
      centerOnWide
      title={target ? (target.year ? `${target.title} (${target.year})` : target.title) : undefined}
      subtitle={target ? t(target.type === "series" ? "player.discover.confirmRequestSeries" : "player.discover.confirmRequestMovie") : undefined}
      poster={target?.poster ?? null}
      actions={[
        { label: t("player.discover.request"), icon: <Plus size={18} />, noAutoFocus: true, onClick: () => void request() },
        { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
      ]}
    />
  );
  // `open` : la fiche dessous se tait au clavier tant que la question est posée (Échap ferme la
  // question, pas la fiche).
  return { ask: () => setOpen(true), open, sheet };
}
