import type { NewsContentByLang } from "./content";

/**
 * La page « 10.40 » — les sous-titres d'un passage rejoué (DECISIONS.md §150, 13/11/2026).
 *
 * **Discrète** (`seedQuietNewsPage`, §73), comme les 10.5 et 10.37 : publiée sur toute installation, consultable
 * dans Compte → Nouveautés, sans que la fenêtre s'ouvre pour personne. La fonction est pour tous, sans réglage :
 * aucune condition à poser sur le contenu. Pas de corrections propres : elles viennent du registre
 * (`fixesLedger.ts`).
 */
export const NEWS_1040_VERSION = "10.40";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_1040_SEED = "news-seed-10.40-discrete";

export const NEWS_1040_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Lecture",
        entries: [
          {
            icon: "captions",
            title: "Sous-titres pour le passage rejoué",
            text: "Vous reculez de 10 secondes parce qu'une réplique vous a échappé ? Le passage repasse sous-titré dans la langue que vous entendez, puis les sous-titres s'en vont d'eux-mêmes. Touchez « Sous-titres pour ce passage » pour les garder.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Cette mise à jour sous-titre le passage que vous rejouez avec −10 s.",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "Playback",
        entries: [
          {
            icon: "captions",
            title: "Subtitles for a replayed passage",
            text: "Going back 10 seconds because you missed a line? The passage replays with subtitles in the language you are hearing, then they turn themselves off. Tap “Subtitles for this passage” to keep them on.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "This update subtitles the passage you replay with −10 s.",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Reproducción",
        entries: [
          {
            icon: "captions",
            title: "Subtítulos para el fragmento repetido",
            text: "¿Retrocede 10 segundos porque se le escapó una frase? El fragmento se repite con subtítulos en el idioma que está escuchando y luego se quitan solos. Toque «Subtítulos para este fragmento» para mantenerlos.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Esta actualización subtitula el fragmento que repite con −10 s.",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Wiedergabe",
        entries: [
          {
            icon: "captions",
            title: "Untertitel für die wiederholte Stelle",
            text: "Sie springen 10 Sekunden zurück, weil Ihnen ein Satz entgangen ist? Die Stelle läuft mit Untertiteln in der Sprache, die Sie hören, danach verschwinden sie von selbst. Tippen Sie auf „Untertitel für diese Stelle“, um sie beizubehalten.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Dieses Update untertitelt die Stelle, die Sie mit −10 s wiederholen.",
    fixes: [],
  },
};
