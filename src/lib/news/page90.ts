import type { NewsContentByLang } from "./content";

/**
 * La page « 9.0 » — le téléchargement pour regarder hors ligne (DECISIONS.md §109), préparée à la
 * demande de Louis le 19/10/2026 : présentée comme un tout nouveau système, pour le visionnage sans
 * réseau ou quand la connexion faiblit, avec ses fonctions phares. Semée **en brouillon** : Louis la
 * publie lui-même depuis Activité → Nouveautés, le jour où la fonction est ouverte à tous (la version
 * et le texte s'y retouchent).
 *
 * Ne pas y mentionner les titres masqués (voulu par Louis), ni rien de la fabrication interne.
 */
export const NEWS_90_VERSION = "9.0";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_90_SEED = "news-seed-9.0-telechargements";

export const NEWS_90_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau",
        entries: [
          {
            icon: "sparkles",
            title: "Téléchargements",
            text: "Un tout nouveau système pour regarder vos films et vos séries sans réseau, ou quand la connexion faiblit : en train, en avion, à l'étranger. Touchez « Télécharger » sur une fiche.",
            badge: "bêta",
          },
          {
            icon: "speed",
            title: "Prêt tout de suite",
            text: "Lancez le film pendant qu'il se télécharge : ce qui n'est pas encore sur l'appareil est lu en ligne.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Séries en continu",
            text: "Un épisode, ou toute une saison d'un geste. L'épisode suivant se télécharge tout seul, et celui que vous avez fini s'efface pour laisser la place.",
            badge: "",
          },
          {
            icon: "audio",
            title: "À votre façon",
            text: "Choisissez la langue et la qualité, Standard ou Haute, avec la place que ça prendra.",
            badge: "",
          },
          {
            icon: "subtitles",
            title: "Tout part avec le film",
            text: "Sous-titres, aperçus de la barre de lecture, affiche et fiche complète : tout reste là sans réseau.",
            badge: "",
          },
          {
            icon: "next",
            title: "Reprise partagée",
            text: "Reprenez à la seconde près, en ligne comme hors ligne.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Vos téléchargements",
            text: "Une page à elle, depuis l'accueil : vos titres, la place utilisée, pause et suppression. Sans réseau, l'app vous y conduit directement.",
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
        title: "New",
        entries: [
          {
            icon: "sparkles",
            title: "Downloads",
            text: "A brand-new way to watch your films and series with no network, or when the connection gets weak: on a train, on a plane, abroad. Tap “Download” on a title page.",
            badge: "beta",
          },
          {
            icon: "speed",
            title: "Ready right away",
            text: "Start the film while it downloads: whatever isn't on your device yet plays online.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Series without breaks",
            text: "One episode, or a whole season in one go. The next episode downloads on its own, and the one you finished is removed to free up space.",
            badge: "",
          },
          {
            icon: "audio",
            title: "Your way",
            text: "Choose the language and the quality, Standard or High, and see how much space it will take.",
            badge: "",
          },
          {
            icon: "subtitles",
            title: "Everything comes along",
            text: "Subtitles, seek-bar previews, poster and the full title page all stay available offline.",
            badge: "",
          },
          {
            icon: "next",
            title: "Shared resume",
            text: "Pick up to the second, online or offline.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Your downloads",
            text: "A page of its own, from the home screen: your titles, the space used, pause and delete. With no network, the app takes you straight there.",
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
        title: "Novedades",
        entries: [
          {
            icon: "sparkles",
            title: "Descargas",
            text: "Un sistema totalmente nuevo para ver tus películas y series sin red, o cuando la conexión flojea: en el tren, en el avión, en el extranjero. Toca «Descargar» en una ficha.",
            badge: "beta",
          },
          {
            icon: "speed",
            title: "Listo al instante",
            text: "Empieza la película mientras se descarga: lo que aún no está en el dispositivo se reproduce en línea.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Series sin pausa",
            text: "Un episodio, o toda una temporada de una vez. El siguiente episodio se descarga solo, y el que terminaste se borra para dejar espacio.",
            badge: "",
          },
          {
            icon: "audio",
            title: "A tu manera",
            text: "Elige el idioma y la calidad, Estándar o Alta, y mira cuánto espacio ocupará.",
            badge: "",
          },
          {
            icon: "subtitles",
            title: "Todo viaja con la película",
            text: "Subtítulos, vistas previas de la barra, póster y la ficha completa siguen disponibles sin red.",
            badge: "",
          },
          {
            icon: "next",
            title: "Reanudación compartida",
            text: "Retoma al segundo, en línea o sin conexión.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Tus descargas",
            text: "Una página propia, desde el inicio: tus títulos, el espacio usado, pausa y borrado. Sin red, la app te lleva directamente allí.",
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
        title: "Neu",
        entries: [
          {
            icon: "sparkles",
            title: "Downloads",
            text: "Ein völlig neues System, um Ihre Filme und Serien ohne Netz anzusehen oder wenn die Verbindung schwächelt: im Zug, im Flugzeug, im Ausland. Tippen Sie auf einer Titelseite auf „Herunterladen“.",
            badge: "Beta",
          },
          {
            icon: "speed",
            title: "Sofort bereit",
            text: "Starten Sie den Film schon während des Downloads: Was noch nicht auf dem Gerät ist, wird online abgespielt.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Serien ohne Pause",
            text: "Eine Folge oder eine ganze Staffel auf einmal. Die nächste Folge lädt von selbst, und die fertig geschaute wird gelöscht, um Platz zu schaffen.",
            badge: "",
          },
          {
            icon: "audio",
            title: "Ganz nach Wunsch",
            text: "Wählen Sie Sprache und Qualität, Standard oder Hoch, und sehen Sie, wie viel Platz es braucht.",
            badge: "",
          },
          {
            icon: "subtitles",
            title: "Alles kommt mit",
            text: "Untertitel, Vorschaubilder der Leiste, Poster und die vollständige Titelseite bleiben ohne Netz verfügbar.",
            badge: "",
          },
          {
            icon: "next",
            title: "Gemeinsames Fortsetzen",
            text: "Machen Sie sekundengenau weiter, online wie offline.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Ihre Downloads",
            text: "Eine eigene Seite, direkt von der Startseite: Ihre Titel, der belegte Platz, Pause und Löschen. Ohne Netz führt Sie die App direkt dorthin.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
};
