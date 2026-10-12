"use client";

import { useEffect, useRef } from "react";

/**
 * La fenêtre « Votre connexion semble lente » (DECISIONS.md §78) — commune aux deux lecteurs.
 *
 * Petite et **non bloquante** : posée par-dessus l'ouverture ou le film, elle ne prend aucun appui
 * en dehors de ses boutons ; le chargement ou la lecture continue derrière. Le verre et l'arrivée des
 * menus du lecteur (`nav-glass`, `player-menu` : même rayon de 22 px, même animation, aucune teinte).
 *
 * - Aucun bouton n'est sélectionné d'avance : Espace et K continuent de mettre le film en pause, et
 *   rien ne se déclenche par accident — Tab, les flèches de la télécommande (navigation spatiale,
 *   §71) et le doigt y mènent.
 * - Retour (Échap, la touche Retour d'une télécommande) ferme la fenêtre, pas le lecteur : écouté en
 *   capture, avant les commandes, et arrêté là.
 * - En bas, au-dessus des commandes quand elles sont là (`liftPx`, leur hauteur mesurée) : jamais
 *   sous la barre, jamais sur la croix (en haut à droite), qui reste toujours utilisable.
 * - Jamais de chiffres : ils vont au journal et au panneau technique.
 */
export interface SlowLinkPopupAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

/** Les touches qui veulent dire « retour » : clavier, télécommandes Android TV / Fire TV (keyCode 4). */
export function isBackKey(e: { key?: string; keyCode?: number }): boolean {
  return e.key === "Escape" || e.key === "Esc" || e.key === "GoBack" || e.key === "BrowserBack" || e.keyCode === 4;
}

export function SlowLinkPopup({
  text,
  actions,
  onBack,
  liftPx = 0,
}: {
  text: string;
  actions: SlowLinkPopupAction[];
  /** Retour : la fenêtre se ferme (le même geste que son bouton « Fermer »). */
  onBack: () => void;
  /** La hauteur des commandes du bas, quand elles sont affichées. */
  liftPx?: number;
}) {
  const backRef = useRef(onBack);
  useEffect(() => {
    backRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isBackKey(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      backRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  return (
    <div
      className="subtitle-lift pointer-events-none absolute inset-x-0 z-40 flex justify-center px-4"
      style={{
        bottom: "max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem))",
        transform: liftPx > 0 ? `translateY(-${Math.round(liftPx)}px)` : undefined,
      }}
    >
      <div
        role="dialog"
        aria-modal="false"
        aria-label={text}
        data-slow-link-popup=""
        className="nav-glass player-menu pointer-events-auto flex max-w-[min(92vw,28rem)] flex-col items-center gap-3 rounded-[22px] px-5 py-4 text-center text-white"
        style={{ transformOrigin: "bottom center" }}
      >
        <p className="text-sm font-medium leading-snug">{text}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className={`min-h-[40px] rounded-full px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/80 ${
                action.primary ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/15"
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
