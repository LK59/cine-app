"use client";

import { useT } from "@/components/TranslationProvider";

/**
 * La pastille d'un onglet : du nouveau à lire (une réponse à un signalement).
 *
 * Dite aussi, et pas seulement montrée : elle était `aria-hidden`, si bien qu'un lecteur d'écran
 * annonçait « Compte » sans rien de plus (relu le 24/09/2026). Le texte masqué complète le nom du
 * bouton qui la porte.
 */
export function NavDot() {
  const t = useT();
  return (
    <>
      <span aria-hidden className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent-500 ring-2 ring-ink" />
      <span className="sr-only">{`, ${t("report.ui.unread")}`}</span>
    </>
  );
}
