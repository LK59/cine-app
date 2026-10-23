import type { NewsContent, NewsContentByLang, NewsLang } from "@/lib/news/content";
import { NEWS_LANGS } from "@/lib/news/content";

/**
 * Le registre des corrections livrées (20/10/2026, demande de Louis, DECISIONS.md §73).
 *
 * Chaque correction qu'un spectateur peut remarquer — pas l'administration, pas les outils, pas une
 * fonction nouvelle, et jamais un défaut introduit puis corrigé dans la même série de déploiements —
 * est notée ici, une fois, avec la version qui l'a livrée et la page de Nouveautés qui la couvre.
 * Au démarrage, `applyFixesLedger` (db.ts) ajoute chaque entrée encore absente à la liste
 * « Optimisations et corrections de bugs » de sa page, dans les quatre langues, sur toute
 * installation : la page ne change pas de rang, la fenêtre ne se rouvre pour personne — l'historique
 * se complète, c'est tout.
 *
 * Rétroactif : les entrées des 8.37 à 9.1.2 ont été relevées dans l'historique le 20/10/2026.
 * Actif : chaque déploiement qui corrige quelque chose de visible ajoute ici ses entrées, avec pour
 * page la dernière publiée (`page`).
 *
 * Ne jamais y parler des titres masqués, ni de la fabrication interne.
 */

export interface FixLedgerEntry {
  /** La page de Nouveautés qui la porte (« 9.1 »). Absente ou introuvable : celle que la version désigne. */
  page?: string;
  /** La version qui a livré la correction. */
  version: string;
  /** Le groupe (« Lecture »), titré dans chaque langue — le même que celui de la page s'il existe. */
  group: Record<NewsLang, string>;
  items: Record<NewsLang, string>[];
}

export const FIXES_LEDGER: FixLedgerEntry[] = [
  {
    page: "8.44",
    version: "8.37.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Sur certains films, choisir une autre piste audio ne ramène plus à l'ancienne, et le lecteur ne se relance plus en boucle.",
        en: "On some films, choosing another audio track no longer reverts to the previous one, and the player no longer restarts in a loop.",
        es: "En algunas películas, elegir otra pista de audio ya no vuelve a la anterior, y el reproductor ya no se reinicia en bucle.",
        de: "Bei manchen Filmen springt die Wahl einer anderen Tonspur nicht mehr zur vorherigen zurück, und der Player startet nicht mehr in einer Schleife neu.",
      },
    ],
  },
  {
    page: "8.44",
    version: "8.37.0",
    group: { fr: "Accueil et fiches", en: "Home and title pages", es: "Inicio y fichas", de: "Startseite und Titelseiten" },
    items: [
      {
        fr: "« Ma liste » et « Vus » affichent les mêmes affiches que le reste du catalogue.",
        en: "“My list” and “Watched” show the same posters as the rest of the catalogue.",
        es: "«Mi lista» y «Vistos» muestran los mismos pósteres que el resto del catálogo.",
        de: "„Meine Liste“ und „Gesehen“ zeigen dieselben Poster wie der übrige Katalog.",
      },
      {
        fr: "Une affiche qui tarde à charger n'empêche plus les autres de s'afficher.",
        en: "A poster that is slow to load no longer holds up the others.",
        es: "Un póster que tarda en cargar ya no impide que se muestren los demás.",
        de: "Ein Poster, das langsam lädt, hält die anderen nicht mehr auf.",
      },
      {
        fr: "Après un film, les grandes images des fiches s'affichent de nouveau sans attendre.",
        en: "After a film, the large images on title pages show up again without waiting.",
        es: "Después de una película, las imágenes grandes de las fichas vuelven a aparecer sin esperar.",
        de: "Nach einem Film erscheinen die großen Bilder der Titelseiten wieder ohne Wartezeit.",
      },
    ],
  },
  {
    page: "8.44",
    version: "8.38.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Un souci de son passager sur un film ne dégrade plus les films suivants sur le même appareil.",
        en: "A one-off sound problem on one film no longer downgrades the next films on the same device.",
        es: "Un problema de sonido puntual en una película ya no empeora las siguientes en el mismo dispositivo.",
        de: "Ein einmaliges Tonproblem bei einem Film verschlechtert nicht mehr die folgenden Filme auf demselben Gerät.",
      },
      {
        fr: "Sur Chrome et Firefox, le son de certains films est transmis tel quel, sans perte de qualité.",
        en: "On Chrome and Firefox, the sound of some films is passed through as is, with no loss of quality.",
        es: "En Chrome y Firefox, el sonido de algunas películas se transmite tal cual, sin pérdida de calidad.",
        de: "In Chrome und Firefox wird der Ton mancher Filme unverändert übertragen, ohne Qualitätsverlust.",
      },
    ],
  },
  {
    page: "8.48",
    version: "8.48.5",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Après avoir déverrouillé le téléphone, la lecture ne se bloque plus quelques secondes en reprenant.",
        en: "After unlocking your phone, playback no longer stalls for a few seconds as it resumes.",
        es: "Tras desbloquear el teléfono, la reproducción ya no se detiene unos segundos al continuar.",
        de: "Nach dem Entsperren des Handys stockt die Wiedergabe beim Fortsetzen nicht mehr für einige Sekunden.",
      },
    ],
  },
  {
    page: "8.61",
    version: "8.49.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Après un saut resté sans image, la lecture repart bien à l'endroit demandé, jamais à une position précédente.",
        en: "After a seek that showed no picture, playback now resumes where you asked, never at an earlier position.",
        es: "Tras un salto que se quedaba sin imagen, la reproducción vuelve al punto pedido, nunca a una posición anterior.",
        de: "Nach einem Sprung ohne Bild setzt die Wiedergabe an der gewünschten Stelle fort, nie an einer früheren Position.",
      },
      {
        fr: "Changer de piste audio pendant un passage en vidéo allégée ne fait plus entendre l'ancienne piste.",
        en: "Changing audio track while switching to a lighter video no longer leaves the old track playing.",
        es: "Cambiar de pista de audio durante el paso a un vídeo más ligero ya no deja sonando la pista anterior.",
        de: "Ein Wechsel der Tonspur während des Umschaltens auf ein leichteres Video lässt nicht mehr die alte Tonspur weiterlaufen.",
      },
      {
        fr: "Le choix « Originale » du menu Qualité s'applique aussi aux autres onglets déjà ouverts.",
        en: "Choosing “Original” in the Quality menu now also applies to other tabs already open.",
        es: "Elegir «Original» en el menú Calidad también se aplica a las otras pestañas ya abiertas.",
        de: "Die Wahl „Original“ im Menü Qualität gilt jetzt auch für bereits geöffnete andere Tabs.",
      },
      {
        fr: "Sans réseau, l'écran « Connexion perdue » apparaît au bout d'une minute au lieu de trois, sans autre message par-dessus.",
        en: "With no network, the “Connection lost” screen appears after one minute instead of three, with no other message on top.",
        es: "Sin red, la pantalla «Conexión perdida» aparece al cabo de un minuto en lugar de tres, sin otro mensaje encima.",
        de: "Ohne Netz erscheint der Bildschirm „Verbindung verloren“ nach einer statt nach drei Minuten, ohne eine andere Meldung darüber.",
      },
      {
        fr: "Une réponse réseau incomplète est redemandée au lieu d'être prise pour la fin du film.",
        en: "An incomplete network response is requested again instead of being taken for the end of the film.",
        es: "Una respuesta de red incompleta se vuelve a pedir en lugar de tomarse por el final de la película.",
        de: "Eine unvollständige Netzwerkantwort wird erneut angefordert, statt für das Ende des Films gehalten zu werden.",
      },
      {
        fr: "Si la bibliothèque ne répond pas au lancement d'un film, le lecteur le dit clairement.",
        en: "If the library does not respond when a film starts, the player now says so clearly.",
        es: "Si la biblioteca no responde al iniciar una película, el reproductor lo indica claramente.",
        de: "Antwortet die Mediathek beim Start eines Films nicht, sagt der Player das jetzt klar.",
      },
      {
        fr: "Votre position gardée pendant une coupure n'est plus effacée par un autre compte sur le même appareil.",
        en: "Your position kept through a dropout is no longer erased by another account on the same device.",
        es: "Tu posición conservada durante un corte ya no la borra otra cuenta en el mismo dispositivo.",
        de: "Ihre während eines Abbruchs gespeicherte Position wird nicht mehr von einem anderen Konto auf demselben Gerät gelöscht.",
      },
      {
        fr: "Un double appui sur « Épisode suivant » ne saute plus un épisode.",
        en: "Pressing “Next episode” twice no longer skips an episode.",
        es: "Pulsar dos veces «Episodio siguiente» ya no se salta un episodio.",
        de: "Zweimaliges Drücken auf „Nächste Folge“ überspringt keine Folge mehr.",
      },
      {
        fr: "Au clavier et à la télécommande : les flèches agissent sur la barre de lecture, Entrée ne déclenche plus la fiche cachée derrière le film, et Espace active bien « Réessayer » après une erreur.",
        en: "With a keyboard or remote: the arrows work on the progress bar, Enter no longer triggers the title page hidden behind the film, and Space now activates “Try again” after an error.",
        es: "Con teclado o mando: las flechas actúan sobre la barra de reproducción, Intro ya no activa la ficha oculta tras la película, y Espacio activa «Reintentar» tras un error.",
        de: "Mit Tastatur oder Fernbedienung: Die Pfeiltasten wirken auf die Fortschrittsleiste, Enter löst nicht mehr die hinter dem Film verborgene Titelseite aus, und die Leertaste aktiviert nach einem Fehler „Erneut versuchen“.",
      },
    ],
  },
  {
    page: "8.61",
    version: "8.49.0",
    group: { fr: "Navigation", en: "Browsing", es: "Navegación", de: "Stöbern" },
    items: [
      {
        fr: "Un titre arrivé pendant votre visite (notification « Disponible », Ma liste) s'ouvre au lieu d'être annoncé indisponible.",
        en: "A title that arrived during your visit (an “Available” notification, My list) now opens instead of being shown as unavailable.",
        es: "Un título que llega durante tu visita (notificación «Disponible», Mi lista) se abre en lugar de anunciarse como no disponible.",
        de: "Ein während Ihres Besuchs hinzugekommener Titel (Benachrichtigung „Verfügbar“, Meine Liste) öffnet sich, statt als nicht verfügbar gemeldet zu werden.",
      },
      {
        fr: "La recherche retrouve les titres qui contiennent un nombre, comme « 1917 » ou « Blade Runner 2049 ».",
        en: "Search now finds titles containing a number, such as “1917” or “Blade Runner 2049”.",
        es: "La búsqueda encuentra los títulos que contienen un número, como «1917» o «Blade Runner 2049».",
        de: "Die Suche findet jetzt Titel mit einer Zahl, etwa „1917“ oder „Blade Runner 2049“.",
      },
      {
        fr: "Un épisode commencé dont la durée est inconnue propose bien « Reprendre », et un épisode très court n'affiche plus un « 0 » seul.",
        en: "A started episode of unknown length now offers “Resume”, and a very short episode no longer shows a lone “0”.",
        es: "Un episodio empezado de duración desconocida ofrece «Reanudar», y un episodio muy corto ya no muestra un «0» solo.",
        de: "Eine begonnene Folge unbekannter Länge bietet jetzt „Fortsetzen“ an, und eine sehr kurze Folge zeigt keine einzelne „0“ mehr.",
      },
      {
        fr: "Échap referme la liste des épisodes d'une série, même pendant son chargement.",
        en: "Escape now closes a series' episode list, even while it is loading.",
        es: "Escape cierra la lista de episodios de una serie, incluso mientras se carga.",
        de: "Escape schließt die Folgenliste einer Serie, auch während sie noch lädt.",
      },
      {
        fr: "La fiche d'une personne qui ne se charge pas affiche un message au lieu d'une carte vide.",
        en: "A person's page that fails to load now shows a message instead of an empty card.",
        es: "La ficha de una persona que no carga muestra un mensaje en lugar de una tarjeta vacía.",
        de: "Lässt sich die Seite einer Person nicht laden, erscheint eine Meldung statt einer leeren Karte.",
      },
      {
        fr: "La fenêtre des Nouveautés ne disparaît plus d'elle-même, et n'apparaît plus au milieu de la toute première visite.",
        en: "The What's new window no longer vanishes on its own, nor pops up in the middle of your very first visit.",
        es: "La ventana de Novedades ya no desaparece sola ni aparece en plena primera visita.",
        de: "Das Fenster mit den Neuigkeiten verschwindet nicht mehr von selbst und erscheint nicht mehr mitten im allerersten Besuch.",
      },
    ],
  },
  {
    page: "8.61",
    version: "8.49.0",
    group: { fr: "Compte", en: "Account", es: "Cuenta", de: "Konto" },
    items: [
      {
        fr: "Sur un appareil partagé, se déconnecter efface bien votre rangée « Reprendre » de l'appareil.",
        en: "On a shared device, signing out now properly clears your “Continue watching” row from the device.",
        es: "En un dispositivo compartido, cerrar sesión borra bien tu fila «Continuar viendo» del dispositivo.",
        de: "Auf einem gemeinsam genutzten Gerät entfernt die Abmeldung Ihre Reihe „Weiterschauen“ jetzt zuverlässig vom Gerät.",
      },
    ],
  },
  {
    page: "8.61",
    version: "8.53.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Pendant un film, l'application fait bien moins d'échanges en arrière-plan, ce qui ménage la batterie.",
        en: "During a film, the app now makes far fewer background requests, which spares the battery.",
        es: "Durante una película, la aplicación hace muchas menos peticiones en segundo plano, lo que ahorra batería.",
        de: "Während eines Films stellt die App deutlich weniger Anfragen im Hintergrund, was den Akku schont.",
      },
    ],
  },
  {
    page: "8.61",
    version: "8.60.3",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "« Passer le récap » n'apparaît plus à tort au tout début des épisodes.",
        en: "“Skip recap” no longer appears wrongly at the very start of episodes.",
        es: "«Saltar resumen» ya no aparece por error al principio de los episodios.",
        de: "„Rückblick überspringen“ erscheint nicht mehr fälschlich ganz am Anfang von Folgen.",
      },
    ],
  },
  {
    page: "8.64",
    version: "8.63.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Après un incident de lecture, le film repart là où vous en étiez, et non à l'endroit où vous l'aviez ouvert.",
        en: "After a playback hiccup, the film picks up where you were, not where you first opened it.",
        es: "Tras un fallo de reproducción, la película sigue donde ibas, no donde la abriste.",
        de: "Nach einer Wiedergabestörung läuft der Film dort weiter, wo Sie waren, und nicht an der Stelle, an der Sie ihn geöffnet hatten.",
      },
    ],
  },
  {
    page: "8.64",
    version: "8.64.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "L'écran « session expirée » du lecteur a enfin un bouton pour quitter, et la reconnexion ramène à la fiche.",
        en: "The player's “session expired” screen finally has a way out, and signing back in returns you to the title.",
        es: "La pantalla «sesión caducada» del reproductor por fin tiene un botón para salir, y al volver a iniciar sesión regresas a la ficha.",
        de: "Der Bildschirm „Sitzung abgelaufen“ im Player hat endlich einen Ausgang, und nach der erneuten Anmeldung kehren Sie zur Detailseite zurück.",
      },
    ],
  },
  {
    page: "8.64",
    version: "8.64.0",
    group: { fr: "Navigation", en: "Navigation", es: "Navegación", de: "Navigation" },
    items: [
      {
        fr: "Une coupure réseau s'annonce dans votre langue au lieu de « Failed to fetch ».",
        en: "A dropped connection is now explained in plain words instead of “Failed to fetch”.",
        es: "Un corte de red se anuncia en tu idioma en lugar de «Failed to fetch».",
        de: "Ein Verbindungsabbruch wird in Ihrer Sprache gemeldet statt mit „Failed to fetch“.",
      },
      {
        fr: "À la connexion, seules les tentatives ratées comptent pour le blocage temporaire, et son message est traduit.",
        en: "When signing in, only failed attempts count towards the temporary lockout, and its message is translated.",
        es: "Al iniciar sesión, solo los intentos fallidos cuentan para el bloqueo temporal, y su mensaje está traducido.",
        de: "Bei der Anmeldung zählen nur fehlgeschlagene Versuche für die vorübergehende Sperre, und ihre Meldung ist übersetzt.",
      },
      {
        fr: "Dans la recherche, la puce « Tout » compte aussi les répliques trouvées.",
        en: "In search, the “All” chip now counts the quotes it finds too.",
        es: "En la búsqueda, el filtro «Todo» también cuenta las frases encontradas.",
        de: "In der Suche zählt der Filter „Alle“ jetzt auch die gefundenen Zitate.",
      },
      {
        fr: "Une fiche découverte affiche le bon logo dès sa première ouverture.",
        en: "A discovery page shows the right logo from the very first time it opens.",
        es: "Una ficha de descubrimiento muestra el logo correcto desde la primera vez que se abre.",
        de: "Eine Entdecken-Seite zeigt schon beim ersten Öffnen das richtige Logo.",
      },
      {
        fr: "« Signaler un problème » : le Retour du haut recule d'une étape, et la barre de progression part du début.",
        en: "“Report a problem”: the Back button at the top goes back one step, and the progress bar starts empty.",
        es: "«Informar de un problema»: el botón Atrás de arriba retrocede un paso y la barra de progreso empieza vacía.",
        de: "„Problem melden“: Die Zurück-Taste oben geht einen Schritt zurück, und der Fortschrittsbalken beginnt leer.",
      },
      {
        fr: "Clavier et lecteurs d'écran : la fenêtre « Bienvenue » prend le focus, et la barre de lecture, les puces de la bannière et les photos ont un nom.",
        en: "Keyboard and screen readers: the “Welcome” window takes focus, and the progress bar, banner dots and photos now have names.",
        es: "Teclado y lectores de pantalla: la ventana «Bienvenida» recibe el foco, y la barra de reproducción, los puntos del banner y las fotos tienen nombre.",
        de: "Tastatur und Bildschirmleser: Das Fenster „Willkommen“ erhält den Fokus, und Wiedergabeleiste, Banner-Punkte und Fotos sind benannt.",
      },
    ],
  },
  {
    page: "8.64",
    version: "8.64.0",
    group: { fr: "Téléphone et tablette", en: "Phone and tablet", es: "Móvil y tableta", de: "Handy und Tablet" },
    items: [
      {
        fr: "Sur un petit iPhone, le bouton « Continuer » de la fenêtre « Bienvenue » ne passe plus sous le bord de l'écran.",
        en: "On a small iPhone, the “Continue” button of the “Welcome” window no longer slips below the screen edge.",
        es: "En un iPhone pequeño, el botón «Continuar» de la ventana «Bienvenida» ya no queda bajo el borde de la pantalla.",
        de: "Auf einem kleinen iPhone verschwindet die Taste „Weiter“ im Fenster „Willkommen“ nicht mehr unter dem Bildschirmrand.",
      },
      {
        fr: "Sur iPhone dans Safari, Compte explique qu'il faut installer l'app pour recevoir les notifications.",
        en: "In Safari on iPhone, Account explains that the app must be installed to receive notifications.",
        es: "En Safari en iPhone, Cuenta explica que hay que instalar la app para recibir notificaciones.",
        de: "In Safari auf dem iPhone erklärt das Konto, dass die App installiert sein muss, um Benachrichtigungen zu erhalten.",
      },
    ],
  },
  {
    page: "8.64",
    version: "8.64.0",
    group: { fr: "Compte", en: "Account", es: "Cuenta", de: "Konto" },
    items: [
      {
        fr: "Les appareils connectés disent quand ils ont servi : « Vue il y a 5 min ».",
        en: "Signed-in devices say when they were last used: “Seen 5 min ago”.",
        es: "Los dispositivos conectados indican cuándo se usaron: «Visto hace 5 min».",
        de: "Angemeldete Geräte zeigen, wann sie zuletzt benutzt wurden: „Gesehen vor 5 Min.“",
      },
      {
        fr: "L'aide « HDR délavé » n'apparaît plus que sur les ordinateurs concernés.",
        en: "The “washed-out HDR” help now only appears on the computers it applies to.",
        es: "La ayuda «HDR deslavado» solo aparece en los ordenadores afectados.",
        de: "Die Hilfe „Blasses HDR“ erscheint nur noch auf den betroffenen Computern.",
      },
    ],
  },
  {
    page: "8.68",
    version: "8.65.0",
    group: { fr: "Navigation", en: "Navigation", es: "Navegación", de: "Navigation" },
    items: [
      {
        fr: "Le geste Retour ne repasse plus par chaque onglet de la barre visité.",
        en: "The Back gesture no longer steps through every tab you visited in the bar.",
        es: "El gesto Atrás ya no pasa por cada pestaña de la barra que visitaste.",
        de: "Die Zurück-Geste geht nicht mehr durch jeden besuchten Tab der Leiste.",
      },
      {
        fr: "Quand votre session a expiré, la page de connexion le dit et vous ramène ensuite à la fiche ouverte.",
        en: "When your session has expired, the sign-in page says so and then takes you back to the title you had open.",
        es: "Cuando tu sesión ha caducado, la página de inicio de sesión lo indica y luego te devuelve a la ficha abierta.",
        de: "Ist Ihre Sitzung abgelaufen, sagt die Anmeldeseite das und bringt Sie danach zur geöffneten Detailseite zurück.",
      },
      {
        fr: "La filmographie d'une personne commence par ses rôles marquants ; ses apparitions dans son propre rôle passent à la fin.",
        en: "A person's filmography starts with their notable roles; appearances as themselves come last.",
        es: "La filmografía de una persona empieza por sus papeles destacados; sus apariciones como sí misma van al final.",
        de: "Die Filmografie einer Person beginnt mit ihren wichtigsten Rollen; Auftritte als sie selbst stehen am Ende.",
      },
    ],
  },
  {
    page: "8.68",
    version: "8.65.0",
    group: { fr: "Téléphone et tablette", en: "Phone and tablet", es: "Móvil y tableta", de: "Handy und Tablet" },
    items: [
      {
        fr: "En données mobiles, l'app prépare à l'avance un seul film à reprendre à la fois, et aucun en mode économie de données.",
        en: "On mobile data, the app prepares only one title to resume at a time ahead of time, and none in data-saver mode.",
        es: "Con datos móviles, la app prepara por adelantado un solo título para reanudar a la vez, y ninguno en modo ahorro de datos.",
        de: "Mit mobilen Daten bereitet die App jeweils nur einen Titel zum Fortsetzen vor, im Datensparmodus keinen.",
      },
    ],
  },
  {
    page: "8.68",
    version: "8.65.2",
    group: { fr: "Rapidité", en: "Speed", es: "Rapidez", de: "Geschwindigkeit" },
    items: [
      {
        fr: "L'app s'ouvre plus vite, surtout sur iPhone, juste après une mise à jour ou après un moment sans visite.",
        en: "The app opens faster, especially on iPhone, right after an update or after a while without visits.",
        es: "La app se abre más rápido, sobre todo en iPhone, justo después de una actualización o tras un rato sin visitas.",
        de: "Die App öffnet sich schneller, besonders auf dem iPhone, direkt nach einem Update oder nach längerer Pause.",
      },
      {
        fr: "À la première ouverture d'une fiche, le logo arrive en même temps que l'image.",
        en: "The first time a title opens, its logo arrives together with the picture.",
        es: "La primera vez que se abre una ficha, el logo llega junto con la imagen.",
        de: "Beim ersten Öffnen einer Detailseite erscheint das Logo zusammen mit dem Bild.",
      },
    ],
  },
  {
    page: "8.68",
    version: "8.67.1",
    group: { fr: "Téléphone et tablette", en: "Phone and tablet", es: "Móvil y tableta", de: "Handy und Tablet" },
    items: [
      {
        fr: "Sur iPhone, un appui long sur un onglet de la barre ne sélectionne plus son libellé et ne fige plus la barre.",
        en: "On iPhone, a long press on a tab in the bar no longer selects its label or freezes the bar.",
        es: "En iPhone, una pulsación larga en una pestaña de la barra ya no selecciona su texto ni bloquea la barra.",
        de: "Auf dem iPhone markiert ein langes Drücken auf einen Tab der Leiste nicht mehr dessen Beschriftung und lässt die Leiste nicht mehr hängen.",
      },
    ],
  },
  {
    page: "9.0",
    version: "8.69.2",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "La barre de lecture est plus épaisse et plus facile à saisir ; les marques de chapitres n'y apparaissent plus qu'en la faisant glisser.",
        en: "The progress bar is thicker and easier to grab; chapter marks now only appear while you drag it.",
        es: "La barra de reproducción es más gruesa y fácil de agarrar; las marcas de capítulos solo aparecen al deslizarla.",
        de: "Die Fortschrittsleiste ist dicker und leichter zu greifen; Kapitelmarken erscheinen nur noch beim Ziehen.",
      },
    ],
  },
  {
    page: "9.0",
    version: "8.70.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Au doigt, toucher la barre de lecture ne fait plus sauter le film : la glisser avance ou recule d'autant que le doigt, et une ombre douce la garde lisible sur les scènes claires.",
        en: "On touch screens, tapping the progress bar no longer jumps the film: dragging moves playback as far as your finger, and a soft shadow keeps the bar visible on bright scenes.",
        es: "En pantallas táctiles, tocar la barra ya no hace saltar la película: al deslizarla avanza o retrocede tanto como el dedo, y una sombra suave la mantiene visible en las escenas claras.",
        de: "Auf Touchscreens springt der Film beim Antippen der Fortschrittsleiste nicht mehr: Ziehen verschiebt die Wiedergabe genau so weit wie Ihr Finger, und ein sanfter Schatten hält die Leiste auf hellen Szenen sichtbar.",
      },
    ],
  },
  {
    page: "9.0",
    version: "8.71.2",
    group: { fr: "Navigation", en: "Navigation", es: "Navegación", de: "Navigation" },
    items: [
      {
        fr: "Sur ordinateur, la colonne des saisons de « Plus d'épisodes » prend la hauteur de ses saisons au lieu de s'étirer sur toute la page.",
        en: "On a computer, the seasons column in “More episodes” now fits its seasons instead of stretching down the whole page.",
        es: "En el ordenador, la columna de temporadas de «Más episodios» se ajusta a sus temporadas en lugar de estirarse por toda la página.",
        de: "Am Computer passt sich die Staffelspalte unter „Weitere Episoden“ ihren Staffeln an, statt sich über die ganze Seite zu strecken.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.1.1",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Sur iPhone, un appui long sur l'image ou un sous-titre ne sélectionne plus toute la page, qui bloquait alors les boutons du lecteur.",
        en: "On iPhone, a long press on the picture or a subtitle no longer selects the whole page, which used to block the player's buttons.",
        es: "En iPhone, una pulsación larga sobre la imagen o un subtítulo ya no selecciona toda la página, que bloqueaba los botones del reproductor.",
        de: "Auf dem iPhone markiert langes Drücken auf das Bild oder einen Untertitel nicht mehr die ganze Seite, was die Tasten des Players blockierte.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.1.2",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Quand un film a du mal à démarrer sur iPad, il repart là où il devait commencer au lieu de sauter douze secondes plus loin.",
        en: "When a film struggles to start on iPad, it now resumes where it was meant to begin instead of jumping twelve seconds ahead.",
        es: "Cuando una película tarda en arrancar en el iPad, se reanuda donde debía empezar en lugar de saltar doce segundos más adelante.",
        de: "Wenn ein Film auf dem iPad schwer startet, beginnt er dort, wo er beginnen sollte, statt zwölf Sekunden weiterzuspringen.",
      },
    ],
  },
  // Actif, à partir d'ici : une entrée par déploiement qui corrige quelque chose de visible.
  {
    page: "9.1",
    version: "9.3.2",
    group: { fr: "Sécurité", en: "Security", es: "Seguridad", de: "Sicherheit" },
    items: [
      {
        fr: "La sécurité de la lecture a été renforcée.",
        en: "Playback security has been strengthened.",
        es: "Se ha reforzado la seguridad de la reproducción.",
        de: "Die Sicherheit der Wiedergabe wurde verstärkt.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.3.4",
    group: { fr: "Sécurité", en: "Security", es: "Seguridad", de: "Sicherheit" },
    items: [
      {
        fr: "Sur un appareil partagé, une session terminée ne laisse plus les notifications ni les données du compte précédent.",
        en: "On a shared device, an ended session no longer leaves the previous account's notifications or data behind.",
        es: "En un dispositivo compartido, una sesión terminada ya no deja las notificaciones ni los datos de la cuenta anterior.",
        de: "Auf einem gemeinsam genutzten Gerät hinterlässt eine beendete Sitzung keine Benachrichtigungen oder Daten des vorherigen Kontos mehr.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.3.6",
    group: { fr: "Navigation", en: "Navigation", es: "Navegación", de: "Navigation" },
    items: [
      {
        fr: "« Tous les films », « Toutes les séries » et les téléchargements s'ouvrent plus légèrement, et les boutons répondent sans traîner sous le doigt.",
        en: "“All movies”, “All series” and downloads open more lightly, and buttons respond without lagging under your finger.",
        es: "«Todas las películas», «Todas las series» y las descargas se abren con más fluidez, y los botones responden sin retraso bajo el dedo.",
        de: "„Alle Filme“, „Alle Serien“ und die Downloads öffnen sich flüssiger, und die Schaltflächen reagieren ohne Verzögerung unter dem Finger.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.3.8",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "En revenant sur l'application après une longue mise en veille, un film reprend dans le lecteur habituel au lieu de basculer sur la version transcodée.",
        en: "When coming back to the app after a long sleep, a film resumes in the usual player instead of switching to the transcoded version.",
        es: "Al volver a la aplicación tras un largo reposo, la película se reanuda en el reproductor habitual en lugar de pasar a la versión transcodificada.",
        de: "Bei der Rückkehr in die App nach längerem Ruhezustand wird ein Film im gewohnten Player fortgesetzt, statt zur transkodierten Version zu wechseln.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.3.11",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Le logo du titre s'affiche aussi dans le lecteur des téléviseurs, d'AirPlay et des fichiers transcodés.",
        en: "The title logo now also shows in the player used for TVs, AirPlay and transcoded files.",
        es: "El logotipo del título también aparece en el reproductor de los televisores, de AirPlay y de los archivos transcodificados.",
        de: "Das Titellogo erscheint jetzt auch im Player für Fernseher, AirPlay und transkodierte Dateien.",
      },
      {
        fr: "Après plus de dix minutes de pause, la lecture reprend cinq secondes plus tôt dans tous les cas, pour se remettre dans la scène.",
        en: "After a pause of more than ten minutes, playback now always resumes five seconds earlier, to get back into the scene.",
        es: "Tras más de diez minutos de pausa, la reproducción se reanuda siempre cinco segundos antes, para volver a la escena.",
        de: "Nach mehr als zehn Minuten Pause setzt die Wiedergabe jetzt immer fünf Sekunden früher ein, um wieder in die Szene zu finden.",
      },
      {
        fr: "Au clavier, les touches Début, Fin et Page précédente / suivante déplacent bien la lecture sur la barre de progression.",
        en: "On a keyboard, the Home, End and Page Up / Page Down keys now move playback on the progress bar.",
        es: "Con el teclado, las teclas Inicio, Fin y Re Pág / Av Pág ahora mueven la reproducción en la barra de progreso.",
        de: "Auf der Tastatur verschieben Pos1, Ende und Bild auf / Bild ab jetzt die Wiedergabe auf der Fortschrittsleiste.",
      },
    ],
  },
  {
    page: "9.1",
    version: "9.3.12",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Changer de sous-titres pendant qu'un fichier de sous-titres charge n'affiche plus d'avertissement pour un sous-titre qu'on n'a plus choisi.",
        en: "Changing subtitles while a subtitle file is loading no longer shows a warning about a subtitle you no longer chose.",
        es: "Cambiar de subtítulos mientras se carga un archivo de subtítulos ya no muestra un aviso sobre un subtítulo que ya no está elegido.",
        de: "Ein Untertitelwechsel, während eine Untertiteldatei lädt, zeigt keine Warnung mehr für einen nicht mehr gewählten Untertitel.",
      },
      {
        fr: "Les menus « Dialogues » et « Qualité » du lecteur ont désormais un titre, comme les autres.",
        en: "The player's \"Dialogue\" and \"Quality\" menus now have a title, like the others.",
        es: "Los menús «Diálogos» y «Calidad» del reproductor ahora tienen título, como los demás.",
        de: "Die Menüs „Dialoge“ und „Qualität“ des Players haben jetzt wie die anderen einen Titel.",
      },
    ],
  },
  {
    version: "10.0.0",
    page: "10.0",
    group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
    items: [
      {
        fr: "Fermer le lecteur pendant qu'un saut se charge garde la position visée : « Reprendre » repart au bon endroit.",
        en: "Closing the player while a jump is loading keeps the position you aimed for: \"Resume\" starts at the right place.",
        es: "Cerrar el reproductor mientras se carga un salto conserva la posición elegida: «Reanudar» empieza en el lugar correcto.",
        de: "Wird der Player geschlossen, während ein Sprung lädt, bleibt die gewählte Position erhalten: „Fortsetzen“ beginnt an der richtigen Stelle.",
      },
      {
        fr: "Fermer deux fois de suite le lecteur des téléchargements (double appui, Retour puis croix) ne le ferme plus qu'une fois.",
        en: "Closing the downloads player twice in a row (double tap, Back then the cross) now closes it only once.",
        es: "Cerrar dos veces seguidas el reproductor de descargas (doble toque, Atrás y luego la cruz) ya solo lo cierra una vez.",
        de: "Den Player für Downloads zweimal hintereinander zu schließen (Doppeltippen, Zurück und dann das Kreuz) schließt ihn nur noch einmal.",
      },
    ],
  },
  {
    version: "10.0.0",
    page: "10.0",
    group: { fr: "Accueil et fiches", en: "Home and title pages", es: "Inicio y fichas", de: "Startseite und Titelseiten" },
    items: [
      {
        fr: "Sur ordinateur, la touche Retour arrière dans la fenêtre « Partager » efface une lettre au lieu de fermer la fiche.",
        en: "On a computer, Backspace in the \"Share\" window deletes a letter instead of closing the page.",
        es: "En el ordenador, la tecla Retroceso en la ventana «Compartir» borra una letra en lugar de cerrar la ficha.",
        de: "Am Computer löscht die Rücktaste im Fenster „Teilen“ einen Buchstaben, statt die Titelseite zu schließen.",
      },
      {
        fr: "Échap dans « Télécharger », la gestion d'un téléchargement ou « Partager » ne ferme que cette fenêtre, et les flèches restent dedans.",
        en: "Escape in \"Download\", a download's options or \"Share\" closes only that window, and the arrow keys stay inside it.",
        es: "Escape en «Descargar», las opciones de una descarga o «Compartir» solo cierra esa ventana, y las flechas se quedan dentro.",
        de: "Escape in „Herunterladen“, den Optionen eines Downloads oder „Teilen“ schließt nur dieses Fenster, und die Pfeiltasten bleiben darin.",
      },
      {
        fr: "« Lire le fichier téléchargé » reprend au bon endroit même quand le serveur ne répond pas.",
        en: "\"Play the downloaded file\" resumes at the right place even when the server does not answer.",
        es: "«Reproducir el archivo descargado» se reanuda en el lugar correcto aunque el servidor no responda.",
        de: "„Heruntergeladene Datei abspielen“ setzt an der richtigen Stelle fort, auch wenn der Server nicht antwortet.",
      },
      {
        fr: "« À voir » et « Vu » ont la même forme sur toutes les fiches, et « Vu » éteint dit « Marquer comme vu ».",
        en: "\"Watchlist\" and \"Watched\" look the same on every title page, and an unset \"Watched\" says \"Mark as watched\".",
        es: "«Por ver» y «Visto» tienen la misma forma en todas las fichas, y «Visto» apagado dice «Marcar como visto».",
        de: "„Merkliste“ und „Gesehen“ sehen auf allen Titelseiten gleich aus, und ein ausgeschaltetes „Gesehen“ heißt „Als gesehen markieren“.",
      },
      {
        fr: "Un film inconnu de la base de films ne propose plus « À voir », qui renvoyait une erreur.",
        en: "A film unknown to the film database no longer offers \"Watchlist\", which returned an error.",
        es: "Una película desconocida para la base de películas ya no ofrece «Por ver», que devolvía un error.",
        de: "Ein Film, den die Filmdatenbank nicht kennt, bietet „Merkliste“ nicht mehr an, das einen Fehler zurückgab.",
      },
      {
        fr: "Le bouton Lire d'une série ne lance plus un épisode dont le fichier a disparu.",
        en: "A series' Play button no longer starts an episode whose file has gone missing.",
        es: "El botón Reproducir de una serie ya no inicia un episodio cuyo archivo ha desaparecido.",
        de: "Die Abspieltaste einer Serie startet keine Folge mehr, deren Datei verschwunden ist.",
      },
    ],
  },
  {
    version: "10.0.0",
    page: "10.0",
    group: { fr: "Téléphone et tablette", en: "Phone and tablet", es: "Móvil y tableta", de: "Handy und Tablet" },
    items: [
      {
        fr: "La pastille « Partager » d'une série reste visible même si l'épisode à suivre a perdu son fichier.",
        en: "A series' \"Share\" badge stays visible even if the next episode has lost its file.",
        es: "La pastilla «Compartir» de una serie sigue visible aunque el siguiente episodio haya perdido su archivo.",
        de: "Das „Teilen“-Abzeichen einer Serie bleibt sichtbar, auch wenn die nächste Folge ihre Datei verloren hat.",
      },
      {
        fr: "La touche Retour arrière d'un clavier ferme aussi la fiche d'un titre.",
        en: "A keyboard's Backspace key also closes a title page.",
        es: "La tecla Retroceso de un teclado también cierra la ficha de un título.",
        de: "Die Rücktaste einer Tastatur schließt auch die Titelseite.",
      },
    ],
  },
];

/** « 8.64.1 » > « 8.64 » : comparées nombre par nombre, une partie absente valant 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * La page d'une entrée parmi les pages publiées : celle qu'elle nomme ; sinon la première dont la
 * version couvre la sienne ; sinon la dernière publiée. `null` sans aucune page — l'entrée attend.
 */
export function ledgerTarget<P extends { version: string; seq: number }>(entry: FixLedgerEntry, pages: readonly P[]): P | null {
  if (pages.length === 0) return null;
  const named = entry.page ? pages.find((p) => p.version === entry.page) : undefined;
  if (named) return named;
  const covering = pages.filter((p) => compareVersions(entry.version, p.version) <= 0).sort((a, b) => compareVersions(a.version, b.version))[0];
  return covering ?? [...pages].sort((a, b) => b.seq - a.seq)[0];
}

/** Une langue de la page, l'entrée ajoutée à son groupe (créé à la fin s'il manque) — sans doublon. */
function mergeInto(content: NewsContent, group: string, items: readonly string[]): NewsContent {
  const fixes = content.fixes.map((g) => ({ title: g.title, items: [...g.items] }));
  let target = fixes.find((g) => g.title === group);
  if (!target) {
    target = { title: group, items: [] };
    fixes.push(target);
  }
  for (const item of items) if (!target.items.includes(item)) target.items.push(item);
  return { ...content, fixes };
}

/** Le contenu d'une page, l'entrée ajoutée dans chaque langue qu'elle a ; une langue absente retombe sur le français. */
export function withLedgerEntry(content: NewsContentByLang, entry: FixLedgerEntry): NewsContentByLang {
  const next: NewsContentByLang = { ...content, fr: mergeInto(content.fr, entry.group.fr, entry.items.map((i) => i.fr)) };
  for (const lang of NEWS_LANGS) {
    if (lang === "fr") continue;
    const own = content[lang];
    if (own) next[lang] = mergeInto(own, entry.group[lang], entry.items.map((i) => i[lang]));
  }
  return next;
}

/** Le marqueur d'une entrée dans `migrations_done` : sa page, sa version, et ce qu'elle dit. */
export function ledgerMarker(entry: FixLedgerEntry, hash: (s: string) => string): string {
  return `news-fix:${entry.page ?? ""}:${entry.version}:${hash([entry.group.fr, ...entry.items.map((i) => i.fr)].join("\n"))}`;
}
