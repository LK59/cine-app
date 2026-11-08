"use client";

import { useT } from "@/components/TranslationProvider";
import type { CinemaRecap } from "@/app/api/cinema/recaps/route";

/**
 * « Précédemment : … » à la place du résumé d'une série en cours (DECISIONS.md §137), avec la
 * mention de son origine en dessous — choisie par Louis le 08/11/2026 : le texte est écrit par un
 * modèle, il doit le dire. Les deux fiches de série l'affichent ; seule la taille du texte change.
 */
export default function SeriesRecap({ recap, className = "" }: { recap: CinemaRecap; className?: string }) {
  const t = useT();
  return (
    <div className={className} data-series-recap>
      <p className="text-sm leading-6 text-white">
        <span className="font-semibold">{t("cinema.recapTitle")}</span> {recap.text}
      </p>
      <p className="mt-1 text-xs text-muted">{t("cinema.recapNote")}</p>
    </div>
  );
}
