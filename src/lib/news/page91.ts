import type { NewsContentByLang } from "./content";

/**
 * La page « 9.1 » — la langue du son retenue par série (20/10/2026, règle de Louis), et les
 * corrections des 9.0.1 à 9.0.3. Semée en brouillon : Louis la publie depuis Activité → Nouveautés.
 *
 * Ne pas y mentionner les titres masqués, ni rien de la fabrication interne.
 */
export const NEWS_91_VERSION = "9.1";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_91_SEED = "news-seed-9.1-langue-serie";

export const NEWS_91_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau",
        entries: [
          {
            icon: "audio",
            title: "La langue de chaque série",
            text: "Passez une série dans une autre langue sur deux épisodes, et les suivants s'ouvrent directement dans cette langue. Vos autres séries et vos films gardent votre langue habituelle. Pour changer encore, il suffit de recommencer sur deux épisodes.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Sauts plus rapides et lecture plus sûre sur certains appareils.",
    fixes: [
      {
        title: "Lecture",
        items: [
          "Les sauts dans le film sont un peu plus rapides.",
          "Sur un appareil qui n'arrive pas à décoder une vidéo, la lecture repart dans un format qu'il sait lire au lieu de s'arrêter.",
        ],
      },
      {
        title: "Compte",
        items: [
          "Une espace ajoutée par le clavier après votre identifiant n'empêche plus la connexion.",
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
            icon: "audio",
            title: "A language for each series",
            text: "Switch a series to another language on two episodes, and the next ones open in that language right away. Your other series and your films keep your usual language. To change again, just do it on two episodes.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Faster seeking and safer playback on some devices.",
    fixes: [
      {
        title: "Playback",
        items: [
          "Seeking within a film is a little faster.",
          "On a device that cannot decode a video, playback restarts in a format it can read instead of stopping.",
        ],
      },
      {
        title: "Account",
        items: [
          "A space added by the keyboard after your username no longer prevents signing in.",
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
            icon: "audio",
            title: "Un idioma para cada serie",
            text: "Cambia una serie a otro idioma en dos episodios y los siguientes se abrirán directamente en ese idioma. Tus otras series y tus películas mantienen tu idioma habitual. Para cambiar otra vez, basta con hacerlo en dos episodios.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Saltos más rápidos y reproducción más segura en algunos dispositivos.",
    fixes: [
      {
        title: "Reproducción",
        items: [
          "Los saltos dentro de la película son un poco más rápidos.",
          "En un dispositivo que no logra decodificar un vídeo, la reproducción se reanuda en un formato que sabe leer en lugar de detenerse.",
        ],
      },
      {
        title: "Cuenta",
        items: [
          "Un espacio añadido por el teclado tras tu usuario ya no impide iniciar sesión.",
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
            icon: "audio",
            title: "Eine Sprache für jede Serie",
            text: "Stellen Sie eine Serie in zwei Folgen auf eine andere Sprache um, und die nächsten Folgen starten direkt in dieser Sprache. Ihre anderen Serien und Ihre Filme behalten Ihre gewohnte Sprache. Um erneut zu wechseln, tun Sie es einfach in zwei Folgen.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Schnelleres Springen und zuverlässigere Wiedergabe auf manchen Geräten.",
    fixes: [
      {
        title: "Wiedergabe",
        items: [
          "Das Springen innerhalb eines Films ist etwas schneller.",
          "Auf einem Gerät, das ein Video nicht dekodieren kann, startet die Wiedergabe in einem lesbaren Format neu, statt abzubrechen.",
        ],
      },
      {
        title: "Konto",
        items: [
          "Ein von der Tastatur hinter Ihrem Benutzernamen eingefügtes Leerzeichen verhindert die Anmeldung nicht mehr.",
        ],
      },
    ],
  },
};
