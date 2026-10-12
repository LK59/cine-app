import type { NewsContentByLang } from "./content";

/**
 * La page « 8.48 » — texte validé par Louis le 12/10/2026 (connexion lente §78, séries remontées §75,
 * corrections du 12/10). Publiée par le code au démarrage, comme la page initiale (`seedNewsPages`,
 * db.ts) : un compte qui n'a pas vu la 8.44 voit les deux fusionnées, chacune sous sa version.
 *
 * Ne pas y mentionner les titres masqués (voulu par Louis), ni rien de la fabrication interne.
 */
export const NEWS_848_VERSION = "8.48";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_848_SEED = "news-seed-8.48";

export const NEWS_848_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau",
        entries: [
          {
            icon: "speed",
            title: "Connexion lente",
            text: "Si votre connexion ralentit, CineApp passe de lui-même à une version allégée de la vidéo pour que la lecture continue. Menu ⋮ → Qualité : Automatique ou Originale.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Nouvel épisode",
            text: "Une série remonte dans « Récemment ajoutés » quand un épisode arrive, avec la mention Nouvel épisode ou Nouvelle saison.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Démarrage plus sûr sur les petites connexions.",
    fixes: [
      {
        title: "Lecture",
        items: [
          "Démarrage de la lecture jusqu'à 200 fois moins lourd sur connexion lente pour certains films.",
          "Un message clair quand la connexion est trop lente, au lieu d'un chargement sans fin.",
          "Votre position est gardée lors d'une coupure, et transmise dès le retour de la connexion.",
        ],
      },
      {
        title: "Sous-titres générés",
        items: [
          "Les indications pour malentendants (« [porte qui claque] ») sont maintenant traduites.",
          "Les traductions suivent la langue standard, sans régionalismes.",
          "Les majuscules des sous-titres d'origine sont respectées.",
        ],
      },
      {
        title: "Accueil et fiches",
        items: [
          "Correction d'un bug qui pouvait bloquer l'application en rouvrant la fiche d'un acteur sur iPhone.",
          "La mention « Nouvel épisode » s'affiche aussi dans « Récemment ajoutés ».",
        ],
      },
    ],
  },
  en: {
    sections: [
      {
        title: "New",
        entries: [
          {
            icon: "speed",
            title: "Slow connection",
            text: "If your connection slows down, CineApp switches on its own to a lighter version of the video so playback keeps going. ⋮ menu → Quality: Automatic or Original.",
            badge: "",
          },
          {
            icon: "tv",
            title: "New episode",
            text: "A series moves back up in “Recently added” when an episode arrives, marked New episode or New season.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Safer start on weak connections.",
    fixes: [
      {
        title: "Playback",
        items: [
          "Starting playback is up to 200 times lighter on a slow connection for some films.",
          "A clear message when the connection is too slow, instead of endless loading.",
          "Your position is kept through a dropout, and sent as soon as the connection is back.",
        ],
      },
      {
        title: "Generated subtitles",
        items: [
          "Hearing-impaired cues (“[door slams]”) are now translated.",
          "Translations use the standard language, without regional forms.",
          "Capital letters from the original subtitles are kept.",
        ],
      },
      {
        title: "Home and title pages",
        items: [
          "Fixed a bug that could freeze the app when reopening an actor's page on iPhone.",
          "The “New episode” label now also shows in “Recently added”.",
        ],
      },
    ],
  },
  es: {
    sections: [
      {
        title: "Novedades",
        entries: [
          {
            icon: "speed",
            title: "Conexión lenta",
            text: "Si tu conexión se ralentiza, CineApp cambia por sí solo a una versión aligerada del vídeo para que la reproducción continúe. Menú ⋮ → Calidad: Automática u Original.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Nuevo episodio",
            text: "Una serie vuelve a subir en «Añadidos recientemente» cuando llega un episodio, con la mención Nuevo episodio o Nueva temporada.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Inicio más seguro con conexiones débiles.",
    fixes: [
      {
        title: "Reproducción",
        items: [
          "Iniciar la reproducción es hasta 200 veces más ligero con una conexión lenta en algunas películas.",
          "Un mensaje claro cuando la conexión es demasiado lenta, en lugar de una carga sin fin.",
          "Tu posición se conserva durante un corte y se envía en cuanto vuelve la conexión.",
        ],
      },
      {
        title: "Subtítulos generados",
        items: [
          "Las indicaciones para personas sordas («[portazo]») ahora se traducen.",
          "Las traducciones usan el idioma estándar, sin regionalismos.",
          "Se respetan las mayúsculas de los subtítulos originales.",
        ],
      },
      {
        title: "Inicio y fichas",
        items: [
          "Corregido un error que podía bloquear la aplicación al volver a abrir la ficha de un actor en iPhone.",
          "La mención «Nuevo episodio» también aparece en «Añadidos recientemente».",
        ],
      },
    ],
  },
  de: {
    sections: [
      {
        title: "Neu",
        entries: [
          {
            icon: "speed",
            title: "Langsame Verbindung",
            text: "Wird deine Verbindung langsamer, wechselt CineApp von selbst zu einer leichteren Version des Videos, damit die Wiedergabe weiterläuft. Menü ⋮ → Qualität: Automatisch oder Original.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Neue Folge",
            text: "Eine Serie rückt in „Zuletzt hinzugefügt“ wieder nach oben, wenn eine Folge dazukommt – mit dem Hinweis Neue Folge oder Neue Staffel.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Sichererer Start bei schwacher Verbindung.",
    fixes: [
      {
        title: "Wiedergabe",
        items: [
          "Der Start der Wiedergabe ist bei langsamer Verbindung für manche Filme bis zu 200-mal leichter.",
          "Eine klare Meldung, wenn die Verbindung zu langsam ist, statt endlosem Laden.",
          "Deine Position bleibt bei einem Abbruch erhalten und wird gesendet, sobald die Verbindung zurück ist.",
        ],
      },
      {
        title: "Generierte Untertitel",
        items: [
          "Hinweise für Hörgeschädigte („[Tür knallt]“) werden jetzt übersetzt.",
          "Übersetzungen folgen der Standardsprache, ohne regionale Formen.",
          "Die Großschreibung der Original-Untertitel bleibt erhalten.",
        ],
      },
      {
        title: "Start und Titelseiten",
        items: [
          "Fehler behoben, der die App beim erneuten Öffnen der Seite eines Schauspielers auf dem iPhone blockieren konnte.",
          "Der Hinweis „Neue Folge“ erscheint jetzt auch in „Zuletzt hinzugefügt“.",
        ],
      },
    ],
  },
};
