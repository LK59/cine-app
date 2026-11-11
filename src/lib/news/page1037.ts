import type { NewsContent, NewsContentByLang, NewsLang } from "./content";

/**
 * La page « 10.37 » — ce que les versions 10.14 à 10.37 ont changé pour tout le monde (11/11/2026).
 *
 * **Discrète** (`seedQuietNewsPage`, DECISIONS.md §73), comme la 10.5 : publiée sur toute installation,
 * consultable dans Compte → Nouveautés, sans que la fenêtre s'ouvre pour personne (Louis : remplir
 * l'historique sans annonce). N'y figure que ce que chaque compte a déjà : « Précédemment » (§137,
 * ouvert à tous les comptes depuis 10.23) et les fiches du bureau en une page (§117.4, 10.27). La
 * recherche par description est déjà sur la page 10.13. Restent hors de cette page, exprès : « À l'écran »,
 * les questions et « Jusqu'ici », réservés aux administrateurs jusqu'à leur ouverture (brouillon « 10.33 »,
 * que Louis publiera avec la fenêtre) ; « Revenir au début de la scène », coupé (« Lab bêta ») ; le mode
 * caché ; et tout ce qui ne touche que l'administration. Pas de corrections propres : elles viennent du
 * registre (`fixesLedger.ts`).
 */
export const NEWS_1037_VERSION = "10.37";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_1037_SEED = "news-seed-10.37-discrete";

export const NEWS_1037_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Séries",
        entries: [
          {
            icon: "next",
            title: "Précédemment",
            text: "Sur la fiche d'une série en cours, un court rappel des derniers faits que vous avez vus, préparé pendant votre absence. Il se coupe dans les réglages de votre compte.",
            badge: "",
          },
        ],
      },
      {
        title: "Fiches",
        entries: [
          {
            icon: "sheets",
            title: "Une fiche en une page",
            text: "Sur ordinateur, « Vu » et « Ma liste » deviennent des boutons ronds, et la fiche d'un titre tient en une page, sans défiler.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Cette mise à jour ajoute « Précédemment » aux séries et resserre les fiches sur ordinateur.",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "Series",
        entries: [
          {
            icon: "next",
            title: "Previously",
            text: "On the page of a series you are watching, a short reminder of the latest events you have seen, prepared while you were away. You can turn it off in your account settings.",
            badge: "",
          },
        ],
      },
      {
        title: "Title pages",
        entries: [
          {
            icon: "sheets",
            title: "A title on one page",
            text: "On a computer, “Watched” and “My list” become round buttons, and a title's page fits on one screen, without scrolling.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "This update adds “Previously” to series and tightens title pages on computers.",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Series",
        entries: [
          {
            icon: "next",
            title: "Anteriormente",
            text: "En la ficha de una serie que está viendo, un breve recordatorio de los últimos hechos que ha visto, preparado durante su ausencia. Puede desactivarlo en los ajustes de su cuenta.",
            badge: "",
          },
        ],
      },
      {
        title: "Fichas",
        entries: [
          {
            icon: "sheets",
            title: "Una ficha en una página",
            text: "En el ordenador, «Visto» y «Mi lista» pasan a ser botones redondos, y la ficha de un título cabe en una página, sin desplazarse.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Esta actualización añade «Anteriormente» a las series y ajusta las fichas en el ordenador.",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Serien",
        entries: [
          {
            icon: "next",
            title: "Bisher",
            text: "Auf der Seite einer Serie, die Sie gerade sehen, eine kurze Erinnerung an die zuletzt gesehenen Ereignisse, vorbereitet während Ihrer Abwesenheit. Sie können sie in Ihren Kontoeinstellungen ausschalten.",
            badge: "",
          },
        ],
      },
      {
        title: "Titelseiten",
        entries: [
          {
            icon: "sheets",
            title: "Ein Titel auf einer Seite",
            text: "Am Computer werden „Gesehen“ und „Meine Liste“ zu runden Schaltflächen, und die Seite eines Titels passt auf einen Bildschirm, ohne zu scrollen.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Dieses Update fügt „Bisher“ zu Serien hinzu und strafft die Titelseiten am Computer.",
    fixes: [],
  },
};

/**
 * Le contenu semé sur une installation : « Précédemment » seulement là où l'option est allumée (chasse aux défauts
 * du 11/11/2026) — l'image publique la livre coupée (`RECAP_ENABLED`), et la page l'annonçait avec son réglage.
 */
export function news1037Content(recapEnabled: boolean): NewsContentByLang {
  if (recapEnabled) return NEWS_1037_CONTENT;
  const without = (lang: NewsLang): NewsContent | null => {
    const content = NEWS_1037_CONTENT[lang];
    if (!content) return null;
    const sections = content.sections.filter((section) => !section.entries.some((e) => e.icon === "next"));
    return { ...content, sections, fixesSummary: FIXES_SUMMARY_WITHOUT_RECAP[lang] };
  };
  return { fr: without("fr")!, en: without("en"), es: without("es"), de: without("de") };
}

const FIXES_SUMMARY_WITHOUT_RECAP: Record<NewsLang, string> = {
  fr: "Cette mise à jour resserre les fiches sur ordinateur.",
  en: "This update tightens title pages on computers.",
  es: "Esta actualización ajusta las fichas en el ordenador.",
  de: "Dieses Update strafft die Titelseiten am Computer.",
};
