import type { NewsContentByLang } from "./content";

/**
 * La page « 10.59 » — l'heure de fin, les sauts enchaînés et la date du prochain épisode (18/11/2026).
 *
 * **Discrète** (`seedQuietNewsPage`, §73), comme les 10.5, 10.37, 10.40, 10.43 et 10.58 : publiée sur toute installation,
 * consultable dans Compte → Nouveautés, sans que la fenêtre s'ouvre pour personne. Pour tous, sans réglage : rien à
 * filtrer. Pas de corrections propres : elles viennent du registre (`fixesLedger.ts`).
 */
export const NEWS_1059_VERSION = "10.59";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_1059_SEED = "news-seed-10.59-discrete";

export const NEWS_1059_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Lecteur",
        entries: [
          { icon: "speed", title: "L'heure de fin", text: "sous le temps restant : « fin à 23:42 », qui suit la vitesse de lecture.", badge: "" },
          { icon: "next", title: "Des sauts enchaînés", text: "touchez ±10 s autant de fois que vous voulez : les boutons restent, le total s'affiche, et aucun chargement ne clignote pendant que vous tapez.", badge: "" },
        ],
      },
      {
        title: "Fiches",
        entries: [
          { icon: "sheets", title: "Le prochain épisode", text: "sur une série dont vous avez vu tout ce qui est sorti : « Prochain épisode jeudi ».", badge: "" },
        ],
      },
    ],
    fixesSummary: "Cette mise à jour ajoute l'heure de fin, des sauts plus fluides et la date du prochain épisode.",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "Player",
        entries: [
          { icon: "speed", title: "End time", text: "under the time remaining: “ends at 23:42”, following the playback speed.", badge: "" },
          { icon: "next", title: "Chained skips", text: "tap ±10 s as many times as you like: the buttons stay, the total shows, and no loading flickers while you tap.", badge: "" },
        ],
      },
      {
        title: "Title pages",
        entries: [
          { icon: "sheets", title: "Next episode", text: "on a series where you have seen everything released: “Next episode on Thursday”.", badge: "" },
        ],
      },
    ],
    fixesSummary: "This update adds the end time, smoother skips and the date of the next episode.",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Reproductor",
        entries: [
          { icon: "speed", title: "Hora de fin", text: "bajo el tiempo restante: «termina a las 23:42», según la velocidad de reproducción.", badge: "" },
          { icon: "next", title: "Saltos encadenados", text: "toque ±10 s tantas veces como quiera: los botones se quedan, se muestra el total y ninguna carga parpadea mientras toca.", badge: "" },
        ],
      },
      {
        title: "Fichas",
        entries: [
          { icon: "sheets", title: "Próximo episodio", text: "en una serie de la que ha visto todo lo estrenado: «Próximo episodio el jueves».", badge: "" },
        ],
      },
    ],
    fixesSummary: "Esta actualización añade la hora de fin, saltos más fluidos y la fecha del próximo episodio.",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Player",
        entries: [
          { icon: "speed", title: "Endzeit", text: "unter der Restzeit: „endet um 23:42“, passend zur Wiedergabegeschwindigkeit.", badge: "" },
          { icon: "next", title: "Verkettete Sprünge", text: "Tippen Sie so oft auf ±10 s, wie Sie möchten: Die Tasten bleiben, die Summe wird angezeigt, und nichts lädt sichtbar, während Sie tippen.", badge: "" },
        ],
      },
      {
        title: "Titelseiten",
        entries: [
          { icon: "sheets", title: "Nächste Folge", text: "bei einer Serie, von der Sie alles Erschienene gesehen haben: „Nächste Folge am Donnerstag“.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Dieses Update ergänzt die Endzeit, flüssigere Sprünge und das Datum der nächsten Folge.",
    fixes: [],
  },
};
