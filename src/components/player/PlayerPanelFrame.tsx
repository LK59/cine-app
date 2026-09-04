"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cinemaClose } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";

/**
 * L'habillage commun des écrans ouverts depuis le rail — Recherche, Ma liste, Compte.
 *
 * Trois choses qu'ils partagent et qu'il vaut mieux n'écrire qu'une fois : le portage dans
 * document.body (même raison que l'écran cinéma : `fixed` n'est fixe que si aucun ancêtre ne
 * porte de `transform`), le décalage du rail, et la fermeture — Échap, la croix, et le retour du
 * navigateur, qui doivent toutes les trois faire exactement la même chose.
 *
 * Le panneau se glisse *entre* l'écran cinéma (z-45) et le rail (z-50) : la grille disparaît
 * derrière, mais la navigation reste utilisable, donc on passe d'un écran à l'autre sans jamais
 * devoir fermer celui où l'on est.
 */
export function PlayerPanelFrame({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // capture + stopPropagation : l'écran cinéma écoute Échap lui aussi, et sans ça une seule
      // touche fermerait le panneau *et* la fiche ouverte derrière.
      e.stopPropagation();
      cinemaClose({ search: false, list: false, account: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-ink animate-fade-in"
      style={{ zIndex: 48, paddingLeft: "var(--player-rail, 0px)" }}
    >
      <header
        className="flex shrink-0 items-start justify-between gap-4 px-5 pb-4 sm:px-10"
        style={{ paddingTop: "calc(1.5rem + env(safe-area-inset-top))" }}
      >
        <div className="min-w-0">
          <h1 className="truncate font-display text-2xl font-semibold text-white sm:text-3xl">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-slate-400">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={() => cinemaClose({ search: false, list: false, account: false })}
            aria-label={t("common.close")}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      <div ref={bodyRef} className="scrollbar-thin flex-1 overflow-y-auto overscroll-contain px-5 pb-16 sm:px-10">
        {children}
      </div>
    </div>,
    document.body
  );
}
