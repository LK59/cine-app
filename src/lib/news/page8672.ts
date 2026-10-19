import type { NewsContentByLang } from "./content";

/**
 * La page « 8.67.2 » — demandée par Louis le 18/10/2026 : la correction de « Plus d'épisodes » au
 * bureau ; complétée en « 8.68 » le 19/10 par la rotation en paysage. Dite directement dans la page (une section, pas la liste repliée derrière « Voir plus »).
 * Publiée par le code au démarrage (`seedNewsPage`, db.ts), donc sur toute installation qui passe à
 * cette image et pour tous les comptes.
 *
 * Ne pas y mentionner les titres masqués (voulu par Louis), ni rien de la fabrication interne.
 */
export const NEWS_8672_VERSION = "8.68";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_8672_SEED = "news-seed-8.67.2";
/**
 * Complétée le 19/10/2026 (Louis) : la rotation en paysage, ajoutée à la même page, publiée de
 * nouveau pour tous (`republishNewsPage`, db.ts). Elle portait alors la version « 8.67.2 ».
 */
export const NEWS_8672_FIRST_VERSION = "8.67.2";
export const NEWS_8672_REPUBLISH = "news-republish-8.68";

export const NEWS_8672_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Corrections",
        entries: [
          {
            icon: "phone",
            title: "Écran en paysage",
            text: "L'app tourne avec l'écran, sur Android comme ailleurs : films et listes s'affichent aussi en paysage.",
            badge: "",
          },
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
        title: "Fixes",
        entries: [
          {
            icon: "phone",
            title: "Landscape",
            text: "The app now turns with the screen, on Android too: films and lists also show in landscape.",
            badge: "",
          },
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
        title: "Correcciones",
        entries: [
          {
            icon: "phone",
            title: "Pantalla horizontal",
            text: "La app gira con la pantalla, también en Android: películas y listas se muestran también en horizontal.",
            badge: "",
          },
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
        title: "Korrekturen",
        entries: [
          {
            icon: "phone",
            title: "Querformat",
            text: "Die App dreht sich mit dem Bildschirm, auch unter Android: Filme und Listen erscheinen auch im Querformat.",
            badge: "",
          },
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
