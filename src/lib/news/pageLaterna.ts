import type { NewsContentByLang } from "./content";

/**
 * La page du renommage — CineApp devient Laterna, son moteur de lecture s'appelle Lumen, et la
 * nouvelle adresse (l'ancienne continue de marcher). Préparée le 23/10/2026, **pas encore branchée** :
 * rien ne l'appelle, elle n'existe sur aucune installation tant que `db.ts` ne la sème pas
 * (`seedNewsPage(db, NEWS_LATERNA_SEED, NEWS_LATERNA_VERSION, NEWS_LATERNA_CONTENT)`, à côté des autres,
 * DECISIONS.md §73 et §118).
 *
 * `NEWS_LATERNA_VERSION` : la version qui livrera le renommage, à ajuster au moment de publier si ce
 * n'est pas celle-ci. L'adresse est écrite une fois (`NEW_ADDRESS`) : elle vaut pour l'installation
 * de référence, pas pour une autre — semée telle quelle, la page irait aussi aux installations de
 * l'image publique.
 *
 * Ce que l'appareil perd en changeant d'adresse vient de ce que le navigateur range par adresse :
 * la session, l'application installée, l'abonnement aux notifications, les téléchargements hors
 * ligne et les réglages gardés sur l'appareil (sous-titres, dialogues, interface). Sans vocabulaire
 * d'infrastructure (test des dictionnaires), et sans mentionner les titres masqués.
 */
export const NEWS_LATERNA_VERSION = "9.4";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_LATERNA_SEED = "news-seed-laterna";

const NEW_ADDRESS = "app.laterna.fr";

export const NEWS_LATERNA_CONTENT: NewsContentByLang = {
  fr: {
    sections: [
      {
        title: "Nouveau nom",
        entries: [
          {
            icon: "sparkles",
            title: "L'application s'appelle désormais Laterna",
            text: "Même application, même compte, mêmes films et séries : seul le nom change. Le logo, vos listes et vos reprises ne bougent pas.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Propulsée par Lumen",
            text: "Lumen, c'est le nom du moteur de lecture qui lit vos films directement dans le navigateur. Rien à faire de votre côté.",
            badge: "",
          },
        ],
      },
      {
        title: "Nouvelle adresse",
        entries: [
          {
            icon: "heart",
            title: `Laterna s'ouvre aussi sur ${NEW_ADDRESS}`,
            text: "L'ancienne adresse continue de marcher : rien ne presse. Passez à la nouvelle quand vous voulez.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Sur iPhone et iPad",
            text: `L'icône garde son ancien nom tant que vous ne la réinstallez pas. Pour passer à la nouvelle adresse : ouvrez ${NEW_ADDRESS} dans Safari, Partager → Sur l'écran d'accueil, puis supprimez l'ancienne icône.`,
            badge: "",
          },
          {
            icon: "phone",
            title: "Sur Android",
            text: `L'application installée prend le nouveau nom d'elle-même. Pour passer à la nouvelle adresse : ouvrez ${NEW_ADDRESS} dans Chrome, installez l'application, puis désinstallez l'ancienne.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "Ce qu'il faut refaire sur la nouvelle adresse",
            text: "Se reconnecter, réactiver les notifications, télécharger de nouveau les films gardés hors ligne, et refaire les réglages de cet appareil (sous-titres, dialogues, interface).",
            badge: "",
          },
          {
            icon: "bell",
            title: "Les notifications en double",
            text: "Activées sur les deux adresses, elles arrivent deux fois : coupez-les sur l'ancienne une fois la nouvelle installée.",
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
        title: "New name",
        entries: [
          {
            icon: "sparkles",
            title: "The app is now called Laterna",
            text: "Same app, same account, same films and series: only the name changes. The logo, your lists and where you left off stay as they are.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Powered by Lumen",
            text: "Lumen is the name of the playback engine that plays your films right in the browser. Nothing to do on your side.",
            badge: "",
          },
        ],
      },
      {
        title: "New address",
        entries: [
          {
            icon: "heart",
            title: `Laterna also opens at ${NEW_ADDRESS}`,
            text: "The old address keeps working: there is no rush. Switch to the new one whenever you like.",
            badge: "",
          },
          {
            icon: "phone",
            title: "On iPhone and iPad",
            text: `The icon keeps its old name until you reinstall it. To switch to the new address: open ${NEW_ADDRESS} in Safari, Share → Add to Home Screen, then remove the old icon.`,
            badge: "",
          },
          {
            icon: "phone",
            title: "On Android",
            text: `The installed app takes the new name on its own. To switch to the new address: open ${NEW_ADDRESS} in Chrome, install the app, then uninstall the old one.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "What to set up again at the new address",
            text: "Sign in again, turn notifications back on, download your offline films again, and redo this device's settings (subtitles, dialogue, layout).",
            badge: "",
          },
          {
            icon: "bell",
            title: "Duplicate notifications",
            text: "Turned on at both addresses, they arrive twice: turn them off at the old one once the new one is installed.",
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
        title: "Nuevo nombre",
        entries: [
          {
            icon: "sparkles",
            title: "La aplicación ahora se llama Laterna",
            text: "La misma aplicación, la misma cuenta, las mismas películas y series: solo cambia el nombre. El logotipo, tus listas y lo que estabas viendo no cambian.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Impulsada por Lumen",
            text: "Lumen es el nombre del motor de reproducción que reproduce tus películas directamente en el navegador. No tienes que hacer nada.",
            badge: "",
          },
        ],
      },
      {
        title: "Nueva dirección",
        entries: [
          {
            icon: "heart",
            title: `Laterna también se abre en ${NEW_ADDRESS}`,
            text: "La dirección antigua sigue funcionando: no hay prisa. Cambia a la nueva cuando quieras.",
            badge: "",
          },
          {
            icon: "phone",
            title: "En iPhone y iPad",
            text: `El icono conserva su nombre antiguo hasta que lo reinstales. Para cambiar a la nueva dirección: abre ${NEW_ADDRESS} en Safari, Compartir → Añadir a pantalla de inicio, y elimina el icono antiguo.`,
            badge: "",
          },
          {
            icon: "phone",
            title: "En Android",
            text: `La aplicación instalada adopta el nuevo nombre por sí sola. Para cambiar a la nueva dirección: abre ${NEW_ADDRESS} en Chrome, instala la aplicación y desinstala la antigua.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "Lo que hay que volver a hacer en la nueva dirección",
            text: "Volver a iniciar sesión, reactivar las notificaciones, descargar de nuevo las películas sin conexión y rehacer los ajustes de este dispositivo (subtítulos, diálogos, interfaz).",
            badge: "",
          },
          {
            icon: "bell",
            title: "Notificaciones duplicadas",
            text: "Activadas en las dos direcciones, llegan dos veces: desactívalas en la antigua una vez instalada la nueva.",
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
        title: "Neuer Name",
        entries: [
          {
            icon: "sparkles",
            title: "Die App heißt jetzt Laterna",
            text: "Gleiche App, gleiches Konto, gleiche Filme und Serien: Nur der Name ändert sich. Das Logo, Ihre Listen und Ihr Wiedergabestand bleiben, wie sie sind.",
            badge: "",
          },
          {
            icon: "speed",
            title: "Angetrieben von Lumen",
            text: "Lumen ist der Name der Wiedergabe-Engine, die Ihre Filme direkt im Browser abspielt. Sie müssen nichts tun.",
            badge: "",
          },
        ],
      },
      {
        title: "Neue Adresse",
        entries: [
          {
            icon: "heart",
            title: `Laterna öffnet sich auch unter ${NEW_ADDRESS}`,
            text: "Die alte Adresse funktioniert weiter: Es eilt nicht. Wechseln Sie zur neuen, wann Sie möchten.",
            badge: "",
          },
          {
            icon: "phone",
            title: "Auf iPhone und iPad",
            text: `Das Symbol behält seinen alten Namen, bis Sie es neu installieren. Zum Wechsel: ${NEW_ADDRESS} in Safari öffnen, Teilen → Zum Home-Bildschirm, dann das alte Symbol entfernen.`,
            badge: "",
          },
          {
            icon: "phone",
            title: "Auf Android",
            text: `Die installierte App übernimmt den neuen Namen von selbst. Zum Wechsel: ${NEW_ADDRESS} in Chrome öffnen, die App installieren, dann die alte deinstallieren.`,
            badge: "",
          },
          {
            icon: "wrench",
            title: "Was unter der neuen Adresse neu einzurichten ist",
            text: "Erneut anmelden, Benachrichtigungen wieder einschalten, Offline-Filme neu herunterladen und die Einstellungen dieses Geräts neu vornehmen (Untertitel, Dialoge, Oberfläche).",
            badge: "",
          },
          {
            icon: "bell",
            title: "Doppelte Benachrichtigungen",
            text: "Unter beiden Adressen eingeschaltet, kommen sie zweimal: Schalten Sie sie unter der alten aus, sobald die neue installiert ist.",
            badge: "",
          },
        ],
      },
    ],
    fixesSummary: "",
    fixes: [],
  },
};
