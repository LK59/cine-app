import type { NewsContentByLang } from "./content";

/**
 * La page « 8.67.2 » — demandée par Louis le 18/10/2026 : la correction de « Plus d'épisodes » au
 * bureau, dite directement dans la page (une section, pas la liste repliée derrière « Voir plus »).
 * Publiée par le code au démarrage (`seedNewsPage`, db.ts), donc sur toute installation qui passe à
 * cette image et pour tous les comptes.
 *
 * Ne pas y mentionner les titres masqués (voulu par Louis), ni rien de la fabrication interne.
 */
export const NEWS_8672_VERSION = "8.67.2";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_8672_SEED = "news-seed-8.67.2";

export const NEWS_8672_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Correction",
        entries: [
          {
            icon: "wrench",
            title: "Plus d'épisodes",
            text: "Sur ordinateur, un épisode choisi depuis le menu « Plus d'épisodes » se lance de nouveau.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "Fix",
        entries: [
          {
            icon: "wrench",
            title: "More episodes",
            text: "On a computer, an episode picked from the “More episodes” menu plays again.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Corrección",
        entries: [
          {
            icon: "wrench",
            title: "Más episodios",
            text: "En el ordenador, un episodio elegido desde el menú «Más episodios» vuelve a reproducirse.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Korrektur",
        entries: [
          {
            icon: "wrench",
            title: "Weitere Folgen",
            text: "Am Computer startet eine im Menü „Weitere Folgen“ gewählte Folge wieder.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
};
