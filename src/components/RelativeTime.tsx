"use client";

import { useT } from "@/components/TranslationProvider";
import { relativeTime } from "@/lib/format";

/**
 * « il y a 3 min », dans une page rendue d'abord par le serveur.
 *
 * Le texte dépend de l'heure où il est calculé, et il l'est deux fois : sur le serveur, puis dans
 * le navigateur qui reprend la page. Qu'une minute bascule entre les deux, et React signale un
 * écart d'hydratation — l'erreur n°418 remontée par `/gestion` le 21/09/2026, dont la vue
 * d'ensemble est justement rendue côté serveur avec ses données. L'écart est attendu et sans
 * conséquence ; il est déclaré tel, sur ce seul nœud, plutôt que de masquer quoi que ce soit
 * d'autre. Le texte suit au prochain rafraîchissement des données.
 */
export function RelativeTime({ date }: { date: string | number }) {
  const t = useT();
  const iso = typeof date === "number" ? new Date(date).toISOString() : date;
  return <span suppressHydrationWarning>{relativeTime(iso, t)}</span>;
}
