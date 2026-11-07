import type { NewsContentByLang } from "./content";

/**
 * La page « 10.13 » — les animations reprises image par image (06/11/2026).
 *
 * Écrite après une soirée de corrections faites sur des enregistrements d'écran d'iPhone décomposés à
 * 60 images par seconde : fermeture des fiches d'un seul tenant (§61), glissement sans rendu React,
 * fiche saisie pendant son ouverture, premier dessin dans la forme de l'accueil (§133), retour dans
 * l'app après une mise à jour (§134). Semée **en brouillon** : Louis la relit et la publie depuis
 * Activité → Nouveautés. Le 07/11/2026, la recherche par description (§135) y est ajoutée en tête et la
 * page repassée en brouillon à la main (`news_pages`), à la demande de Louis, qui la republie. Consigne de Louis : à la manière des notes de version d'Apple — la page
 * principale reste générique (deux points, des phrases sujet-verbe, sans « nous » ni ton commercial) ;
 * le détail va dans la liste « Optimisations et corrections » (`fixes`), chaque ligne ouverte par un
 * verbe (« Améliore… », « Corrige un problème où… »). Ni vocabulaire de fabrication, ni chiffre non mesuré.
 */
export const NEWS_1013_VERSION = "10.13";
/** Le marqueur dans `migrations_done` : posé une fois, le brouillon n'est plus jamais réécrit. */
export const NEWS_1013_SEED = "news-seed-10.13-draft";
/** Le détail complété des fiches de titres absents de la bibliothèque (10.13.29–10.13.31), avant publication. */
export const NEWS_1013_REFRESH = "news-refresh-10.13-discover";

export const NEWS_1013_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Recherche",
        entries: [
          {
            icon: "search",
            title: "Recherche par description",
            text: "Décrivez un film ou une série en une phrase, comme « le film où un homme revit la même journée », et la recherche le retrouve, qu'il soit dans la bibliothèque ou à demander.",
            badge: "",
          },
        ],
      },
      {
        title: "Animations et performances",
        entries: [
          {
            icon: "sparkles",
            title: "Animations",
            text: "Les animations de l'app ont été retravaillées et restent fluides sur tous les appareils, y compris les plus anciens.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Performances",
            text: "L'app démarre et reprend plus rapidement, et sollicite moins votre appareil.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Cette mise à jour ajoute la recherche par description et améliore la fluidité des animations et les performances de l'app.",
    fixes: [
      {
        title: "Animations",
        items: [
          "Améliore la fluidité des fiches lorsqu'on les tire vers le bas.",
          "Corrige un problème où le texte et les boutons d'une fiche restaient affichés un instant après sa fermeture.",
          "Corrige un problème où l'image d'une fiche restait en haut de l'écran lorsqu'on l'attrapait pendant son ouverture.",
          "Améliore l'ouverture des titres absents de la bibliothèque, désormais animée depuis leur affiche.",
          "Corrige un problème où l'image d'une fiche restait affichée un instant après une fermeture rapide.",
          "Corrige un problème où une fiche marquait un bref arrêt lorsqu'on la lâchait vers le bas.",
        ],
      },
      {
        title: "Performances",
        items: [
          "Améliore l'affichage de l'accueil au lancement.",
          "Accélère le chargement d'une nouvelle version au retour dans l'app.",
          "Accélère l'ouverture des titres absents de la bibliothèque.",
          "Réduit la charge de l'appareil pendant la lecture des films au son Dolby TrueHD.",
        ],
      },
    ],
  },
  en: {
    sections: [
      {
        title: "Search",
        entries: [
          {
            icon: "search",
            title: "Search by description",
            text: "Describe a film or series in a sentence, such as “the film where a man relives the same day”, and search finds it, whether it's in the library or can be requested.",
            badge: "",
          },
        ],
      },
      {
        title: "Animations and performance",
        entries: [
          {
            icon: "sparkles",
            title: "Animations",
            text: "The app's animations have been reworked and stay smooth on every device, including older ones.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Performance",
            text: "The app launches and resumes faster, and puts less load on your device.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "This update adds search by description and improves the smoothness of animations and the app's performance.",
    fixes: [
      {
        title: "Animations",
        items: [
          "Improves the smoothness of sheets when you pull them down.",
          "Fixes an issue where a sheet's text and buttons stayed on screen for a moment after it closed.",
          "Fixes an issue where a sheet's picture stayed at the top of the screen when grabbed while opening.",
          "Improves opening titles that are not in the library, now animated from their poster.",
          "Fixes an issue where a sheet's picture stayed on screen for a moment after a quick close.",
          "Fixes an issue where a sheet paused briefly when released downward.",
        ],
      },
      {
        title: "Performance",
        items: [
          "Improves how the home screen appears at launch.",
          "Speeds up loading a new version when you return to the app.",
          "Speeds up opening titles that are not in the library.",
          "Reduces the load on your device while playing films with Dolby TrueHD sound.",
        ],
      },
    ],
  },
  es: {
    sections: [
      {
        title: "Búsqueda",
        entries: [
          {
            icon: "search",
            title: "Búsqueda por descripción",
            text: "Describa una película o serie en una frase, como «la película en la que un hombre revive el mismo día», y la búsqueda la encuentra, esté en la biblioteca o pueda pedirse.",
            badge: "",
          },
        ],
      },
      {
        title: "Animaciones y rendimiento",
        entries: [
          {
            icon: "sparkles",
            title: "Animaciones",
            text: "Las animaciones de la app se han revisado y siguen fluidas en todos los dispositivos, incluidos los más antiguos.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Rendimiento",
            text: "La app se inicia y se reanuda más rápido, y exige menos a su dispositivo.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Esta actualización añade la búsqueda por descripción y mejora la fluidez de las animaciones y el rendimiento de la app.",
    fixes: [
      {
        title: "Animaciones",
        items: [
          "Mejora la fluidez de las fichas al deslizarlas hacia abajo.",
          "Corrige un problema por el que el texto y los botones de una ficha seguían visibles un instante tras cerrarla.",
          "Corrige un problema por el que la imagen de una ficha se quedaba arriba al agarrarla mientras se abría.",
          "Mejora la apertura de los títulos que no están en la biblioteca, ahora animada desde su póster.",
          "Corrige un problema por el que la imagen de una ficha seguía visible un instante tras un cierre rápido.",
          "Corrige un problema por el que una ficha se detenía brevemente al soltarla hacia abajo.",
        ],
      },
      {
        title: "Rendimiento",
        items: [
          "Mejora la aparición de la pantalla de inicio al abrir la app.",
          "Acelera la carga de una nueva versión al volver a la app.",
          "Acelera la apertura de los títulos que no están en la biblioteca.",
          "Reduce la carga del dispositivo al reproducir películas con sonido Dolby TrueHD.",
        ],
      },
    ],
  },
  de: {
    sections: [
      {
        title: "Suche",
        entries: [
          {
            icon: "search",
            title: "Suche nach Beschreibung",
            text: "Beschreiben Sie einen Film oder eine Serie in einem Satz, etwa „der Film, in dem ein Mann denselben Tag immer wieder erlebt“, und die Suche findet ihn – ob in der Bibliothek oder zum Anfragen.",
            badge: "",
          },
        ],
      },
      {
        title: "Animationen und Leistung",
        entries: [
          {
            icon: "sparkles",
            title: "Animationen",
            text: "Die Animationen der App wurden überarbeitet und bleiben auf allen Geräten flüssig, auch auf älteren.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Leistung",
            text: "Die App startet und setzt schneller fort und beansprucht Ihr Gerät weniger.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Dieses Update fügt die Suche nach Beschreibung hinzu und verbessert die Flüssigkeit der Animationen und die Leistung der App.",
    fixes: [
      {
        title: "Animationen",
        items: [
          "Verbessert die Flüssigkeit der Karten beim Herunterziehen.",
          "Behebt ein Problem, bei dem Text und Schaltflächen einer Karte nach dem Schließen kurz sichtbar blieben.",
          "Behebt ein Problem, bei dem das Bild einer Karte oben am Bildschirm hängen blieb, wenn sie beim Öffnen gegriffen wurde.",
          "Verbessert das Öffnen von Titeln, die nicht in der Bibliothek sind – jetzt animiert aus ihrem Poster.",
          "Behebt ein Problem, bei dem das Bild einer Karte nach schnellem Schließen kurz sichtbar blieb.",
          "Behebt ein Problem, bei dem eine Karte beim Loslassen nach unten kurz anhielt.",
        ],
      },
      {
        title: "Leistung",
        items: [
          "Verbessert die Darstellung der Startseite beim Start.",
          "Beschleunigt das Laden einer neuen Version bei der Rückkehr in die App.",
          "Beschleunigt das Öffnen von Titeln, die nicht in der Bibliothek sind.",
          "Verringert die Last auf Ihrem Gerät bei der Wiedergabe von Filmen mit Dolby-TrueHD-Ton.",
        ],
      },
    ],
  },
};
