"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Cette page est-elle ouverte par un lien de partage (DECISIONS.md §112) ?
 *
 * Posé une fois, à la racine (`app/layout.tsx`), d'après la session que le serveur vient de vérifier :
 * le lecteur est monté là (`PlayerHostLazy`), hors de l'arbre de la page du lien, et c'est lui qui
 * doit savoir qu'il joue pour un invité — sans attendre `/api/auth/me`. Un rôle lu après coup aurait
 * laissé partir, à l'ouverture d'un film, les demandes qu'il fallait justement ne pas faire (la
 * génération de sous-titres demande ses options dès le montage).
 *
 * Ce n'est pas une sécurité : la porte des liens (`share/gate.ts`) refuse au serveur tout ce qui sort
 * du titre, quoi que montre l'écran. Ce drapeau ne sert qu'à ne pas proposer, ni demander, ce qui sera
 * refusé. **Faux par défaut** : un compte du foyer reçoit exactement la valeur qu'il avait sans
 * fournisseur, et rien de ce qui le lit ne change pour lui.
 */
const ShareModeContext = createContext(false);

export function ShareModeProvider({ shareMode, children }: { shareMode: boolean; children: ReactNode }) {
  return <ShareModeContext.Provider value={shareMode}>{children}</ShareModeContext.Provider>;
}

export function useShareMode(): boolean {
  return useContext(ShareModeContext);
}
