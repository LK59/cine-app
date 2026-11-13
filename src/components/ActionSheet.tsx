"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: "default" | "danger" | "accent";
  disabled?: boolean;
  /**
   * Intitulé du groupe auquel cette action appartient.
   *
   * Rendu une seule fois, au-dessus de la première action qui le porte : une feuille qui
   * enchaîne dix entrées de nature différente se lit comme une liste de courses. Les actions
   * sans intitulé restent en tête, sans en-tête au-dessus d'elles.
   */
  section?: string;
  /**
   * Jamais le focus d'arrivée d'une confirmation (`alertdialog`) : le geste lourd qu'on confirme —
   * « Demander », qui lance un téléchargement — ne doit pas partir d'un Entrée de plus (15/10/2026).
   */
  noAutoFocus?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  poster?: string | null;
  actions: SheetAction[];
  /** `alertdialog` pour une confirmation : une question qui attend une réponse, pas un menu. */
  role?: "dialog" | "alertdialog";
  /**
   * Sur grand écran, une petite fenêtre centrée plutôt qu'une feuille posée en bas (15/10/2026,
   * confirmation de « Demander », décision de Louis : feuille d'actions au téléphone, petite fenêtre
   * à l'ordinateur). Au téléphone, rien ne change. Les autres feuilles gardent leur forme.
   */
  centerOnWide?: boolean;
  /**
   * Un contenu entre l'en-tête et les actions — des choix à faire avant de confirmer (la fenêtre de
   * téléchargement hors ligne, 19/10/2026 : piste son et qualité). Absent partout ailleurs.
   */
  children?: ReactNode;
  /**
   * Le nom du dialogue quand la feuille n'a pas d'en-tête écrit (`title`) — la fenêtre « Détails » d'un
   * film (§152, 13/11/2026) dessine le sien, le logo du film, dans `children`.
   */
  ariaLabel?: string;
}

/**
 * Ce qui, sous le doigt, ne tire pas la feuille : ce qu'on touche pour s'en servir. La prise du pointeur
 * par le geste y volerait le `click` (Chrome pour Android le renvoie à qui capture — voir
 * `NOT_THE_HANDLE`), et un glissement commencé sur un choix doit rester un choix.
 */
const NOT_A_GRAB =
  "button, a[href], input, select, textarea, label, summary, [contenteditable='true'], [contenteditable=''], " +
  "[role='button'], [role='radio'], [role='radiogroup'], [role='checkbox'], [role='switch'], [role='slider'], [role='tab'], [role='listbox'], [role='option']";

/**
 * Cet appui commence-t-il un glissement de la feuille ? (13/11/2026)
 *
 * La feuille ne se tirait que par sa poignée — une barre de 20 px —, et par son en-tête écrit quand elle en
 * avait un. Sur la fenêtre « Détails », qui dessine le sien, Louis n'arrivait pas à la descendre. Désormais
 * **toute la feuille** se tire, comme les fiches (`useSwipeToDismiss`), sauf :
 *
 *  - ce qu'on touche pour s'en servir (`NOT_A_GRAB`) ;
 *  - une zone qui défile (`data-sheet-scroll`) **quand elle dépasse** : le doigt y fait défiler, il ne
 *    peut pas dire à l'avance s'il veut le contenu ou la feuille. Celle qui tient tout se tire comme le reste ;
 *  - une fenêtre centrée sur grand écran (`centerOnWide`) : elle n'a pas de poignée, rien n'y glisse.
 */
function startsADrag(target: EventTarget | null, centerOnWide: boolean): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(NOT_A_GRAB)) return false;
  const scroller = target.closest<HTMLElement>("[data-sheet-scroll]");
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return false;
  if (centerOnWide && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches) return false;
  return true;
}

export function ActionSheet({ open, onClose, title: liveTitle, subtitle: liveSubtitle, poster: livePoster, actions, role = "dialog", centerOnWide = false, children, ariaLabel }: Props) {
  /**
   * L'en-tête reste celui de l'ouverture pendant la sortie.
   *
   * Les appelants remettent leur sélection à `null` en refermant, et la feuille reste montée
   * encore 300 ms pour glisser : elle perdait son titre et son affiche en partant, et rétrécissait
   * sous le doigt (23/09/2026). Ajusté pendant le rendu, la forme que le compilateur accepte.
   */
  const [header, setHeader] = useState({ title: liveTitle, subtitle: liveSubtitle, poster: livePoster });
  if (open && (header.title !== liveTitle || header.subtitle !== liveSubtitle || header.poster !== livePoster)) {
    setHeader({ title: liveTitle, subtitle: liveSubtitle, poster: livePoster });
  }
  const { title, subtitle, poster } = header;
  const [mounted, setMounted] = useState(false);
  const [show, setShow] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  /**
   * Une carte neuve à chaque ouverture (13/11/2026) : le geste (`useSwipeToDismiss`) garde son état — le
   * décalage de la carte jetée au doigt — et la feuille reste montée 300 ms pour sa sortie. Rouverte dans ce
   * délai, la même carte restait hors de l'écran : le fond s'affichait, pas elle (le défaut du 23/09/2026,
   * alors corrigé en effaçant le style écrit à la main). Une clé par ouverture remet tout à zéro.
   * Ajustée pendant le rendu, la forme que le compilateur accepte.
   */
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration((g) => g + 1);
  }

  // Deliberately imperative (double-rAF entrance animation + exit-delay unmount) — do not
  // convert to a render-time state adjustment, see the rAF comment below for why the timing
  // must be effect-driven.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      // A single rAF often fires before the browser has painted the initial
      // (hidden) state, so the transition has nothing to animate from and the
      // sheet just snaps open. Two nested rAFs guarantee that paint happened.
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setShow(true));
      });
      return () => cancelAnimationFrame(id);
    } else {
      setShow(false);
      const t = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  /**
   * Le focus entre dans la feuille à son ouverture.
   *
   * Il restait sur ce qui l'avait ouverte, derrière : au clavier, Entrée rouvrait la carte sous le
   * menu et les flèches déplaçaient la grille (23/09/2026). La première action le reçoit ; la
   * feuille est un dialogue, et le dit.
   */
  useEffect(() => {
    if (!show) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    // Une confirmation (`alertdialog`) ne s'ouvre pas sur son geste destructeur (08/10/2026) : le
    // focus tombait sur « Oui, annuler », et Entrée pressée juste après la croix supprimait la
    // demande. Elle s'ouvre sur la première action sans danger — « Non, garder ».
    const enabled = "button[data-sheet-action]:not(:disabled)";
    const first =
      (role === "alertdialog" ? sheet?.querySelector<HTMLButtonElement>(`${enabled}:not([data-variant="danger"]):not([data-no-autofocus])`) : null) ??
      sheet?.querySelector<HTMLButtonElement>(enabled);
    first?.focus();
    // Et le focus revient à ce qui l'a ouverte quand elle se ferme : il tombait sur la page, et la
    // flèche suivante repartait du début de l'écran.
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || sheet?.contains(active))) opener.focus({ preventScroll: true });
    };
  }, [show, role]);

  /**
   * Ouverte, la feuille garde ses touches : Échap ne referme qu'elle, et les flèches, Entrée et Retour
   * arrière n'atteignent pas l'écran dessous.
   *
   * Elle écoutait Échap sur `document`, en bulle, sans rien arrêter : posée sur une fiche du bureau
   * (Partager, Télécharger, la gestion d'un téléchargement), Échap refermait la feuille *et* la fiche,
   * une flèche envoyait le focus sur « Lire » derrière elle — Entrée lançait alors le film — et Retour
   * arrière dans le champ « Pour qui » refermait la fiche (audit du 23/10/2026, DECISIONS.md §117).
   * Écoutée en capture sur `window`, comme `CinemaDetailModal` le fait pour ses fenêtres : avant les
   * écouteurs des fiches, posés en bulle. Arrêtées et non annulées : le champ efface toujours, le
   * groupe radio avance toujours, le bouton s'active toujours.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key.startsWith("Arrow") || e.key === "Enter" || e.key === "Backspace") e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-action-sheet
      className={`fixed inset-0 z-60 flex items-end ${centerOnWide ? "sm:items-center sm:justify-center" : ""}`}
      // Pendant sa sortie (refermée, encore montée 300 ms pour glisser), elle ne prend plus rien au doigt
      // ni à la souris (règle 2 des fiches, 13/11/2026) : un second appui sur le fond ou la croix rappelait
      // `onClose`, et ce qui est dessous attendait la fin de l'animation pour répondre.
      style={{ touchAction: "none", pointerEvents: open ? undefined : "none" }}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/70 transition-opacity duration-300 ${show ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />

      {/* Sheet */}
      <SheetCard key={generation} cardRef={sheetRef} show={show} role={role} label={title ?? ariaLabel} centerOnWide={centerOnWide} onDismiss={onClose}>
        {/* La poignée, qui dit qu'on peut tirer. Centrée sur un grand écran (`centerOnWide`), la fenêtre ne se
            tire pas : la poignée n'y a rien à dire (13/11/2026, « Détails » sur ordinateur). */}
        <div className={`flex justify-center pt-3 pb-2 cursor-grab active:cursor-grabbing touch-none select-none ${centerOnWide ? "sm:hidden" : ""}`}>
          <div className="h-1 w-10 rounded-full bg-white/20" />
        </div>

        {/* Card preview header */}
        {(poster || title) && (
          <div
            className="flex items-center gap-3 px-4 pb-3 border-b border-white/10 cursor-grab active:cursor-grabbing touch-none select-none"
          >
            {poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={poster} alt="" className="h-16 w-11 shrink-0 rounded-lg object-cover pointer-events-none" />
            )}
            <div className="min-w-0 pointer-events-none">
              {title && <p className="font-semibold text-white leading-tight truncate">{title}</p>}
              {subtitle && <p className="mt-0.5 text-sm text-muted truncate">{subtitle}</p>}
            </div>
          </div>
        )}

        {children}

        {/* Actions */}
        <div className="py-1.5">
          {actions.map((action, i) => (
            <div key={i}>
            {action.section && action.section !== actions[i - 1]?.section && (
              <p className="px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                {action.section}
              </p>
            )}
            <button
              data-sheet-action
              data-variant={action.variant}
              data-no-autofocus={action.noAutoFocus ? "" : undefined}
              disabled={action.disabled}
              onClick={() => { action.onClick(); onClose(); }}
              className={`flex w-full items-center gap-4 px-5 py-3.5 text-sm font-medium transition-colors active:bg-white/5 disabled:opacity-40 ${
                action.variant === "danger"
                  ? "text-danger"
                  : action.variant === "accent"
                  ? "text-accent-400"
                  : "text-white"
              }`}
            >
              {action.icon && (
                <span className={`w-5 text-center ${
                  action.variant === "danger" ? "text-danger" : "text-muted"
                }`}>
                  {action.icon}
                </span>
              )}
              {action.label}
            </button>
            </div>
          ))}
        </div>

        {/* La carte flotte déjà au-dessus de l'indicateur d'accueil (sa marge du bas) : il ne reste
            qu'un souffle sous la dernière ligne. */}
        <div style={{ height: 6 }} />
      </SheetCard>
    </div>,
    document.body
  );
}

/**
 * La carte, et le glisser vers le bas pour la refermer : **le geste des fiches** (`useSwipeToDismiss`,
 * 13/11/2026), et non plus un geste à part. La carte suit le doigt pixel pour pixel (écrite directement,
 * sans rendu React par mouvement — option `card`), part du point où le geste est reconnu (la tolérance de
 * WebKit retranchée), se referme au-delà d'un peu moins d'un quart de l'écran ou sur un geste vif, et revient
 * sinon. L'ancien geste de la feuille fermait à 80 px fixes, sautait de la tolérance au premier mouvement, et
 * ne se prenait que par la poignée.
 *
 * L'appui est filtré avant d'atteindre le crochet (`startsADrag`) : toute la carte se tire, sauf ce qu'on
 * touche pour s'en servir et un contenu qui défile.
 *
 * Remontée à chaque ouverture (sa `key`, voir `generation`) : l'état du geste ne survit pas à une fermeture.
 */
function SheetCard({
  cardRef,
  show,
  role,
  label,
  centerOnWide,
  onDismiss,
  children,
}: {
  cardRef: RefObject<HTMLDivElement | null>;
  show: boolean;
  role: "dialog" | "alertdialog";
  label: string | undefined;
  centerOnWide: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const swipe = useSwipeToDismiss(onDismiss, { card: cardRef });
  const { onPointerDown, ...follow } = swipe.handlers;
  return (
    <div
      ref={cardRef}
      role={role}
      aria-modal="true"
      aria-label={label}
      onPointerDown={(e) => {
        if (startsADrag(e.target, centerOnWide)) onPointerDown(e);
      }}
      {...follow}
      // Le verre liquide (DECISIONS.md §45), et une carte qui flotte au lieu d'une bande collée au
      // bas : arrondie de partout, à 8 px des bords. Elle arrive avec un léger rebond — le
      // dépassement de la courbe la fait monter un peu au-delà de sa place, puis s'y poser — et
      // repart sans (04/10/2026). Sous le doigt, aucune transition : la carte est où est le doigt ; au
      // relâché, elle revient ou part par la transition de sa classe.
      style={{
        marginBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
        transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
        transition: swipe.dragging ? "none" : undefined,
      }}
      className={`nav-glass relative mx-2 w-[calc(100%-1rem)] max-w-lg overflow-hidden rounded-[28px] transition-transform sm:mx-auto ${
        show ? "translate-y-0 duration-[480ms] ease-[cubic-bezier(0.34,1.32,0.64,1)]" : "translate-y-[110%] duration-300 ease-in"
      }`}
    >
      {children}
    </div>
  );
}
