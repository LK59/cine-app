import type { NewsContentByLang } from "./content";

/**
 * La page du renommage — CineApp devient Laterna, ses films sont lus par Lumen, et la nouvelle
 * adresse (l'ancienne continue de marcher). Texte du propriétaire (23/10/2026), traduit en en/es/de,
 * vouvoyé : « vous », « usted », « Sie », l'anglais neutre. Ni nom de brique ni nom de client
 * Jellyfin, ni vocabulaire d'infrastructure, ni titres masqués.
 *
 * **Une seule installation la reçoit** : celle dont le déploiement donne la nouvelle adresse
 * (`NEWS_LATERNA_ADDRESS`, `config.news.laternaAddress`). Sans elle — toute autre installation de
 * l'image publique —, `laternaNewsPage` rend `null` et rien n'est semé ; l'adresse affichée est celle
 * du réglage, jamais une valeur écrite ici.
 *
 * Préparée, **pas encore branchée** : `db.ts` ne l'appelle pas. La publier, c'est ajouter dans
 * `migrate()`, à côté des autres pages (DECISIONS.md §73 et §118) :
 *
 *     const laterna = laternaNewsPage(config.news.laternaAddress);
 *     if (laterna) seedNewsPage(db, laterna.seed, laterna.version, laterna.content);
 *
 * `NEWS_LATERNA_VERSION` : la version qui livrera le renommage, à ajuster au moment de publier si ce
 * n'est pas celle-ci.
 */
export const NEWS_LATERNA_VERSION = "10.0";
/** Le marqueur dans `migrations_done` : posé une fois, la page n'est plus jamais réécrite. */
export const NEWS_LATERNA_SEED = "news-seed-laterna";

/**
 * L'adresse telle qu'on l'écrit dans la page — un nom d'hôte seul (« app.example.org ») —, tirée du
 * réglage, qu'il soit donné nu ou avec son schéma (`https://app.example.org/`). Rien d'exploitable :
 * `null`.
 */
export function laternaAddress(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    // Au moins un point : un nom d'hôte public, pas un nom de conteneur.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

/** Le contenu de la page pour une adresse donnée. */
export function laternaNewsContent(address: string): NewsContentByLang {
  return {
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
              link: `https://${address}/`,
              title: `Une nouvelle adresse : ${address}`,
              text: `L'ancienne adresse continue de fonctionner, rien ne presse. Pour passer à la nouvelle : ouvrez ${address}, connectez-vous, ajoutez-la à votre écran d'accueil et supprimez l'ancienne icône.`,
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
              link: `https://${address}/`,
              title: `A new address: ${address}`,
              text: `The old address keeps working, there's no rush. To switch to the new one: open ${address}, sign in, add it to your home screen and delete the old icon.`,
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
              link: `https://${address}/`,
              title: `Una nueva dirección: ${address}`,
              text: `La dirección antigua sigue funcionando, no hay prisa. Para pasar a la nueva: abra ${address}, inicie sesión, añádala a su pantalla de inicio y borre el icono antiguo.`,
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
              link: `https://${address}/`,
              title: `Eine neue Adresse: ${address}`,
              text: `Die alte Adresse funktioniert weiter, es eilt nicht. Zum Wechsel: Öffnen Sie ${address}, melden Sie sich an, fügen Sie die Adresse zum Home-Bildschirm hinzu und löschen Sie das alte Symbol.`,
              badge: "",
            },
          ],
        },
      ],
      fixesSummary: "",
      fixes: [],
    },
  };
}

/**
 * La page à semer sur cette installation, ou `null` quand son déploiement ne donne pas la nouvelle
 * adresse — le cas de toute autre installation : elle n'a pas de page.
 */
export function laternaNewsPage(rawAddress: string | null | undefined): { seed: string; version: string; content: NewsContentByLang } | null {
  const address = laternaAddress(rawAddress);
  return address ? { seed: NEWS_LATERNA_SEED, version: NEWS_LATERNA_VERSION, content: laternaNewsContent(address) } : null;
}
