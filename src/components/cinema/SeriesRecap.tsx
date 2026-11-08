"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/components/TranslationProvider";
import type { CinemaRecap } from "@/app/api/cinema/recaps/route";
import { sendRecapEvent } from "@/lib/useSeriesRecap";

/**
 * « Précédemment : … » à la place du synopsis d'une série en cours (DECISIONS.md §137), avec son
 * origine en dessous et un lien discret vers le synopsis — puis, de là, un lien pour revenir (Louis,
 * 08/11/2026). Le choix n'est pas retenu : chaque ouverture de la fiche repart sur « Précédemment »
 * (la fiche d'un autre titre est une autre instance, voir « The sheet lifecycle »).
 *
 * Deux origines, deux mentions : le texte écrit par le modèle le dit (« Généré par IA… ») ; le résumé
 * officiel d'un seul épisode, affiché tel quel, dit de quel épisode il vient.
 *
 * Les deux fiches de série — bureau et téléphone — passent par ici, avec leur propre synopsis en enfant.
 * L'usage est mesuré (`sendRecapEvent`) : affiché à l'ouverture, et le passage au synopsis.
 */
export default function SeriesRecap({ recap, series, synopsis, className = "" }: { recap: CinemaRecap; series: string; synopsis: ReactNode; className?: string }) {
  const t = useT();
  const [showSynopsis, setShowSynopsis] = useState(false);
  // Une fois par fiche et par endroit : un texte relu sans changement ne se compte pas deux fois.
  useEffect(() => {
    sendRecapEvent("affiché", recap, series);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- une mesure par endroit (épisode, texte), pas à chaque nouvel objet rendu par SWR
  }, [recap.episode, recap.text, series]);
  // En gras : en texte discret de la même couleur que la mention, rien ne disait qu'on pouvait cliquer (Louis, 08/11/2026).
  const link = "mt-1 block text-left text-xs font-semibold text-white underline-offset-2 hover:underline focus-visible:underline";
  if (showSynopsis) {
    return (
      <div className={className}>
        {synopsis}
        <button type="button" className={link} onClick={() => setShowSynopsis(false)}>
          {t("cinema.recapShowRecap")}
        </button>
      </div>
    );
  }
  return (
    <div className={className} data-series-recap>
      <p className="text-sm leading-6 text-white">
        <span className="font-semibold">{t("cinema.recapTitle")}</span> {recap.text}
      </p>
      <p className="mt-1 text-xs text-muted">
        {recap.source === "officiel" && recap.about ? t("cinema.recapOfficial", { code: recap.about }) : t("cinema.recapNote")}
      </p>
      {/* Sur sa propre ligne : à la suite de la mention, il passait à la ligne derrière un « · » orphelin (iPhone, 08/11/2026). */}
      <button
        type="button"
        className={link}
        onClick={() => {
          setShowSynopsis(true);
          sendRecapEvent("synopsis", recap, series);
        }}
      >
        {t("cinema.recapShowSynopsis")}
      </button>
    </div>
  );
}
