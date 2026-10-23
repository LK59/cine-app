"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Video } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { FadeInImg } from "@/components/FadeInImg";
import { playerHoldsKeyboard } from "@/lib/playerKeyboard";
import { useSheetTransition } from "@/lib/sheetMorph/desktopContinuity";
import type { SheetMorph } from "@/lib/sheetMorph/useSheetMorph";
import { useSheetBehind, useRouteBehind, arrivedByBack } from "@/lib/cinemaRoute";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useIsTouch } from "@/lib/useIsMobile";
import { HORIZONTAL_VEIL, VERTICAL_VEIL, useSheetGrip } from "@/components/cinema/CinemaDetailLayout";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, focusFirstAction } from "@/components/cinema/detailMenu";
import type { sheetLeadFacts } from "@/lib/sheetFacts";
import type { useLateArrival } from "@/components/cinema/CinemaDetailExtras";

/**
 * L'habillage des deux fiches du bureau — film et série (DECISIONS.md §114.8).
 *
 * `CinemaMovieDetail` et `CinemaSeriesDetail` étaient identiques ligne pour ligne sur ~170 lignes : le
 * cycle de vie (arrivée par un retour, fermeture différée, trajet ou continuité §61, poignée au doigt,
 * focus rendu au retour du lecteur), le fond (photo, flou, deux voiles) et le bouton Retour (audit du
 * 23/10/2026). Ce qui les distingue — le menu, la seconde page, les fenêtres, l'écran des épisodes —
 * reste dans chaque fiche. Le fond et le bouton Retour servent aussi à la fiche TMDB, à celle d'un
 * lien de partage et à l'écran des épisodes, chacun avec sa variante déclarée.
 */

export interface DesktopSheetShell {
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * Le spectateur a-t-il lui-même déplacé le focus ? L'effet de focus de la fiche le lit ; ses flèches
   * le disent (`markUserMovedFocus`). Remis à zéro à chaque titre. Deux fonctions stables plutôt que la
   * référence elle-même : une valeur rendue par un crochet ne se modifie pas de l'extérieur.
   */
  userHasMovedFocus: () => boolean;
  markUserMovedFocus: () => void;
  revealed: boolean;
  closing: boolean;
  requestClose: () => void;
  morph: SheetMorph;
  gripStyle: CSSProperties | undefined;
  grip: ReactNode;
  /** Le lecteur, au-dessus, tient le clavier (§7.3) : la fiche se tait. */
  playerOwnsKeyboard: boolean;
}

export function useDesktopSheetShell({
  subjectKey,
  underneath,
  onClose,
}: {
  /** L'identité du titre montré (`radarrId`, `sonarrId`) : un titre similaire rouvre la même fiche. */
  subjectKey: number | string | undefined;
  underneath: boolean;
  onClose: () => void;
}): DesktopSheetShell {
  const containerRef = useRef<HTMLDivElement>(null);
  const userMovedFocus = useRef(false);
  const userHasMovedFocus = useCallback(() => userMovedFocus.current, []);
  const markUserMovedFocus = useCallback(() => {
    userMovedFocus.current = true;
  }, []);

  // Keeps this overlay mounted for one exit animation's worth of time after a close is
  // requested, instead of vanishing the instant onClose fires — see the hook's own doc comment.
  // Every close trigger (Escape/Backspace, the back button, the grip) calls requestClose()
  // instead of onClose directly.
  // Pas d'animation de sortie quand c'est une autre fiche qui attend derrière : la sortie
  // découvrirait l'accueil deux dixièmes de seconde avant que la précédente n'entre par-dessus.
  // Voir `useSheetBehind`.
  // Monté parce qu'on revient dessus, et non parce qu'on l'ouvre : pas d'animation d'entrée. Il
  // n'ouvre rien, il se découvre — voir `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());
  const sheetBehind = useSheetBehind();
  /**
   * Sur un ordinateur, la fiche relaie l'aperçu sans rien déplacer : le fond reste, le logo glisse
   * à sa place, le contenu change (`useDesktopContinuity`). Sur l'iPad, la carte touchée devient le
   * visuel plein écran, et la fiche y retourne (DECISIONS.md §61) — la même décision que la fiche du
   * téléphone et la fiche TMDB. La fermeture rend l'adresse aussitôt :
   * c'est une copie de la fiche qui s'efface pendant que l'image revole vers l'affiche. Sans fiche
   * dessinée derrière (une fiche TMDB, une personne), l'échange se fait d'un coup, comme avant.
   */
  const behindIsDrawn = useRouteBehind() !== null;
  const { closing, requestClose } = useDelayedClose(onClose, 0);
  const morph = useSheetTransition({
    layout: "desktop",
    rootRef: containerRef,
    imageRef: containerRef,
    active: !underneath,
    leaving: closing,
    revealed,
    instantExit: sheetBehind && !behindIsDrawn,
  });

  /**
   * Refermer au doigt : la poignée du haut, écrite une fois pour les deux fiches du bureau.
   * Inerte à la souris, et inerte aussi sous une fiche posée par-dessus — un écran qui s'en va
   * n'a pas d'avis, et celui du dessous non plus.
   */
  const { style: gripStyle, grip } = useSheetGrip(requestClose, useIsTouch() && !underneath);

  // Un titre similaire rouvre la même fiche sur un autre titre : c'est une arrivée, et le drapeau
  // doit repartir de zéro. Sans cela, un spectateur venu d'un titre similaire — donc ayant forcément
  // bougé le focus pour l'atteindre — n'était plus jamais ramené sur la lecture. Déclaré avant
  // l'effet de focus de la fiche : les effets s'exécutent dans leur ordre de déclaration.
  useEffect(() => {
    userMovedFocus.current = false;
  }, [subjectKey]);

  // Stays open underneath the player instead of closing when Lecture starts, so dismissing the
  // player lands you back on the sheet you started from rather than on the browse grid. What
  // originally forced the close was the sheet's own Up/Down handler fighting PlayerControls' for
  // the keyboard — every arrow press ran there too, found the player's focused control wasn't one
  // of ITS [data-detail-menu] buttons, and yanked focus back to Lecture. The handler now stands
  // down while the player is full-screen instead, and takes the keyboard back (and the focus with
  // it) the moment the player is gone.
  const playback = usePlayback();
  const playerOwnsKeyboard = playerHoldsKeyboard(playback);
  const wasPlayerFullScreen = useRef(playerOwnsKeyboard);
  useEffect(() => {
    if (!underneath && wasPlayerFullScreen.current && !playerOwnsKeyboard) {
      focusFirstAction(containerRef.current);
    }
    wasPlayerFullScreen.current = playerOwnsKeyboard;
  }, [playerOwnsKeyboard, underneath]);

  return { containerRef, userHasMovedFocus, markUserMovedFocus, revealed, closing, requestClose, morph, gripStyle, grip, playerOwnsKeyboard };
}

/**
 * La racine d'une fiche du bureau : la couche plein écran, son fond, la poignée et le bouton Retour,
 * puis le contenu de la fiche.
 */
export function DesktopSheetFrame({
  containerRef,
  revealed,
  handlesEntry,
  gripStyle,
  grip,
  onBack,
  underneath,
  backdropUrl,
  children,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  revealed: boolean;
  /** Le trajet ou la continuité mène l'entrée (`useSheetTransition`) : pas de fondu à elle. */
  handlesEntry: boolean;
  gripStyle: CSSProperties | undefined;
  grip: ReactNode;
  onBack: () => void;
  underneath: boolean;
  backdropUrl: string | null | undefined;
  children: ReactNode;
}) {
  return (
    // z-index as inline style, not a Tailwind class — arbitrary-value classes weren't making it
    // into the production CSS bundle (see CinemaClient's own note). Just above CinemaClient's own
    // z-45 browse layer, both still well below PlayerHost's z-80 — pressing Lecture needs the
    // player to end up on TOP of this, not hidden behind it (see CinemaClient's z-index note).
    <div
      ref={containerRef}
      className={`fixed inset-0 overflow-hidden bg-ink ${revealed || handlesEntry ? "" : "animate-fade-in"}`}
      // Le rail du lecteur est posé sur le bord gauche de l'écran, au-dessus de cette fiche :
      // sans ce retrait, la colonne de texte et le bouton Retour passeraient dessous. La variable
      // vaut 0 partout ailleurs, donc rien ne bouge hors du lecteur.
      inert={underneath}
      aria-hidden={underneath || undefined}
      style={{ zIndex: 47, paddingLeft: "var(--player-rail, 0px)", ...gripStyle }}
    >
      <DesktopSheetBackdrop src={backdropUrl} settle />

      {/* Posée avant le bouton Retour, et non après : les deux sont au même rang, et le dernier
          dessiné reçoit les appuis — la poignée traverse toute la largeur, le bouton doit rester
          au-dessus d'elle. Voir `useSheetGrip`. */}
      {grip}

      <SheetBackButton onClick={onBack} />

      {children}
    </div>
  );
}

/**
 * Le fond d'une fiche plein écran du bureau : la photo, un flou localisé sous le menu, deux voiles.
 *
 * `settle` marque le flou pour la continuité du bureau (§61, `data-sheet-settle`) — la fiche d'un lien
 * de partage n'en a pas, elle ne relaie aucun aperçu. `blur` : la fiche TMDB ne floute qu'à partir de
 * `md`, parce qu'au téléphone elle arrive en glissant au milieu d'une cascade acteur → film → acteur, et
 * un flou sur la moitié de l'écran se recalcule à chaque image du mouvement.
 */
export function DesktopSheetBackdrop({
  src,
  settle = false,
  blur = "backdrop-blur-md",
}: {
  src: string | null | undefined;
  settle?: boolean;
  blur?: "backdrop-blur-md" | "md:backdrop-blur-md";
}) {
  return (
    <>
      {src && <FadeInImg src={src} alt="" data-sheet-photo="" className="absolute inset-0 h-full w-full object-cover" />}
      {/* Localized, gradually-eased blur — not a global filter on the image, and not a flat
          rectangle either (a plain backdrop-blur-md div has a hard visible seam where it starts,
          which is what looked broken here). backdrop-blur blurs whatever renders behind THIS div
          (the sharp img above); the mask ramps that blur in from nothing to full over the top
          half of the div instead of switching on all at once, and the whole zone sits low and
          short — only behind the synopsis/menu, not across the middle of the image. */}
      <div
        data-sheet-settle={settle ? "" : undefined}
        className={`absolute inset-x-0 bottom-0 ${blur}`}
        style={{
          height: "45%",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        }}
      />
      {/* Deux voiles à étapes explicites plutôt qu'un dégradé en trois arrêts : voir
          CinemaDetailLayout, où la raison de chaque pourcentage est écrite. */}
      <div data-sheet-veil="" className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
      <div data-sheet-veil="" className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />
    </>
  );
}

/**
 * Le bouton Retour d'un écran plein du bureau.
 *
 * z-10, explicitly above the content column: that column spans the full height (flex items-center,
 * for vertical centering) and — even with a transparent background — would otherwise sit on top of
 * this button in DOM/paint order and silently eat every mouse click aimed at it, leaving only the
 * Escape/Backspace keyboard path working.
 *
 * `absolute` pour la fiche TMDB : au téléphone sa racine s'anime en translation, et un enfant `fixed`
 * s'y positionnerait par rapport à la fenêtre. Un enfant absolu se cale sur la boîte de bordure et
 * ignore le `padding-left` qui réserve le rail : le retrait est écrit dans la position, dans les deux cas.
 */
export function SheetBackButton({ onClick, position = "fixed" }: { onClick: () => void; position?: "fixed" | "absolute" }) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className={`btn btn-ghost ${position} z-10 rounded-full bg-black/55 px-3 py-2 float-edge`}
      style={{ top: "max(1rem, env(safe-area-inset-top))", left: "calc(1rem + var(--player-rail, 0px))" }}
    >
      <ArrowLeft size={16} /> {t("cinema.back")}
    </button>
  );
}

/**
 * La ligne « Bande-annonce » du menu d'une fiche du bureau, et sa place tenue — invisible et hors du
 * clavier — tant que la description n'a pas dit s'il y en a une (§55, `sheetLeadFacts`). Elle se pose
 * en fondu si elle arrive après l'ouverture (`useLateArrival`).
 */
export function DetailTrailerRow({
  lead,
  late,
  onOpen,
}: {
  lead: Pick<ReturnType<typeof sheetLeadFacts>, "trailerKnown" | "trailerKey" | "trailerLate">;
  late: Pick<ReturnType<typeof useLateArrival>, "fade">;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <>
      {!lead.trailerKnown && (
        <div aria-hidden="true" data-sheet-reserved="" className={`${MENU_ROW} ${MENU_ROW_INACTIVE} invisible`}>
          <span className={MENU_BADGE}>
            <Video size={14} />
          </span>
          <span className="text-sm font-medium">{t("cinema.trailer")}</span>
        </div>
      )}
      {lead.trailerKey && (
        <button data-detail-menu onClick={onOpen} className={`${MENU_ROW} ${MENU_ROW_INACTIVE} ${lead.trailerLate ? late.fade : ""}`}>
          <span className={MENU_BADGE}>
            <Video size={14} />
          </span>
          <span className="text-sm font-medium">{t("cinema.trailer")}</span>
        </button>
      )}
    </>
  );
}
