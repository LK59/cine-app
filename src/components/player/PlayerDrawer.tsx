"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, X } from "lucide-react";
import { cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { PLAYER_NAV, MANAGE_ITEM, activePanel, openPanel } from "./playerNav";

/**
 * La même navigation sur téléphone, en tiroir.
 *
 * Le rail n'a pas de sens ici : rien ne survole, et une bande permanente mangerait la largeur
 * d'une affiche sur un écran qui n'en a déjà pas de trop.
 *
 * Le bouton qui l'ouvre n'est pas dans ce fichier mais dans l'en-tête de l'écran cinéma mobile,
 * à la place de la flèche de sortie : un seul bouton en haut à gauche, qui mène à tout, plutôt
 * que deux qui se disputent le coin.
 *
 * Son ouverture passe par l'URL, comme les panneaux — sur Android, le geste de retour doit
 * refermer le tiroir plutôt que quitter l'écran.
 */
export function PlayerDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const route = useCinemaRoute();
  const router = useRouter();
  const t = useT();
  const active = activePanel(route);
  const panelRef = useRef<HTMLDivElement>(null);

  // Échap ferme, et le focus entre dans le tiroir à l'ouverture — sans quoi le lecteur d'écran
  // reste derrière, sur une grille devenue inerte.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  // Ouvrir un panneau referme le tiroir dans la même écriture d'historique — voir `openPanel`.
  // Quitter vers la gestion, en revanche, n'y passe pas : on efface le tiroir de l'entrée
  // courante (`replace`, donc pas de retour à consommer) avant de changer de page.
  function leaveToManagement() {
    cinemaNavigate({ menu: false }, "replace");
    router.push(MANAGE_ITEM.href);
  }

  return (
    /* Monté en permanence plutôt que conditionnel : le tiroir glisse, et un élément qui
       n'existait pas la frame d'avant n'a rien d'où glisser. `pointer-events` le rend inerte
       quand il est fermé, et `visibility` le sort de l'ordre de tabulation. */
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-black/60 transition-opacity duration-300"
        style={{ opacity: open ? 1 : 0 }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open}
        aria-label={t("player.nav.label")}
        data-player-nav
        className="absolute inset-y-0 flex w-72 max-w-[82vw] flex-col bg-ink shadow-2xl"
        style={{
          // Le panneau commence après l'encoche, il ne se contente pas de s'y glisser dessous :
          // couché, la Dynamic Island prend une soixantaine de pixels sur le bord gauche, et le
          // tiroir y perdait son en-tête et le début de ses entrées. Fermé, il reste largement
          // hors écran (soixante moins deux cent quatre-vingt-huit).
          left: "env(safe-area-inset-left, 0px)",
          transform: open ? "none" : "translateX(-100%)",
          visibility: open ? "visible" : "hidden",
          transition: "transform 320ms cubic-bezier(0.22, 1, 0.36, 1), visibility 320ms",
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <span className="flex items-center gap-2.5 font-display text-base font-semibold text-white">
            <Clapperboard size={20} className="text-accent-400" />
            Cine
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("common.close")}
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 active:bg-white/10"
          >
            <X size={19} />
          </button>
        </div>

        {/* Défilant : un téléphone couché n'a que ~400 px de haut, et l'en-tête, quatre entrées
            et le pied de page y tiennent tout juste. Mieux vaut pouvoir descendre que voir la
            dernière entrée coupée. */}
        <div className="scrollbar-thin flex flex-1 flex-col gap-1 overflow-y-auto px-3 pt-3">
          {PLAYER_NAV.map(({ panel, labelKey, icon: Icon }) => {
            const isActive = active === panel;
            return (
              <button
                key={panel}
                type="button"
                // Rouvrir l'écran où l'on est déjà ne fait rien (voir `openPanel`), et le
                // tiroir serait resté ouvert sans réponse : dans ce cas, il se referme.
                onClick={() => (active === panel ? onOpenChange(false) : openPanel(panel, route))}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex h-12 items-center gap-4 rounded-xl pl-4 pr-3 text-left text-[15px] font-medium transition-colors ${
                  isActive
                    ? "bg-white/10 text-white before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent-500"
                    : "text-slate-400 active:bg-white/5"
                }`}
              >
                <Icon size={21} className="shrink-0" />
                {t(labelKey)}
              </button>
            );
          })}
        </div>

        <div className="border-t border-white/10 px-3 py-3">
          <button
            type="button"
            onClick={leaveToManagement}
            className="flex h-10 w-full items-center gap-4 rounded-xl px-4 text-left text-xs text-slate-500 active:bg-white/5"
          >
            <MANAGE_ITEM.icon size={17} className="shrink-0" />
            {t(MANAGE_ITEM.labelKey)}
          </button>
        </div>
      </div>
    </div>
  );
}
