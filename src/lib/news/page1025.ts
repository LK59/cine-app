import type { NewsContentByLang } from "./content";

/**
 * La page « 10.25 » — « Poser une question » (09/11/2026, DECISIONS.md §139) et « À l'écran » (§138, ajouté
 * en 10.26 : la page déjà semée en base n'est pas réécrite — l'entrée s'y ajoute à la main, à la relecture).
 *
 * Semée **en brouillon**, comme la 10.13 : rien ne s'affiche tant que Louis ne l'a pas relue et publiée
 * depuis Activité → Nouveautés (une installation où l'option est coupée la laisse en brouillon). Même
 * manière que la 10.13 : une entrée générique, des phrases sujet-verbe, vouvoiement, ni « IA » ni
 * vocabulaire de fabrication. Pas de corrections : elles vont au registre (`fixesLedger.ts`).
 */
export const NEWS_1025_VERSION = "10.25";
/** Le marqueur dans `migrations_done` : posé une fois, le brouillon n'est plus jamais réécrit. */
export const NEWS_1025_SEED = "news-seed-10.25-draft";

export const NEWS_1025_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Lecture",
        entries: [
          {
            icon: "sparkles",
            title: "Poser une question",
            text: "Film en pause ou depuis la fiche d'un titre, posez une question et obtenez une réponse courte, tirée seulement de ce que vous avez déjà vu, sans rien révéler de la suite.",
            badge: "",
          },
          {
            icon: "tv",
            title: "À l'écran",
            text: "Film en pause, les acteurs présents dans la scène s'affichent au-dessus du titre, avec leur personnage. Touchez l'un d'eux pour demander qui il est.",
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
        title: "Playback",
        entries: [
          {
            icon: "sparkles",
            title: "Ask a question",
            text: "With a film paused or from a title's page, ask a question and get a short answer drawn only from what you have already watched, without giving away what comes next.",
            badge: "",
          },
          {
            icon: "tv",
            title: "On screen",
            text: "With a film paused, the actors in the scene appear above the title, with their character. Tap one to ask who they are.",
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
        title: "Reproducción",
        entries: [
          {
            icon: "sparkles",
            title: "Hacer una pregunta",
            text: "Con la película en pausa o desde la ficha de un título, haga una pregunta y obtenga una respuesta breve basada solo en lo que ya ha visto, sin desvelar lo que viene.",
            badge: "",
          },
          {
            icon: "tv",
            title: "En pantalla",
            text: "Con la película en pausa, los actores de la escena aparecen sobre el título, con su personaje. Toque uno para preguntar quién es.",
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
        title: "Wiedergabe",
        entries: [
          {
            icon: "sparkles",
            title: "Eine Frage stellen",
            text: "Bei angehaltenem Film oder auf der Seite eines Titels stellen Sie eine Frage und erhalten eine kurze Antwort, nur aus dem bereits Gesehenen, ohne etwas vom weiteren Verlauf zu verraten.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Im Bild",
            text: "Bei angehaltenem Film erscheinen die Darsteller der Szene über dem Titel, mit ihrer Rolle. Tippen Sie auf einen, um zu fragen, wer das ist.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
};
