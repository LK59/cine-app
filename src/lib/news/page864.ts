import type { NewsContentByLang } from "./content";

/**
 * La page « 8.64 » — texte validé par Louis le 15/10/2026 : les corrections de la passe de test de la
 * nuit du 14 au 15/10 (plus de 70 défauts), sans section « Nouveau ». Publiée par le code au démarrage
 * (`seedNewsPage`, db.ts), donc sur toute installation qui passe à cette image : Louis a demandé
 * qu'elle apparaisse partout. Sur l'installation de Louis, publiée à la main le même jour depuis le
 * brouillon : son marqueur y est déjà posé, elle n'est pas recréée.
 *
 * Ne pas y mentionner les titres masqués (voulu par Louis), ni rien de la fabrication interne.
 */
export const NEWS_864_VERSION = "8.64";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_864_SEED = "news-seed-8.64";

export const NEWS_864_CONTENT: NewsContentByLang = {
  "fr": {
    "sections": [],
    "fixesSummary": "Plus de 70 défauts corrigés : lecture plus fiable, navigation plus sûre, mobile plus agréable.",
    "fixes": [
      {
        "title": "Lecture",
        "items": [
          "« Passer l'intro » fonctionne de nouveau, à la souris comme au doigt.",
          "Le geste Retour ferme le lecteur, comme la croix, au lieu de la fiche cachée derrière.",
          "Le curseur du volume répond de nouveau, et l'icône du son reste sous la souris.",
          "Une coupure réseau en plein film est annoncée à l'écran, et la lecture reprend seule au retour du réseau.",
          "Une coupure trop longue se termine sur un écran clair au lieu d'une image figée.",
          "Le temps passé sur une image figée ne compte plus comme regardé.",
          "Un fichier abîmé ne coupe plus le film : un relais prend la suite au bon moment.",
          "La qualité n'est plus réduite à tort sur certains ordinateurs et téléphones Android.",
          "Les reprises sur ordinateur, Android et Fire TV démarrent plus vite.",
          "Sur une connexion lente, le film démarre avant les aperçus de la barre.",
          "« Connexion instable » ne s'allume plus quand c'est l'appareil qui ralentit.",
          "L'écran « chargement trop long » ne reste plus affiché sur un film qui joue.",
          "Dans les menus du lecteur, l'option cochée est toujours visible.",
          "Plusieurs relais inutiles vers une autre version du film évités."
        ]
      },
      {
        "title": "Navigation",
        "items": [
          "« Demander » se confirme avant de lancer quoi que ce soit.",
          "Les nouveaux films apparaissent, et les films retirés disparaissent, sans relancer l'app.",
          "La recherche pardonne deux lettres inversées : « matirx » trouve Matrix.",
          "« / » ouvre la recherche avec le curseur dans le champ.",
          "Navigation au clavier corrigée dans la grille complète, Ma liste, les fiches et les épisodes.",
          "Échap ne referme plus un panneau caché sous le film.",
          "Un double-clic sur une affiche n'ouvre plus le synopsis par erreur.",
          "Un titre ou une personne introuvable l'indique clairement.",
          "La page de connexion garde votre langue.",
          "Les tailles s'affichent dans votre langue : « 56,5 Mo ».",
          "Les genres sont tous traduits.",
          "L'app vous vouvoie partout, en français comme en allemand."
        ]
      },
      {
        "title": "Téléphone et tablette",
        "items": [
          "Sur Android, toucher une affiche ne lance plus le film par erreur.",
          "Sur iPad, le bouton « Séries » répond de nouveau en portrait.",
          "La barre du bas revient toujours, même en remontant doucement.",
          "La bannière « Installer » ne recouvre plus la barre du bas.",
          "Recherche, Ma liste et Compte s'ouvrent même sans réseau, et l'app revient seule quand le réseau revient.",
          "Les épisodes à venir n'affichent plus « TBA ».",
          "Boutons plus faciles à toucher, menus qui ne débordent plus sur petit écran."
        ]
      },
      {
        "title": "Sécurité et fiabilité",
        "items": [
          "Mises à jour de sécurité des briques de l'app.",
          "Les écrans d'administration sont strictement réservés aux administrateurs."
        ]
      }
    ]
  },
  "en": {
    "sections": [],
    "fixesSummary": "Over 70 defects fixed: more reliable playback, safer navigation, a nicer mobile experience.",
    "fixes": [
      {
        "title": "Playback",
        "items": [
          "“Skip intro” works again, with a mouse or a finger.",
          "The Back gesture closes the player, like the close button, instead of the sheet hidden behind it.",
          "The volume slider responds again, and the sound icon stays under the mouse.",
          "A network drop mid-film is shown on screen, and playback resumes on its own when the network returns.",
          "An outage that lasts too long ends on a clear screen instead of a frozen picture.",
          "Time spent on a frozen picture no longer counts as watched.",
          "A damaged file no longer stops the film: a relay takes over at the right moment.",
          "Quality is no longer wrongly lowered on some computers and Android phones.",
          "Resuming on computers, Android and Fire TV starts faster.",
          "On a slow connection, the film starts before the seek-bar previews.",
          "“Unstable connection” no longer lights up when it's the device slowing down.",
          "The “taking too long” screen no longer stays over a film that is playing.",
          "In the player menus, the checked option is always visible.",
          "Several needless switches to another version of the film avoided."
        ]
      },
      {
        "title": "Navigation",
        "items": [
          "“Request” now asks for confirmation before starting anything.",
          "New films appear, and removed ones disappear, without restarting the app.",
          "Search forgives two swapped letters: “matirx” finds Matrix.",
          "“/” opens search with the cursor in the field.",
          "Keyboard navigation fixed in the full grid, My list, sheets and episodes.",
          "Escape no longer closes a panel hidden under the film.",
          "Double-clicking a poster no longer opens the synopsis by mistake.",
          "A title or person that can't be found now says so clearly.",
          "The sign-in page keeps your language.",
          "Sizes are shown in your language's format.",
          "All genres are translated."
        ]
      },
      {
        "title": "Phone and tablet",
        "items": [
          "On Android, touching a poster no longer starts the film by mistake.",
          "On iPad, the “Series” button responds again in portrait.",
          "The bottom bar always comes back, even when scrolling up slowly.",
          "The “Install” banner no longer covers the bottom bar.",
          "Search, My list and Account open even offline, and the app comes back on its own when the network returns.",
          "Upcoming episodes no longer show “TBA”.",
          "Easier-to-tap buttons, menus that no longer overflow on small screens."
        ]
      },
      {
        "title": "Security and reliability",
        "items": [
          "Security updates to the app's building blocks.",
          "Administration screens are strictly reserved for administrators."
        ]
      }
    ]
  },
  "es": {
    "sections": [],
    "fixesSummary": "Más de 70 fallos corregidos: reproducción más fiable, navegación más segura y un móvil más agradable.",
    "fixes": [
      {
        "title": "Reproducción",
        "items": [
          "«Saltar intro» vuelve a funcionar, con el ratón o con el dedo.",
          "El gesto Atrás cierra el reproductor, como la cruz, en lugar de la ficha oculta detrás.",
          "El control de volumen vuelve a responder, y el icono de sonido se queda bajo el ratón.",
          "Un corte de red en plena película se indica en pantalla, y la reproducción se reanuda sola al volver la red.",
          "Un corte demasiado largo termina en una pantalla clara en lugar de una imagen congelada.",
          "El tiempo con la imagen congelada ya no cuenta como visto.",
          "Un archivo dañado ya no corta la película: un relevo toma el control en el momento justo.",
          "La calidad ya no se reduce por error en algunos ordenadores y móviles Android.",
          "Las reanudaciones en ordenador, Android y Fire TV arrancan más rápido.",
          "Con una conexión lenta, la película empieza antes que las vistas previas de la barra.",
          "«Conexión inestable» ya no se enciende cuando es el dispositivo el que va lento.",
          "La pantalla «carga demasiado larga» ya no se queda sobre una película que se reproduce.",
          "En los menús del reproductor, la opción marcada siempre está visible.",
          "Se evitan varios relevos innecesarios a otra versión de la película."
        ]
      },
      {
        "title": "Navegación",
        "items": [
          "«Solicitar» pide confirmación antes de iniciar nada.",
          "Las películas nuevas aparecen, y las retiradas desaparecen, sin reiniciar la app.",
          "La búsqueda perdona dos letras invertidas: «matirx» encuentra Matrix.",
          "«/» abre la búsqueda con el cursor en el campo.",
          "Navegación con teclado corregida en la cuadrícula completa, Mi lista, las fichas y los episodios.",
          "Escape ya no cierra un panel oculto bajo la película.",
          "Un doble clic en un póster ya no abre la sinopsis por error.",
          "Un título o una persona que no se encuentra lo indica claramente.",
          "La página de inicio de sesión conserva tu idioma.",
          "Los tamaños se muestran en el formato de tu idioma.",
          "Todos los géneros están traducidos."
        ]
      },
      {
        "title": "Móvil y tableta",
        "items": [
          "En Android, tocar un póster ya no lanza la película por error.",
          "En iPad, el botón «Series» vuelve a responder en vertical.",
          "La barra inferior siempre vuelve, incluso al subir despacio.",
          "El banner «Instalar» ya no tapa la barra inferior.",
          "Búsqueda, Mi lista y Cuenta se abren incluso sin red, y la app vuelve sola cuando regresa la red.",
          "Los próximos episodios ya no muestran «TBA».",
          "Botones más fáciles de tocar y menús que ya no se desbordan en pantallas pequeñas."
        ]
      },
      {
        "title": "Seguridad y fiabilidad",
        "items": [
          "Actualizaciones de seguridad de los componentes de la app.",
          "Las pantallas de administración quedan reservadas estrictamente a los administradores."
        ]
      }
    ]
  },
  "de": {
    "sections": [],
    "fixesSummary": "Über 70 Fehler behoben: zuverlässigere Wiedergabe, sicherere Navigation, angenehmer auf dem Handy.",
    "fixes": [
      {
        "title": "Wiedergabe",
        "items": [
          "„Intro überspringen“ funktioniert wieder, mit Maus oder Finger.",
          "Die Zurück-Geste schließt den Player wie das Kreuz, statt der dahinter verborgenen Seite.",
          "Der Lautstärkeregler reagiert wieder, und das Tonsymbol bleibt unter der Maus.",
          "Ein Netzausfall mitten im Film wird angezeigt, und die Wiedergabe setzt von selbst fort, sobald das Netz zurück ist.",
          "Ein zu langer Ausfall endet mit einem klaren Hinweis statt eines eingefrorenen Bildes.",
          "Zeit mit eingefrorenem Bild zählt nicht mehr als gesehen.",
          "Eine beschädigte Datei bricht den Film nicht mehr ab: Ein Ersatz übernimmt im richtigen Moment.",
          "Die Qualität wird auf manchen Computern und Android-Handys nicht mehr fälschlich gesenkt.",
          "Fortsetzen auf Computer, Android und Fire TV startet schneller.",
          "Bei langsamer Verbindung startet der Film vor den Vorschaubildern der Leiste.",
          "„Instabile Verbindung“ leuchtet nicht mehr auf, wenn das Gerät selbst langsam ist.",
          "Der Hinweis „Laden dauert zu lange“ bleibt nicht mehr über einem laufenden Film.",
          "In den Player-Menüs ist die gewählte Option immer sichtbar.",
          "Mehrere unnötige Wechsel zu einer anderen Fassung des Films vermieden."
        ]
      },
      {
        "title": "Navigation",
        "items": [
          "„Anfragen“ fragt vor dem Start nach einer Bestätigung.",
          "Neue Filme erscheinen und entfernte verschwinden, ohne die App neu zu starten.",
          "Die Suche verzeiht zwei vertauschte Buchstaben: „matirx“ findet Matrix.",
          "„/“ öffnet die Suche mit dem Cursor im Feld.",
          "Tastaturnavigation im vollständigen Raster, in Meine Liste, auf Detailseiten und bei Episoden korrigiert.",
          "Escape schließt kein Fenster mehr, das unter dem Film verborgen ist.",
          "Ein Doppelklick auf ein Poster öffnet die Inhaltsangabe nicht mehr versehentlich.",
          "Ein nicht auffindbarer Titel oder eine Person wird klar benannt.",
          "Die Anmeldeseite behält Ihre Sprache.",
          "Größen werden im Format Ihrer Sprache angezeigt.",
          "Alle Genres sind übersetzt.",
          "Die App siezt Sie jetzt durchgehend."
        ]
      },
      {
        "title": "Handy und Tablet",
        "items": [
          "Auf Android startet das Antippen eines Posters den Film nicht mehr versehentlich.",
          "Auf dem iPad reagiert die Schaltfläche „Serien“ im Hochformat wieder.",
          "Die untere Leiste kommt immer zurück, auch beim langsamen Hochscrollen.",
          "Das Banner „Installieren“ verdeckt die untere Leiste nicht mehr.",
          "Suche, Meine Liste und Konto öffnen sich auch ohne Netz, und die App kehrt von selbst zurück, sobald das Netz wieder da ist.",
          "Kommende Episoden zeigen nicht mehr „TBA“ an.",
          "Leichter zu tippende Schaltflächen, Menüs, die auf kleinen Bildschirmen nicht mehr überlaufen."
        ]
      },
      {
        "title": "Sicherheit und Zuverlässigkeit",
        "items": [
          "Sicherheitsupdates für die Bausteine der App.",
          "Die Verwaltungsseiten sind strikt den Administratoren vorbehalten."
        ]
      }
    ]
  }
};
