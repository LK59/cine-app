"use client";

import { AskTitleControl } from "@/components/ask/AskTitleControl";
import { TitleToggleRound, WATCHED_FACE, WATCHLIST_FACE } from "@/components/cinema/TitleToggles";
import { TitleDetailsRound } from "@/components/cinema/TitleDetails";

/**
 * La rangée de boutons ronds des fiches du bureau, film et série (10.27, 09/11/2026 — DECISIONS.md §117.4
 * et §139) : « Marquer comme vu », « Dans ma liste » et « Poser une question » quittent la liste verticale
 * des actions et deviennent trois boutons ronds, sous les actions principales.
 *
 * Pourquoi : la ligne « Poser une question » ajoutée à la liste avait allongé la colonne, et sur un écran de
 * 13 pouces le logo remontait sous le bouton Retour. La règle du propriétaire : **une seule page par titre,
 * comme une télévision — la fiche ne défile jamais**. Trois lignes de moins y suffisent, avec le logo
 * borné par la hauteur de la fenêtre (`CinemaLogo`, surface `sheet`).
 *
 * Le verre des autres boutons ronds de la fiche (Retour, Partager : `bg-black/55`, `float-edge`) ; l'état
 * « dans ma liste » / « vu » en or, comme la pastille de la ligne qu'ils remplacent (§83, option B) ; un
 * libellé pour les lecteurs d'écran (`aria-label`) et une bulle au survol (`title`, pointeur fin — un
 * appareil tactile ne survole pas) ; depuis le 13/11/2026, « Vu » et « À voir » ont aussi une légende
 * visible sous leur rond (`TitleToggleRound`). Chacun porte `data-detail-menu` : les flèches du clavier et de la
 * télécommande y descendent comme dans le reste du menu.
 *
 * La fiche du téléphone garde sa rangée d'icônes sous libellé (`TitleToggleIcon`) ; la fiche découverte
 * garde ses lignes.
 */

interface ToggleState {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** L'état n'est pas encore lu : estompé (voir `TitleToggleRow`). */
  unknown?: boolean;
}

export function DetailIconActions({
  watched,
  list,
  askItemId,
  onDetails,
}: {
  watched: ToggleState;
  list: ToggleState | null;
  askItemId: string | null | undefined;
  /** La fenêtre « Détails » (§152, 13/11/2026) : la fiche de film seulement — la fiche série ne la passe pas. */
  onDetails?: () => void;
}) {
  return (
    // `items-start` (13/11/2026) : les ronds portent une légende sous eux, de hauteurs qui pourraient
    // différer ; alignés en haut, ils restent sur la même ligne. La question a la sienne depuis le même jour
    // (« Question », `AskTitleControl`).
    // Plus de « Analyser en priorité » ici (13/11/2026, §138) : la liste de priorité se gère depuis la
    // console seulement.
    <div data-detail-icon-actions="" className="mt-1 flex items-start gap-3 px-2">
      <TitleToggleRound face={WATCHED_FACE} {...watched} />
      {list && <TitleToggleRound face={WATCHLIST_FACE} {...list} />}
      <AskTitleControl itemId={askItemId} variant="round" />
      {/* « Infos » (§152) : le dernier rond, après la question — ce qu'on consulte, après ce qu'on fait. */}
      {onDetails && <TitleDetailsRound onOpen={onDetails} />}
    </div>
  );
}
