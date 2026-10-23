"use client";

import type { ComponentType } from "react";
import { BookmarkCheck, Check, CircleCheck, Plus } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { ToggleGlyph } from "@/components/ToggleGlyph";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, MENU_BADGE_ACTIVE } from "@/components/cinema/detailMenu";

/**
 * « À voir » et « Vu » : une forme, pour toutes les fiches de titre (DECISIONS.md §117.4).
 *
 * La fiche de bibliothèque disait « À voir » / « Dans ma liste » avec un plus et un marque-page coché,
 * « Vu » / « Vu » avec une coche et un cercle coché ; la fiche TMDB « Ajouter à ma liste » / « Dans ma
 * liste » avec un marque-page, « Marquer comme vu » / « Vu » avec un œil barré et un œil. Dans une
 * rangée de saga ou une filmographie, un titre possédé ouvre l'une et un titre absent l'autre, sans
 * que rien dans le geste dise laquelle : les deux mêmes gestes changeaient de mots, d'icônes et de
 * place (audit du 23/10/2026). Et le bouton « Vu » éteint disait « Vu », comme allumé.
 *
 * Le libellé dit l'état pour « À voir » (« À voir » ne distinguait pas un titre enregistré d'un autre :
 * « Dans ma liste » le fait), et le geste pour « Vu » éteint (« Marquer comme vu ») — deux mots
 * différents pour deux états. L'icône change de forme et de couleur.
 *
 * Trois dessins, un par mise en page — la ligne du menu du bureau, l'icône sous libellé du téléphone,
 * le bouton pleine largeur de la fiche TMDB au téléphone — et un seul jeu de mots et d'icônes.
 */
export interface ToggleFace {
  offLabel: string;
  onLabel: string;
  OffIcon: ComponentType<{ size?: number; className?: string }>;
  OnIcon: ComponentType<{ size?: number; className?: string }>;
}

export const WATCHLIST_FACE: ToggleFace = { offLabel: "watchlist.statuses.toWatch", onLabel: "cinema.inMyList", OffIcon: Plus, OnIcon: BookmarkCheck };
export const WATCHED_FACE: ToggleFace = { offLabel: "cinema.markWatched", onLabel: "cinema.watchedState", OffIcon: Check, OnIcon: CircleCheck };

interface ToggleProps {
  face: ToggleFace;
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  /**
   * L'état n'est pas encore lu : estompé. Ce bouton écrit, et proposer d'écrire une valeur qu'on n'a
   * pas lue est la façon la plus sûre de la changer par erreur. Absent : le bouton n'a pas d'état à
   * attendre (« À voir »).
   */
  unknown?: boolean;
}

/** La ligne du menu des fiches du bureau : l'état tient dans la pastille, pas dans la ligne entière. */
export function TitleToggleRow({ face, on, onClick, disabled, unknown }: ToggleProps) {
  const t = useT();
  const { OnIcon, OffIcon } = face;
  return (
    <button
      data-detail-menu
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={unknown === undefined ? `${MENU_ROW} ${MENU_ROW_INACTIVE}` : `${MENU_ROW} ${MENU_ROW_INACTIVE} ${unknown ? "opacity-50" : ""}`}
    >
      <span className={on ? MENU_BADGE_ACTIVE : MENU_BADGE}>
        <ToggleGlyph on={on} onIcon={<OnIcon size={16} />} offIcon={<OffIcon size={14} />} />
      </span>
      <span className="text-sm font-medium">{on ? t(face.onLabel) : t(face.offLabel)}</span>
    </button>
  );
}

/** L'icône sous son libellé, dans la rangée d'actions de la fiche du téléphone. */
export function TitleToggleIcon({ face, on, onClick, disabled, unknown }: ToggleProps) {
  const t = useT();
  const { OnIcon, OffIcon } = face;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      data-liquid-pan="icon"
      className={unknown === undefined ? "flex w-16 flex-col items-center gap-1.5" : `flex w-16 flex-col items-center gap-1.5 ${unknown ? "opacity-40" : ""}`}
    >
      <ToggleGlyph on={on} onIcon={<OnIcon size={22} className="text-brand" />} offIcon={<OffIcon size={22} className="text-white" />} />
      <span className="text-center text-xs leading-tight text-muted">{on ? t(face.onLabel) : t(face.offLabel)}</span>
    </button>
  );
}

/** Le bouton pleine largeur de la fiche TMDB au téléphone, sous « Demander ». */
export function TitleToggleWide({ face, on, onClick, disabled }: Omit<ToggleProps, "unknown">) {
  const t = useT();
  const { OnIcon, OffIcon } = face;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={on}
      className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white transition-transform active:scale-95 disabled:opacity-60"
    >
      <ToggleGlyph on={on} onIcon={<OnIcon size={16} className="text-brand" />} offIcon={<OffIcon size={16} />} />
      {on ? t(face.onLabel) : t(face.offLabel)}
    </button>
  );
}
