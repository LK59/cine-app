import type { NewsContentByLang } from "./content";

/**
 * La page « 10.58 » — l'écran verrouillé du lecteur et le paysage tenu sur Android (18/11/2026).
 *
 * **Discrète** (`seedQuietNewsPage`, §73), comme les 10.5, 10.37, 10.40 et 10.43 : publiée sur toute installation,
 * consultable dans Compte → Nouveautés, sans que la fenêtre s'ouvre pour personne. Pour tous, sans réglage : rien à
 * filtrer. Pas de corrections propres : elles viennent du registre (`fixesLedger.ts`).
 */
export const NEWS_1058_VERSION = "10.58";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_1058_SEED = "news-seed-10.58-discrete";

export const NEWS_1058_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Lecteur",
        entries: [
          {
            icon: "phone",
            title: "Verrouiller l'écran",
            text: "Dans le menu « ⋯ » du lecteur, sur téléphone et tablette : plus aucun toucher n'agit sur le film. Touchez l'écran, puis deux fois le cadenas pour déverrouiller.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Le film reste en paysage sur Android",
            text: "en plein écran, même si le téléphone penche.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Cette mise à jour permet de verrouiller l'écran pendant un film.",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "Player",
        entries: [
          {
            icon: "phone",
            title: "Lock the screen",
            text: "In the player's “⋯” menu, on phones and tablets: no touch affects the film any more. Tap the screen, then the padlock twice to unlock.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Films stay in landscape on Android",
            text: "in full screen, even when the phone tilts.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "This update lets you lock the screen during a film.",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Reproductor",
        entries: [
          {
            icon: "phone",
            title: "Bloquear la pantalla",
            text: "En el menú «⋯» del reproductor, en móvil y tableta: ningún toque afecta ya a la película. Toque la pantalla y luego dos veces el candado para desbloquear.",
            badge: "",
          },
          {
            icon: "phone",
            title: "La película se queda en horizontal en Android",
            text: "a pantalla completa, aunque el móvil se incline.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Esta actualización permite bloquear la pantalla durante una película.",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Player",
        entries: [
          {
            icon: "phone",
            title: "Bildschirm sperren",
            text: "Im Menü „⋯“ des Players, auf Handy und Tablet: Keine Berührung wirkt mehr auf den Film. Tippen Sie auf den Bildschirm und dann zweimal auf das Schloss, um zu entsperren.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Filme bleiben unter Android im Querformat",
            text: "im Vollbild, auch wenn sich das Handy neigt.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "Mit diesem Update können Sie den Bildschirm während eines Films sperren.",
    fixes: [],
  },
};
