import type { NewsContent, NewsContentByLang, NewsLang } from "./content";
import { compareVersions, FIXES_LEDGER } from "./fixesLedger";

/**
 * La page « 10.5 » — ce que les versions 10.1 à 10.5 ont changé pour tout le monde (27/10/2026).
 *
 * **Discrète** (`seedQuietNewsPage`, DECISIONS.md §73) : publiée sur toute installation, consultable
 * dans Compte → Nouveautés, mais la fenêtre ne s'ouvre pour personne — consigne de Louis : la mettre à
 * jour, pas la republier. Ne cite ni les titres masqués, ni ce qui ne concerne que l'administrateur
 * (le Stream Deck), ni le changement d'adresse, propre à une seule installation (page « 10.0 »).
 *
 * Les corrections sont celles du registre (`fixesLedger.ts`) depuis la 10.1, au mot près : sur une
 * installation où le registre les verse ensuite dans cette page, `withLedgerEntry` ne double rien.
 */
export const NEWS_105_VERSION = "10.5";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_105_SEED = "news-seed-10.5-discrete";
/** Les corrections reprises du registre : à partir de cette version. */
const FIXES_FROM = "10.1";

/** Les corrections du registre depuis `FIXES_FROM`, par groupe, dans l'ordre où elles sont livrées. */
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

export const NEWS_105_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau",
        entries: [
          {
            icon: "next",
            title: "L'écran de l'épisode suivant",
            text: "À la fin d'un épisode, l'image se réduit et le suivant est mis en avant. « Regarder le générique » le laisse défiler, avec un bouton discret pour passer à la suite.",
            badge: "",
          },
          {
            icon: "bell",
            title: "« Votre demande est disponible »",
            text: "La notification arrive dans la langue de votre appareil, titre compris, quelques minutes après l'arrivée du film ou de la série.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Les notifications dans l'app installée",
            text: "Si elles ne sont pas activées, l'app installée vous propose une fois de le faire.",
            badge: "",
          },
          {
            icon: "palette",
            title: "Une nouvelle allure",
            text: "Un nouveau logo, une nouvelle police pour les titres, et une touche d'or pour ce qui est à vous : votre liste, vos reprises.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Ouverture plus rapide sur les appareils Apple, diffusion plus fiable.",
    fixes: ledgerFixes("fr"),
  },
  en: {
    sections: [
      {
        title: "New",
        entries: [
          {
            icon: "next",
            title: "The next episode screen",
            text: "At the end of an episode, the picture shrinks and the next one takes the spotlight. “Watch credits” lets them roll, with a discreet button to move on.",
            badge: "",
          },
          {
            icon: "bell",
            title: "“Your request is available”",
            text: "The notification arrives in your device's language, title included, a few minutes after the film or series arrives.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Notifications in the installed app",
            text: "If they are off, the installed app offers once to turn them on.",
            badge: "",
          },
          {
            icon: "palette",
            title: "A new look",
            text: "A new logo, a new typeface for titles, and a touch of gold for what is yours: your list, your resumes.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Faster launch on Apple devices, more reliable casting.",
    fixes: ledgerFixes("en"),
  },
  es: {
    sections: [
      {
        title: "Novedades",
        entries: [
          {
            icon: "next",
            title: "La pantalla del siguiente episodio",
            text: "Al final de un episodio, la imagen se reduce y el siguiente pasa a primer plano. «Ver los créditos» los deja correr, con un botón discreto para continuar.",
            badge: "",
          },
          {
            icon: "bell",
            title: "«Tu solicitud está disponible»",
            text: "La notificación llega en el idioma de su dispositivo, título incluido, unos minutos después de la llegada de la película o la serie.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Las notificaciones en la app instalada",
            text: "Si no están activadas, la app instalada le propone una vez activarlas.",
            badge: "",
          },
          {
            icon: "palette",
            title: "Un nuevo aspecto",
            text: "Un nuevo logotipo, una nueva tipografía para los títulos y un toque dorado para lo que es suyo: su lista, sus reanudaciones.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Apertura más rápida en dispositivos Apple, emisión más fiable.",
    fixes: ledgerFixes("es"),
  },
  de: {
    sections: [
      {
        title: "Neu",
        entries: [
          {
            icon: "next",
            title: "Der Bildschirm der nächsten Folge",
            text: "Am Ende einer Folge wird das Bild verkleinert und die nächste Folge hervorgehoben. „Abspann ansehen“ lässt ihn laufen, mit einer unauffälligen Schaltfläche zum Weitermachen.",
            badge: "",
          },
          {
            icon: "bell",
            title: "„Ihre Anfrage ist verfügbar“",
            text: "Die Benachrichtigung kommt in der Sprache Ihres Geräts, Titel inbegriffen, wenige Minuten nachdem der Film oder die Serie eingetroffen ist.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Benachrichtigungen in der installierten App",
            text: "Sind sie ausgeschaltet, schlägt Ihnen die installierte App einmal vor, sie einzuschalten.",
            badge: "",
          },
          {
            icon: "palette",
            title: "Ein neues Aussehen",
            text: "Ein neues Logo, eine neue Schrift für die Titel und ein goldener Akzent für das, was Ihnen gehört: Ihre Liste, Ihre fortgesetzten Titel.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Schnellerer Start auf Apple-Geräten, zuverlässigere Übertragung.",
    fixes: ledgerFixes("de"),
  },
};
