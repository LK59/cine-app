import type { NewsContentByLang } from "./content";

/**
 * La première page de Nouveautés, « 8.44 » — texte validé par Louis le 12/10/2026, en français, et
 * traduit ici une fois pour toutes (DECISIONS.md §73).
 *
 * Elle vit dans le code, en quatre langues, et c'est la migration qui la publie (`seedInitialNews`,
 * db.ts) : toute installation — l'image publique comprise — l'a au premier démarrage, sans geste de
 * l'administrateur et sans appel à un fournisseur d'IA. Le démarrage ne la traduit jamais.
 *
 * Ne pas y mentionner les titres masqués : voulu par Louis.
 * « Passer le récap » en a été retiré le 15/10 (le bouton est parti en 8.60.3, les segments Recap
 * de Jellyfin commençant tous à 0 s) : une installation neuve ne doit pas chercher un bouton absent.
 * Une base déjà semée garde son texte (le marqueur ne la réécrit pas) : elle se corrige à part.
 */
export const INITIAL_NEWS_VERSION = "8.44";
/** Le nom du marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const INITIAL_NEWS_SEED = "news-seed-8.44";

export const INITIAL_NEWS_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau",
        entries: [
          { icon: "audio", title: "Améliorer les dialogues", text: "Les voix passent devant la musique. Menu audio → Améliorer les dialogues.", badge: "" },
          { icon: "subtitles", title: "Sous-titres générés", text: "Votre langue manque ? Générez-la en quelques secondes. Menu sous-titres → Générer.", badge: "" },
          { icon: "next", title: "Épisode suivant", text: "Enchaîner l'épisode, d'un seul clic.", badge: "" },
          { icon: "cast", title: "Chromecast", text: "Diffusez sur votre téléviseur depuis Chrome ou Android.", badge: "bêta" },
        ],
      },
      {
        title: "Design",
        entries: [
          { icon: "logo", title: "Le logo du titre dans le lecteur", text: ", en bas à gauche.", badge: "" },
          { icon: "captions", title: "Des sous-titres plus discrets", text: ", plus petits et plus bas.", badge: "" },
          { icon: "sheets", title: "Des fiches qui naissent de l'affiche", text: "que vous touchez.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Plus rapide, plus fiable.",
    fixes: [
      {
        title: "Lecture",
        items: [
          "Reprise d'un film plus rapide : 6 Mo de moins à charger avant la première image.",
          "Moins de requêtes en arrière-plan pendant un film, pour économiser la batterie.",
          "Le son 5.1 de certains films est désormais restitué correctement sur tous les appareils.",
          "Une coupure réseau ne fait plus perdre sa place : la lecture reprend là où elle s'était arrêtée.",
          "Correction d'un bug qui pouvait figer l'image au lancement d'un film sur iPhone.",
          "Correction d'un bug qui pouvait enchaîner l'épisode suivant après avoir fermé le lecteur.",
          "Les boutons ±10 s ne ramènent plus au début du film pendant un chargement.",
          "Un appui sur l'image affiche les commandes au lieu de mettre en pause sur écran tactile.",
          "Le volume et le mode muet sont retenus d'un film à l'autre.",
        ],
      },
      {
        title: "Accueil et fiches",
        items: [
          "Accueil jusqu'à 4 secondes plus rapide à charger.",
          "Ouverture des fiches plus fluide sur téléphone.",
          "Grandes images des séries plus légères.",
          "« Reprendre » suit l'ordre de vos dernières lectures, films et épisodes mêlés.",
          "Correction d'un bug qui pouvait bloquer une fiche sur ordinateur.",
          "Les logos des titres s'affichent en entier sur les écrans peu hauts.",
          "Navigation à la télécommande améliorée sur Fire TV.",
        ],
      },
      {
        title: "Compte et sécurité",
        items: ["Votre session se ferme si votre compte est désactivé.", "Renforcement de la sécurité des échanges avec le serveur."],
      },
      {
        title: "Fiabilité",
        items: [
          "Correction de bugs pouvant provoquer le plantage de l'application.",
          "L'application se met à jour d'elle-même quand une nouvelle version est disponible.",
        ],
      },
    ],
  },
  en: {
    sections: [
      {
        title: "New",
        entries: [
          { icon: "audio", title: "Enhance dialogue", text: "Voices come through over the music. Audio menu → Enhance dialogue.", badge: "" },
          { icon: "subtitles", title: "Generated subtitles", text: "Missing your language? Generate it in seconds. Subtitles menu → Generate.", badge: "" },
          { icon: "next", title: "Next episode", text: "Roll into the next episode, in one click.", badge: "" },
          { icon: "cast", title: "Chromecast", text: "Cast to your TV from Chrome or Android.", badge: "beta" },
        ],
      },
      {
        title: "Design",
        entries: [
          { icon: "logo", title: "The title's logo in the player", text: ", bottom left.", badge: "" },
          { icon: "captions", title: "Subtler subtitles", text: ", smaller and lower.", badge: "" },
          { icon: "sheets", title: "Pages that grow out of the poster", text: "you tap.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Faster, more reliable.",
    fixes: [
      {
        title: "Playback",
        items: [
          "Resuming a film is faster: 6 MB less to load before the first frame.",
          "Fewer background requests during a film, to save battery.",
          "5.1 sound on some films now plays correctly on every device.",
          "A network drop no longer loses your place: playback picks up where it stopped.",
          "Fixed a bug that could freeze the picture when starting a film on iPhone.",
          "Fixed a bug that could start the next episode after closing the player.",
          "The ±10 s buttons no longer jump back to the start while loading.",
          "On touch screens, tapping the picture shows the controls instead of pausing.",
          "Volume and mute are remembered from one film to the next.",
        ],
      },
      {
        title: "Home and title pages",
        items: [
          "Home loads up to 4 seconds faster.",
          "Title pages open more smoothly on phones.",
          "Lighter large images for series.",
          "“Continue watching” follows the order you last watched in, films and episodes together.",
          "Fixed a bug that could freeze a title page on computers.",
          "Title logos show in full on short screens.",
          "Better remote navigation on Fire TV.",
        ],
      },
      {
        title: "Account and security",
        items: ["You're signed out if your account is disabled.", "Stronger security for communication with the server."],
      },
      {
        title: "Reliability",
        items: ["Fixed bugs that could make the app crash.", "The app updates itself when a new version is available."],
      },
    ],
  },
  es: {
    sections: [
      {
        title: "Novedades",
        entries: [
          { icon: "audio", title: "Mejorar diálogos", text: "Las voces se oyen por encima de la música. Menú de audio → Mejorar diálogos.", badge: "" },
          { icon: "subtitles", title: "Subtítulos generados", text: "¿Falta tu idioma? Genéralo en unos segundos. Menú de subtítulos → Generar.", badge: "" },
          { icon: "next", title: "Siguiente episodio", text: "Pasa al siguiente episodio con un solo clic.", badge: "" },
          { icon: "cast", title: "Chromecast", text: "Envía a tu televisor desde Chrome o Android.", badge: "beta" },
        ],
      },
      {
        title: "Diseño",
        entries: [
          { icon: "logo", title: "El logo del título en el reproductor", text: ", abajo a la izquierda.", badge: "" },
          { icon: "captions", title: "Subtítulos más discretos", text: ", más pequeños y más abajo.", badge: "" },
          { icon: "sheets", title: "Fichas que nacen del póster", text: "que tocas.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Más rápido, más fiable.",
    fixes: [
      {
        title: "Reproducción",
        items: [
          "Reanudar una película es más rápido: 6 MB menos que cargar antes de la primera imagen.",
          "Menos peticiones en segundo plano durante una película, para ahorrar batería.",
          "El sonido 5.1 de algunas películas ahora se reproduce correctamente en todos los dispositivos.",
          "Un corte de red ya no te hace perder el sitio: la reproducción sigue donde se detuvo.",
          "Corregido un error que podía congelar la imagen al iniciar una película en iPhone.",
          "Corregido un error que podía iniciar el siguiente episodio tras cerrar el reproductor.",
          "Los botones ±10 s ya no vuelven al principio durante una carga.",
          "En pantallas táctiles, tocar la imagen muestra los controles en lugar de pausar.",
          "El volumen y el silencio se recuerdan de una película a otra.",
        ],
      },
      {
        title: "Inicio y fichas",
        items: [
          "El inicio carga hasta 4 segundos más rápido.",
          "Las fichas se abren con más fluidez en el móvil.",
          "Imágenes grandes de las series más ligeras.",
          "«Continuar viendo» sigue el orden de lo último que viste, películas y episodios juntos.",
          "Corregido un error que podía bloquear una ficha en el ordenador.",
          "Los logos de los títulos se ven enteros en pantallas bajas.",
          "Mejor navegación con el mando en Fire TV.",
        ],
      },
      {
        title: "Cuenta y seguridad",
        items: ["Tu sesión se cierra si tu cuenta se desactiva.", "Mayor seguridad en las comunicaciones con el servidor."],
      },
      {
        title: "Fiabilidad",
        items: ["Corregidos errores que podían cerrar la aplicación.", "La aplicación se actualiza sola cuando hay una nueva versión."],
      },
    ],
  },
  de: {
    sections: [
      {
        title: "Neu",
        entries: [
          { icon: "audio", title: "Dialoge verbessern", text: "Stimmen treten vor die Musik. Audiomenü → Dialoge verbessern.", badge: "" },
          { icon: "subtitles", title: "Generierte Untertitel", text: "Deine Sprache fehlt? In wenigen Sekunden generiert. Untertitelmenü → Generieren.", badge: "" },
          { icon: "next", title: "Nächste Folge", text: "Nächste Folge starten – mit einem Klick.", badge: "" },
          { icon: "cast", title: "Chromecast", text: "Streame von Chrome oder Android auf deinen Fernseher.", badge: "Beta" },
        ],
      },
      {
        title: "Design",
        entries: [
          { icon: "logo", title: "Das Titellogo im Player", text: ", unten links.", badge: "" },
          { icon: "captions", title: "Dezentere Untertitel", text: ", kleiner und tiefer.", badge: "" },
          { icon: "sheets", title: "Seiten, die aus dem Poster wachsen,", text: "das du antippst.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Schneller, zuverlässiger.",
    fixes: [
      {
        title: "Wiedergabe",
        items: [
          "Filme setzen schneller fort: 6 MB weniger bis zum ersten Bild.",
          "Weniger Hintergrundanfragen während eines Films, um Akku zu sparen.",
          "Der 5.1-Ton mancher Filme wird jetzt auf allen Geräten richtig wiedergegeben.",
          "Ein Netzabbruch kostet nicht mehr deine Stelle: Die Wiedergabe macht dort weiter, wo sie stand.",
          "Fehler behoben, durch den das Bild beim Start eines Films auf dem iPhone einfrieren konnte.",
          "Fehler behoben, durch den nach dem Schließen des Players die nächste Folge starten konnte.",
          "Die ±10-s-Tasten springen beim Laden nicht mehr an den Anfang zurück.",
          "Auf Touchscreens zeigt ein Tippen aufs Bild die Steuerung, statt zu pausieren.",
          "Lautstärke und Stummschaltung bleiben von Film zu Film erhalten.",
        ],
      },
      {
        title: "Startseite und Titelseiten",
        items: [
          "Die Startseite lädt bis zu 4 Sekunden schneller.",
          "Titelseiten öffnen sich auf dem Handy flüssiger.",
          "Leichtere große Bilder bei Serien.",
          "„Weiterschauen“ folgt der Reihenfolge deiner letzten Wiedergaben, Filme und Folgen gemischt.",
          "Fehler behoben, durch den eine Titelseite am Computer hängen bleiben konnte.",
          "Titellogos werden auf niedrigen Bildschirmen vollständig angezeigt.",
          "Bessere Navigation mit der Fernbedienung auf Fire TV.",
        ],
      },
      {
        title: "Konto und Sicherheit",
        items: ["Deine Sitzung endet, wenn dein Konto deaktiviert wird.", "Sicherere Kommunikation mit dem Server."],
      },
      {
        title: "Zuverlässigkeit",
        items: ["Fehler behoben, die die App abstürzen lassen konnten.", "Die App aktualisiert sich selbst, sobald eine neue Version verfügbar ist."],
      },
    ],
  },
};
