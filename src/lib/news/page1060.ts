import type { NewsContentByLang } from "./content";

/**
 * La page « 10.60 » — le récapitulatif des versions 10.40 à 10.59 (18/11/2026, demandé par le propriétaire).
 *
 * Semée en brouillon (`seedNewsPage(…, "draft")`), relue par le propriétaire, puis **publiée sur toute installation**
 * (`publishNewsDraft`, 18/11/2026) : elle s'annonce une fois, la fenêtre s'ouvre. Elle reprend, en plus court et en mots simples, ce que les pages discrètes 10.40,
 * 10.43, 10.58 et 10.59 ont déjà rangé dans l'historique. Seulement ce que tout compte a, sans réglage : ni « À
 * l'écran » ni les fonctions de laboratoire. Le chiffre des corrections compte les livraisons de correctifs et de
 * petites améliorations depuis la 10.40 (85, dont 37 au registre ; plusieurs en regroupent beaucoup — retouches des
 * fiches, deux chasses aux bugs), hors le chantier archivé de Lumen serveur.
 */
export const NEWS_1060_VERSION = "10.60";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_1060_SEED = "news-seed-10.60-draft";
/** Publiée partout le 18/11/2026 (le propriétaire) : le brouillon devient une page annoncée, une fois par installation. */
export const NEWS_1060_PUBLISH = "news-publish-10.60";

export const NEWS_1060_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Lecteur",
        entries: [
          { icon: "next", title: "Avancer sans attendre", text: "touchez +10 s ou −10 s autant de fois que vous voulez.", badge: "" },
          { icon: "speed", title: "L'heure de fin", text: "sous le temps restant, pour savoir à quelle heure le film se termine.", badge: "" },
          { icon: "captions", title: "Revoir un passage", text: "après un retour de 10 s, les dialogues s'affichent le temps du passage, puis tout redevient comme avant.", badge: "" },
          { icon: "audio", title: "Le son repart aussitôt", text: "après une pause sur iPhone et iPad.", badge: "" },
          { icon: "phone", title: "Verrouiller l'écran", text: "dans le menu « ⋯ » : plus rien ne réagit au toucher pendant le film.", badge: "" },
        ],
      },
      {
        title: "Fiches",
        entries: [
          { icon: "sheets", title: "Les détails d'un film", text: "touchez « i » ou une pastille comme « 4K » : image, son, sous-titres et connexion conseillée.", badge: "" },
          { icon: "sheets", title: "Le prochain épisode", text: "quand vous êtes à jour d'une série, la fiche dit quand arrive la suite.", badge: "" },
          { icon: "palette", title: "Des fiches plus claires", text: "mise en page revue, durées mieux écrites, et des fiches qui tiennent sur un petit écran.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Plus de 100 corrections et améliorations : une lecture plus stable, des fiches et une navigation plus fiables, et une app plus rapide.",
    fixes: [
      {
        title: "Lecture",
        items: [
          "La lecture reprend mieux après une coupure de connexion.",
          "Le changement de piste audio garde les sous-titres.",
          "La position de reprise est mieux conservée à la fermeture.",
          "L'épisode suivant s'enchaîne de façon plus fiable.",
        ],
      },
      {
        title: "Fiches et navigation",
        items: [
          "Les rôles des acteurs s'affichent dans votre langue.",
          "Les fenêtres posées sur une fiche se ferment sans emporter la fiche.",
          "L'écran des épisodes se comporte mieux à l'ouverture et à la fermeture du lecteur.",
          "Les notifications de nouvel épisode n'arrivent plus en double.",
        ],
      },
      {
        title: "Téléphone et tablette",
        items: [
          "La barre du bas s'efface pendant que vous écrivez.",
          "Plusieurs éléments ne sont plus coupés ou mal placés sur iPhone.",
        ],
      },
      {
        title: "Rapidité",
        items: ["L'accueil et les fiches s'affichent plus vite, même quand un service est lent."],
      },
    ],
  },
  en: {
    sections: [
      {
        title: "Player",
        entries: [
          { icon: "next", title: "Skip without waiting", text: "tap +10 s or −10 s as many times as you like.", badge: "" },
          { icon: "speed", title: "End time", text: "under the time remaining, so you know when the film will finish.", badge: "" },
          { icon: "captions", title: "Replay a moment", text: "after going back 10 s, the dialogue is shown for that moment, then everything returns to how it was.", badge: "" },
          { icon: "audio", title: "Sound resumes instantly", text: "after a pause on iPhone and iPad.", badge: "" },
          { icon: "phone", title: "Lock the screen", text: "in the “⋯” menu: nothing responds to touch during the film.", badge: "" },
        ],
      },
      {
        title: "Title pages",
        entries: [
          { icon: "sheets", title: "Film details", text: "tap “i” or a badge such as “4K”: picture, sound, subtitles and recommended connection.", badge: "" },
          { icon: "sheets", title: "Next episode", text: "when you are up to date with a series, the page tells you when the next one arrives.", badge: "" },
          { icon: "palette", title: "Clearer title pages", text: "a reworked layout, better-written durations, and pages that fit on a small screen.", badge: "" },
        ],
      },
    ],
    fixesSummary: "More than 100 fixes and improvements: steadier playback, more reliable pages and navigation, and a faster app.",
    fixes: [
      {
        title: "Playback",
        items: [
          "Playback recovers better after a connection drop.",
          "Changing the audio track keeps the subtitles.",
          "Your resume point is kept more reliably when you close a film.",
          "The next episode follows on more reliably.",
        ],
      },
      {
        title: "Pages and navigation",
        items: [
          "Actors' roles are shown in your language.",
          "Windows opened over a title page close without taking the page with them.",
          "The episodes screen behaves better when the player opens and closes.",
          "New episode notifications no longer arrive twice.",
        ],
      },
      {
        title: "Phone and tablet",
        items: ["The bottom bar steps aside while you type.", "Several elements are no longer cut off or misplaced on iPhone."],
      },
      {
        title: "Speed",
        items: ["Home and title pages appear faster, even when a service is slow."],
      },
    ],
  },
  es: {
    sections: [
      {
        title: "Reproductor",
        entries: [
          { icon: "next", title: "Avanzar sin esperar", text: "toque +10 s o −10 s tantas veces como quiera.", badge: "" },
          { icon: "speed", title: "Hora de fin", text: "bajo el tiempo restante, para saber a qué hora termina la película.", badge: "" },
          { icon: "captions", title: "Volver a ver un momento", text: "tras retroceder 10 s, los diálogos se muestran durante ese momento y luego todo vuelve a estar como antes.", badge: "" },
          { icon: "audio", title: "El sonido vuelve al instante", text: "tras una pausa en iPhone y iPad.", badge: "" },
          { icon: "phone", title: "Bloquear la pantalla", text: "en el menú «⋯»: nada responde al tacto durante la película.", badge: "" },
        ],
      },
      {
        title: "Fichas",
        entries: [
          { icon: "sheets", title: "Detalles de una película", text: "toque «i» o una etiqueta como «4K»: imagen, sonido, subtítulos y conexión recomendada.", badge: "" },
          { icon: "sheets", title: "Próximo episodio", text: "cuando está al día con una serie, la ficha indica cuándo llega el siguiente.", badge: "" },
          { icon: "palette", title: "Fichas más claras", text: "diseño revisado, duraciones mejor escritas y fichas que caben en una pantalla pequeña.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Más de 100 correcciones y mejoras: una reproducción más estable, fichas y navegación más fiables y una app más rápida.",
    fixes: [
      {
        title: "Reproducción",
        items: [
          "La reproducción se recupera mejor tras un corte de conexión.",
          "Cambiar la pista de audio conserva los subtítulos.",
          "El punto de reanudación se guarda mejor al cerrar.",
          "El siguiente episodio se encadena de forma más fiable.",
        ],
      },
      {
        title: "Fichas y navegación",
        items: [
          "Los papeles de los actores se muestran en su idioma.",
          "Las ventanas abiertas sobre una ficha se cierran sin llevarse la ficha.",
          "La pantalla de episodios se comporta mejor al abrir y cerrar el reproductor.",
          "Las notificaciones de nuevo episodio ya no llegan por duplicado.",
        ],
      },
      {
        title: "Móvil y tableta",
        items: ["La barra inferior se aparta mientras escribe.", "Varios elementos ya no aparecen cortados o mal colocados en iPhone."],
      },
      {
        title: "Rapidez",
        items: ["El inicio y las fichas aparecen más rápido, incluso cuando un servicio va lento."],
      },
    ],
  },
  de: {
    sections: [
      {
        title: "Player",
        entries: [
          { icon: "next", title: "Springen ohne Warten", text: "Tippen Sie so oft auf +10 s oder −10 s, wie Sie möchten.", badge: "" },
          { icon: "speed", title: "Endzeit", text: "unter der Restzeit, damit Sie wissen, wann der Film endet.", badge: "" },
          { icon: "captions", title: "Eine Stelle noch einmal", text: "nach 10 s zurück werden die Dialoge für diese Stelle angezeigt, danach ist alles wieder wie vorher.", badge: "" },
          { icon: "audio", title: "Der Ton ist sofort zurück", text: "nach einer Pause auf iPhone und iPad.", badge: "" },
          { icon: "phone", title: "Bildschirm sperren", text: "im Menü „⋯“: Während des Films reagiert nichts mehr auf Berührung.", badge: "" },
        ],
      },
      {
        title: "Titelseiten",
        entries: [
          { icon: "sheets", title: "Details zu einem Film", text: "Tippen Sie auf „i“ oder ein Abzeichen wie „4K“: Bild, Ton, Untertitel und empfohlene Verbindung.", badge: "" },
          { icon: "sheets", title: "Nächste Folge", text: "Wenn Sie bei einer Serie auf dem neuesten Stand sind, zeigt die Seite, wann die nächste Folge kommt.", badge: "" },
          { icon: "palette", title: "Übersichtlichere Titelseiten", text: "überarbeitetes Layout, besser geschriebene Laufzeiten und Seiten, die auf einen kleinen Bildschirm passen.", badge: "" },
        ],
      },
    ],
    fixesSummary: "Mehr als 100 Korrekturen und Verbesserungen: stabilere Wiedergabe, zuverlässigere Seiten und Navigation und eine schnellere App.",
    fixes: [
      {
        title: "Wiedergabe",
        items: [
          "Die Wiedergabe erholt sich besser nach einem Verbindungsabbruch.",
          "Beim Wechsel der Tonspur bleiben die Untertitel erhalten.",
          "Ihre Fortsetzungsposition wird beim Schließen zuverlässiger gespeichert.",
          "Die nächste Folge schließt zuverlässiger an.",
        ],
      },
      {
        title: "Seiten und Navigation",
        items: [
          "Die Rollen der Schauspieler werden in Ihrer Sprache angezeigt.",
          "Fenster über einer Titelseite schließen sich, ohne die Seite mitzunehmen.",
          "Die Folgenansicht verhält sich beim Öffnen und Schließen des Players besser.",
          "Benachrichtigungen über neue Folgen kommen nicht mehr doppelt.",
        ],
      },
      {
        title: "Handy und Tablet",
        items: ["Die untere Leiste weicht aus, während Sie tippen.", "Mehrere Elemente werden auf dem iPhone nicht mehr abgeschnitten oder falsch platziert."],
      },
      {
        title: "Geschwindigkeit",
        items: ["Startseite und Titelseiten erscheinen schneller, auch wenn ein Dienst langsam ist."],
      },
    ],
  },
};
