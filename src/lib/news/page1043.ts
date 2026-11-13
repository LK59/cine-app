import type { NewsContentByLang } from "./content";

/**
 * La page « 10.43 » — la fenêtre « Détails » des fiches de films (DECISIONS.md §152, 13/11/2026).
 *
 * **Discrète** (`seedQuietNewsPage`, §73), comme les 10.5, 10.37 et 10.40 : publiée sur toute installation,
 * consultable dans Compte → Nouveautés, sans que la fenêtre s'ouvre pour personne. Pour tous, sans réglage :
 * aucune condition à poser sur le contenu. Pas de corrections propres : elles viennent du registre
 * (`fixesLedger.ts`).
 */
export const NEWS_1043_VERSION = "10.43";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_1043_SEED = "news-seed-10.43-discrete";

export const NEWS_1043_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Fiches",
        entries: [
          {
            icon: "sheets",
            title: "Détails d'un film",
            text: "Sur la fiche d'un film, touchez « i » ou une pastille comme « 4K » : l'image, le débit et la connexion conseillée, chaque piste son et les sous-titres disponibles, en un coup d'œil.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Cette mise à jour ajoute « Détails » aux fiches de films.",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "Title pages",
        entries: [
          {
            icon: "sheets",
            title: "Film details",
            text: "On a film's page, tap “i” or a badge such as “4K”: the picture, the bitrate and the recommended connection, every audio track and the available subtitles, at a glance.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "This update adds “Details” to film pages.",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Fichas",
        entries: [
          {
            icon: "sheets",
            title: "Detalles de una película",
            text: "En la ficha de una película, toque «i» o una etiqueta como «4K»: la imagen, la tasa de bits y la conexión recomendada, cada pista de sonido y los subtítulos disponibles, de un vistazo.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Esta actualización añade «Detalles» a las fichas de películas.",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Titelseiten",
        entries: [
          {
            icon: "sheets",
            title: "Details zu einem Film",
            text: "Tippen Sie auf der Seite eines Films auf „i“ oder ein Abzeichen wie „4K“: Bild, Bitrate und empfohlene Verbindung, jede Tonspur und die verfügbaren Untertitel auf einen Blick.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Dieses Update ergänzt Filmseiten um „Details“.",
    fixes: [],
  },
};
