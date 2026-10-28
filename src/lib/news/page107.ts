import type { NewsContent, NewsContentByLang, NewsLang } from "./content";
import { compareVersions, FIXES_LEDGER } from "./fixesLedger";
import { laternaAddress } from "./pageLaterna";

/**
 * La page « 10.7 » — les livres (option, DECISIONS.md §127), et ce que la 10.5.6 et la 10.6 ont
 * rendu plus rapide (28/10/2026). Texte voulu par Louis : tout regroupé en une page, pour sa seule
 * installation.
 *
 * **Une seule installation la reçoit**, comme la page du renommage : celle qui annonce sa nouvelle
 * adresse (`NEWS_LATERNA_ADDRESS`). Les livres sont une option coupée par défaut ; une autre
 * installation de l'image publique n'en a pas, et ses comptes liraient une nouveauté qu'ils n'ont pas.
 *
 * **En brouillon** : Louis la publie depuis Activité → Nouveautés le soir où il allume l'option.
 * « Demander un livre » y figure : à retirer dans l'éditeur si les demandes restent coupées.
 *
 * Ne cite ni les titres masqués, ni rien de la fabrication (index, métadonnées, formats internes).
 */
export const NEWS_107_VERSION = "10.7";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_107_SEED = "news-seed-10.7-livres";
/** Le brouillon complété le soir même (signets, recherche, hors ligne), avant publication : `refreshNewsDraft`. */
export const NEWS_107_REFRESH = "news-refresh-10.7-livres-signets";
/** Les corrections reprises du registre : à partir de cette version (ce que la page 10.5 n'annonçait pas). */
const FIXES_FROM = "10.5.6";

function ledgerFixes(lang: NewsLang): NewsContent["fixes"] {
  const groups: NewsContent["fixes"] = [];
  for (const entry of FIXES_LEDGER) {
    if (compareVersions(entry.version, FIXES_FROM) < 0) continue;
    const title = entry.group[lang];
    let group = groups.find((g) => g.title === title);
    if (!group) {
      group = { title, items: [] };
      groups.push(group);
    }
    for (const item of entry.items) if (!group.items.includes(item[lang])) group.items.push(item[lang]);
  }
  return groups;
}

export const NEWS_107_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau : les livres",
        entries: [
          {
            icon: "sparkles",
            title: "Les livres arrivent",
            text: "Une troisième catégorie à côté des Films et des Séries : des milliers de romans, rangés par série, par auteur et par genre.",
            badge: "",
          },
          {
            icon: "palette",
            title: "Un lecteur à votre goût",
            text: "Taille du texte avec « A » et « A » ou en pinçant, police, interligne, marges, thèmes clair, sépia, sombre et noir, page qui tourne ou qui glisse, une ou deux pages.",
            badge: "",
          },
          {
            icon: "next",
            title: "Votre lecture vous suit",
            text: "Le livre rouvre à la bonne page, sur tous vos appareils, et « Continuer la lecture » vous attend en haut.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Signets, recherche et hors ligne",
            text: "Marquez une page d'un signet, cherchez un mot dans tout le livre, et téléchargez-le pour le lire sans réseau.",
            badge: "",
          },
          {
            icon: "search",
            title: "Tout se retrouve",
            text: "La recherche trouve aussi les livres, sous les films et les séries. « Tout voir » trie et filtre par genre, auteur ou série.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Demander un livre",
            text: "Il vous manque un livre ? Demandez-le, et vous serez prévenu quand il arrive.",
            badge: "",
          },
          {
            icon: "sheets",
            title: "Pas lecteur ?",
            text: "Dans votre Compte, « Afficher les livres » retire la catégorie.",
            badge: "",
          },
        ],
      },
      {
        title: "Plus rapide",
        entries: [
          {
            icon: "speed",
            title: "Les films démarrent plus vite",
            text: "La fiche prépare le début du film pendant que vous la lisez : la lecture part presque aussitôt.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Image dans l'image",
            text: "Sur ordinateur et sur Android, gardez le film à l'écran pendant que vous faites autre chose.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Des notifications plus sûres",
            text: "Sur iPhone et iPad, elles arrivent même quand l'app n'a pas pu se réveiller à temps.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Démarrage plus rapide, notifications plus fiables.",
    fixes: ledgerFixes("fr"),
  },
  en: {
    sections: [
      {
        title: "New: books",
        entries: [
          {
            icon: "sparkles",
            title: "Books are here",
            text: "A third category next to Films and Series: thousands of novels, sorted by series, author and genre.",
            badge: "",
          },
          {
            icon: "palette",
            title: "A reader made your way",
            text: "Text size with “A” and “A” or a pinch, font, line spacing, margins, light, sepia, dark and black themes, pages that turn or slide, one or two pages.",
            badge: "",
          },
          {
            icon: "next",
            title: "Your reading follows you",
            text: "The book reopens at the right page on all your devices, and “Continue reading” waits for you at the top.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Bookmarks, search and offline",
            text: "Bookmark a page, search a word across the whole book, and download it to read without a connection.",
            badge: "",
          },
          {
            icon: "search",
            title: "Everything is easy to find",
            text: "Search finds books too, below films and series. “See all” sorts and filters by genre, author or series.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Request a book",
            text: "Missing a book? Request it, and you will be told when it arrives.",
            badge: "",
          },
          {
            icon: "sheets",
            title: "Not a reader?",
            text: "In your Account, “Show books” removes the category.",
            badge: "",
          },
        ],
      },
      {
        title: "Faster",
        entries: [
          {
            icon: "speed",
            title: "Films start sooner",
            text: "The title page prepares the start of the film while you read it: playback begins almost at once.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Picture in Picture",
            text: "On computers and Android, keep the film on screen while you do something else.",
            badge: "",
          },
          {
            icon: "bell",
            title: "More reliable notifications",
            text: "On iPhone and iPad, they arrive even when the app could not wake up in time.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Faster start, more reliable notifications.",
    fixes: ledgerFixes("en"),
  },
  es: {
    sections: [
      {
        title: "Nuevo: los libros",
        entries: [
          {
            icon: "sparkles",
            title: "Llegan los libros",
            text: "Una tercera categoría junto a Películas y Series: miles de novelas, ordenadas por serie, autor y género.",
            badge: "",
          },
          {
            icon: "palette",
            title: "Un lector a su gusto",
            text: "Tamaño del texto con «A» y «A» o pellizcando, tipo de letra, interlineado, márgenes, temas claro, sepia, oscuro y negro, páginas que pasan o se deslizan, una o dos páginas.",
            badge: "",
          },
          {
            icon: "next",
            title: "Su lectura le sigue",
            text: "El libro se abre en la página correcta en todos sus dispositivos, y «Seguir leyendo» le espera arriba.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Marcadores, búsqueda y sin conexión",
            text: "Marque una página, busque una palabra en todo el libro y descárguelo para leerlo sin conexión.",
            badge: "",
          },
          {
            icon: "search",
            title: "Todo se encuentra",
            text: "La búsqueda también encuentra libros, debajo de las películas y las series. «Ver todo» ordena y filtra por género, autor o serie.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Solicitar un libro",
            text: "¿Le falta un libro? Solicítelo y se le avisará cuando llegue.",
            badge: "",
          },
          {
            icon: "sheets",
            title: "¿No es lector?",
            text: "En su Cuenta, «Mostrar los libros» quita la categoría.",
            badge: "",
          },
        ],
      },
      {
        title: "Más rápido",
        entries: [
          {
            icon: "speed",
            title: "Las películas arrancan antes",
            text: "La ficha prepara el inicio de la película mientras la lee: la reproducción empieza casi al instante.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Imagen en imagen",
            text: "En ordenador y en Android, mantenga la película en pantalla mientras hace otra cosa.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Notificaciones más fiables",
            text: "En iPhone y iPad llegan incluso cuando la app no ha podido activarse a tiempo.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Arranque más rápido, notificaciones más fiables.",
    fixes: ledgerFixes("es"),
  },
  de: {
    sections: [
      {
        title: "Neu: Bücher",
        entries: [
          {
            icon: "sparkles",
            title: "Die Bücher sind da",
            text: "Eine dritte Kategorie neben Filmen und Serien: Tausende Romane, geordnet nach Reihe, Autor und Genre.",
            badge: "",
          },
          {
            icon: "palette",
            title: "Ein Leser nach Ihrem Geschmack",
            text: "Textgröße mit „A“ und „A“ oder per Fingergeste, Schrift, Zeilenabstand, Ränder, helles, Sepia-, dunkles und schwarzes Design, Seiten, die umblättern oder gleiten, eine oder zwei Seiten.",
            badge: "",
          },
          {
            icon: "next",
            title: "Ihre Lektüre begleitet Sie",
            text: "Das Buch öffnet sich auf allen Ihren Geräten an der richtigen Seite, und „Weiterlesen“ wartet oben auf Sie.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Lesezeichen, Suche und offline",
            text: "Setzen Sie Lesezeichen, suchen Sie ein Wort im ganzen Buch und laden Sie es herunter, um es ohne Verbindung zu lesen.",
            badge: "",
          },
          {
            icon: "search",
            title: "Alles ist schnell gefunden",
            text: "Die Suche findet auch Bücher, unter Filmen und Serien. „Alle anzeigen“ sortiert und filtert nach Genre, Autor oder Reihe.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Ein Buch wünschen",
            text: "Fehlt Ihnen ein Buch? Wünschen Sie es sich, und Sie werden benachrichtigt, sobald es da ist.",
            badge: "",
          },
          {
            icon: "sheets",
            title: "Keine Leseratte?",
            text: "In Ihrem Konto blendet „Bücher anzeigen“ die Kategorie aus.",
            badge: "",
          },
        ],
      },
      {
        title: "Schneller",
        entries: [
          {
            icon: "speed",
            title: "Filme starten schneller",
            text: "Die Titelseite bereitet den Anfang des Films vor, während Sie sie lesen: Die Wiedergabe beginnt fast sofort.",
            badge: "",
          },
          {
            icon: "tv",
            title: "Bild-in-Bild",
            text: "Auf dem Computer und unter Android bleibt der Film sichtbar, während Sie etwas anderes tun.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Zuverlässigere Benachrichtigungen",
            text: "Auf iPhone und iPad kommen sie auch an, wenn die App nicht rechtzeitig aktiv werden konnte.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Schnellerer Start, zuverlässigere Benachrichtigungen.",
    fixes: ledgerFixes("de"),
  },
};

/** La page, sur la seule installation qui annonce sa nouvelle adresse ; `null` partout ailleurs. */
export function booksNewsPage(rawAddress: string | null | undefined): { seed: string; refresh: string; version: string; content: NewsContentByLang } | null {
  return laternaAddress(rawAddress) ? { seed: NEWS_107_SEED, refresh: NEWS_107_REFRESH, version: NEWS_107_VERSION, content: NEWS_107_CONTENT } : null;
}
