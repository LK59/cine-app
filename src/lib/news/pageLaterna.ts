import type { NewsContentByLang } from "./content";

/**
 * La page du renommage — CineApp devient Laterna, ses films sont lus par Lumen, et la nouvelle
 * adresse (l'ancienne continue de marcher). Texte du propriétaire (23/10/2026), traduit en en/es/de.
 * Préparée, **pas encore branchée** : rien ne l'appelle, elle n'existe sur aucune installation tant
 * que `db.ts` ne la sème pas (`seedNewsPage(db, NEWS_LATERNA_SEED, NEWS_LATERNA_VERSION,
 * NEWS_LATERNA_CONTENT)`, à côté des autres, DECISIONS.md §73 et §118).
 *
 * Vouvoiement voulu par le propriétaire : « vous » en français, « usted » en espagnol, « Sie » en
 * allemand, l'anglais neutre.
 * Ni nom de brique ni nom de client Jellyfin ici, ni vocabulaire d'infrastructure, ni titres masqués.
 *
 * `NEWS_LATERNA_VERSION` : la version qui livrera le renommage, à ajuster au moment de publier si ce
 * n'est pas celle-ci. L'adresse est écrite une fois (`NEW_ADDRESS`) : elle vaut pour l'installation
 * de référence, pas pour une autre — semée telle quelle, la page irait aussi aux installations de
 * l'image publique.
 */
export const NEWS_LATERNA_VERSION = "9.4";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_LATERNA_SEED = "news-seed-laterna";

const NEW_ADDRESS = "app.laterna.fr";

export const NEWS_LATERNA_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau",
        entries: [
          {
            icon: "sparkles",
            title: "CineApp devient Laterna",
            text: "Même cinéma, nouveau nom : Laterna, d'après la lanterne magique, l'ancêtre du cinéma. Les films sont lus par Lumen, son moteur de lecture.",
            badge: "",
          },
          {
            icon: "phone",
            title: `Une nouvelle adresse : ${NEW_ADDRESS}`,
            text: `L'ancienne adresse continue de fonctionner, rien ne presse. Pour passer à la nouvelle : ouvrez ${NEW_ADDRESS}, connectez-vous, ajoutez-la à votre écran d'accueil et supprimez l'ancienne icône.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "Sur cet appareil,",
            text: "il faudra refaire vos téléchargements et réactiver les notifications, ainsi que les réglages propres à l'appareil : langue, volume, style des sous-titres.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Votre historique, vos reprises, vos listes et vos films vus",
            text: "vous suivent.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Si possible,",
            text: "changez d'adresse quand aucun téléchargement n'est en cours.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
  en: {
    sections: [
      {
        title: "New",
        entries: [
          {
            icon: "sparkles",
            title: "CineApp becomes Laterna",
            text: "Same cinema, new name: Laterna, after the magic lantern, the ancestor of cinema. Films are played by Lumen, its playback engine.",
            badge: "",
          },
          {
            icon: "phone",
            title: `A new address: ${NEW_ADDRESS}`,
            text: `The old address keeps working, there's no rush. To switch to the new one: open ${NEW_ADDRESS}, sign in, add it to your home screen and delete the old icon.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "On this device,",
            text: "you'll need to redo your downloads and turn notifications back on, along with the device's own settings: language, volume, subtitle style.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Your history, where you left off, your lists and the films you've watched",
            text: "come with you.",
            badge: "",
          },
          {
            icon: "bell",
            title: "If you can,",
            text: "switch while no download is in progress.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
  es: {
    sections: [
      {
        title: "Novedades",
        entries: [
          {
            icon: "sparkles",
            title: "CineApp pasa a llamarse Laterna",
            text: "El mismo cine, un nombre nuevo: Laterna, por la linterna mágica, la antepasada del cine. Las películas las reproduce Lumen, su motor de reproducción.",
            badge: "",
          },
          {
            icon: "phone",
            title: `Una nueva dirección: ${NEW_ADDRESS}`,
            text: `La dirección antigua sigue funcionando, no hay prisa. Para pasar a la nueva: abra ${NEW_ADDRESS}, inicie sesión, añádala a su pantalla de inicio y borre el icono antiguo.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "En este dispositivo,",
            text: "tendrá que volver a hacer sus descargas y reactivar las notificaciones, además de los ajustes propios del dispositivo: idioma, volumen, estilo de los subtítulos.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Su historial, lo que estaba viendo, sus listas y sus películas vistas",
            text: "le acompañan.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Si puede,",
            text: "haga el cambio cuando no haya ninguna descarga en curso.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
  de: {
    sections: [
      {
        title: "Neu",
        entries: [
          {
            icon: "sparkles",
            title: "Aus CineApp wird Laterna",
            text: "Dasselbe Kino, ein neuer Name: Laterna, nach der Laterna magica, dem Vorläufer des Kinos. Die Filme spielt Lumen ab, seine Wiedergabe-Engine.",
            badge: "",
          },
          {
            icon: "phone",
            title: `Eine neue Adresse: ${NEW_ADDRESS}`,
            text: `Die alte Adresse funktioniert weiter, es eilt nicht. Zum Wechsel: Öffnen Sie ${NEW_ADDRESS}, melden Sie sich an, fügen Sie die Adresse zum Home-Bildschirm hinzu und löschen Sie das alte Symbol.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "Auf diesem Gerät",
            text: "müssen Sie Ihre Downloads neu anlegen und die Benachrichtigungen wieder einschalten, ebenso die gerätespezifischen Einstellungen: Sprache, Lautstärke, Untertitelstil.",
            badge: "",
          },
          {
            icon: "heart",
            title: "Ihr Verlauf, Ihre Wiedergabestände, Ihre Listen und Ihre gesehenen Filme",
            text: "kommen mit.",
            badge: "",
          },
          {
            icon: "bell",
            title: "Wenn möglich,",
            text: "wechseln Sie, während kein Download läuft.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
};
