import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * Les décisions qui ont déjà dérivé, et qu'on empêche de dériver à nouveau.
 *
 * `CLAUDE.md` nomme la dette de ce dépôt : « the same decision is made in several places, and they
 * drift ». Trois l'ont fait le 19/09/2026, en une seule journée, et chacune s'est vue comme un
 * défaut différent :
 *
 *  * **deux replis stéréo** — un par chemin audio — donc le même angle mort des deux côtés, à
 *    corriger deux fois ;
 *  * **deux sources d'affiche** — Radarr et TMDB — donc deux réponses pour un même film, selon la
 *    rangée qui le montrait ;
 *  * **deux mécanismes de sortie** sur une même fiche, qui s'enchaînaient au lieu de se recouvrir.
 *
 * Ces tests lisent la source, comme ceux du catalogue et de la pile des fiches, et pour la même
 * raison : la faute est l'existence d'un *second* endroit, ce qu'aucune assertion sur un résultat
 * ne peut voir. Ils ne vérifient pas que le code est juste — ils vérifient qu'il n'y en a qu'un.
 */

const lire = (f: string) => readFileSync(f, "utf8");

describe("un seul repli stéréo", () => {
  /**
   * Le chemin du canevas replie le multicanal pour le graphe audio, celui du remultiplexage avant
   * de ré-encoder. Les deux écrivaient leur propre matrice, et les deux lisaient donc le rang 4
   * comme une ambiance gauche — faux pour une piste 5.0, qui n'en a pas.
   */
  it("le chemin du canevas emprunte la matrice de l'autre plutôt que la sienne", () => {
    const src = lire("src/lib/webcodecs/audioOutput.ts");
    expect(src).toMatch(/import \{ fold \} from "\.\/audioTranscode"/);
    expect(src).toMatch(/const \[l, r\] = fold\(planes, 2\)/);
    // La matrice qu'il s'écrivait : des rangs lus à la main, et le piège exact.
    expect(src).not.toMatch(/const surroundLeft = planes\[4\]/);
  });

  it("le coefficient de demi-puissance est écrit exactement, des deux côtés", () => {
    // `0.707` d'un côté et `Math.SQRT1_2` de l'autre : la même intention, arrondie une fois. Un
    // écart de 10⁻⁴ que seul un test a vu, et qui disait qu'un des deux chemins avait changé.
    //
    // Les lignes de commentaire sont écartées : elles *expliquent* le coefficient, en toutes
    // lettres et à juste titre. C'est le code qui ne doit plus l'arrondir.
    const codeOnly = (f: string) =>
      lire(f)
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
    expect(codeOnly("src/lib/webcodecs/audioTranscode.ts")).not.toMatch(/0\.707/);
    expect(codeOnly("src/lib/webcodecs/audioTranscode.ts")).toMatch(/HALF_POWER = Math\.SQRT1_2/);
  });
});

describe("une seule source d'affiche", () => {
  /**
   * Radarr ne connaît qu'une affiche par film — celle que TMDB sert par défaut — quand les
   * rangées venues de TMDB étaient déjà dans la langue du site. « Le Prénom » dans une rangée,
   * « What's in a Name? » dans la suivante.
   */
  const ROUTES = [
    "src/app/api/cinema/movies/route.ts",
    "src/app/api/cinema/series/route.ts",
    "src/app/api/player/lists/route.ts",
  ];

  it.each(ROUTES)("%s passe par libraryPoster, et non par posterUrl seul", (route) => {
    const src = lire(route);
    expect(src).toMatch(/libraryPoster\(/);
  });

  it("le choix de la langue n'est écrit qu'à un endroit", () => {
    const src = lire("src/lib/images.ts");
    expect(src).toMatch(/export function libraryPoster\(/);
    // La règle elle-même : la langue si on l'a, l'affiche d'origine sinon.
    expect(src).toMatch(/posterByLang\?\.\[locale\] \?\? posterUrl\(/);
  });
});

describe("un seul mécanisme de sortie par fiche", () => {
  /**
   * `useDelayedClose` retient l'adresse, `useExitDelay` garde la fiche montée après qu'elle a
   * changé. Les deux ensemble s'enchaînent au lieu de se recouvrir — jusqu'à une demi-seconde de
   * fiche sortante pendant laquelle la suivante se monte déjà.
   */
  const FICHES = [
    "src/components/player/PlayerPersonSheet.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
  ];

  it.each(FICHES)("%s laisse le sursis à la coquille", (fiche) => {
    const src = lire(fiche);
    expect(src).not.toMatch(/useDelayedClose\(/);
  });

  // Et les fiches de bibliothèque gardent le leur, qui est l'autre moitié de la règle : elles ne
  // sont pas rendues d'après l'adresse, donc personne d'autre ne peut les retenir.
  it("les fiches de bibliothèque gardent le leur, qu'elles sont seules à avoir", () => {
    const src = lire("src/components/cinema/mobile/CinemaMobileDetail.tsx");
    expect(src).toMatch(/useDelayedClose\(onClose,/);
  });
});

/**
 * Les gestes d'ouverture, écrits une fois pour les deux écrans.
 *
 * Relevé le 20/09/2026 en comparant les deux clients cinéma : `openDiscovery` y était identique
 * octet pour octet, `openResume` ne différait que par une écriture de focus propre au clavier, et
 * `openDetail` avait **déjà divergé** — le bureau ne savait ouvrir qu'un film et omettait
 * l'onglet, le mobile prenait les deux et le posait.
 */
describe("un seul geste d'ouverture", () => {
  const CLIENTS = [
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
  ];

  it.each(CLIENTS)("%s délègue l'ouverture au module commun", (client) => {
    const src = lire(client);
    expect(src).toMatch(/from "@\/lib\/cinemaOpen"/);
    // Les formes exactes qui s'étaient dédoublées : une adresse de fiche écrite à la main.
    expect(src).not.toMatch(/cinemaNavigate\(\{ film: Number\(/);
    expect(src).not.toMatch(/cinemaNavigate\(\{ serie: Number\(/);
    expect(src).not.toMatch(/cinemaNavigate\(\{ discover: item\.tmdbId/);
  });

  /**
   * Et la décision que l'extraction a failli effacer.
   *
   * « Reprendre » est une rangée mixte : basculer sur l'onglet Séries pour ouvrir un épisode puis
   * rebasculer en refermant se voyait comme un clignotement de toute la grille. C'est la seule des
   * trois ouvertures qui ne passe pas par `openLibraryTitle`, et ce qui la rend sûre est qu'elle
   * efface l'autre champ — le repli de `sheetTarget` fait le reste.
   */
  it("n'impose pas d'onglet à une reprise, et efface l'autre champ", () => {
    const src = lire("src/lib/cinemaOpen.ts");
    const reprise = src.slice(src.indexOf("export function openResumeTarget"));
    expect(reprise).not.toMatch(/tab:/);
    expect(reprise).toMatch(/film: Number\(film\[1\]\), serie: null/);
    expect(reprise).toMatch(/serie: Number\(serie\[1\]\), film: null/);
  });

  // Les deux autres, elles, portent l'onglet — c'est `openLibraryTitle` qui le garantit.
  it("fait porter l'onglet aux ouvertures qui en ont besoin", () => {
    const src = lire("src/lib/cinemaOpen.ts");
    expect(src).toMatch(/export function openTitle[\s\S]{0,200}openLibraryTitle\(/);
    expect(src).toMatch(/export function openDiscoveryItem[\s\S]{0,300}openLibraryTitle\(/);
  });
});

describe("un seul geste tactile de fermeture sur les fiches du bureau", () => {
  /**
   * Les deux fiches larges — film et série — ont la même mise en scène, et l'ont déjà payée : les
   * voiles et la colonne y étaient écrits deux fois, à la virgule près, avant de rejoindre
   * `CinemaDetailLayout`. La poignée du 20/09/2026 est arrivée par le même besoin et part au même
   * endroit ; ce test interdit la troisième copie.
   */
  it("aucune des deux fiches ne câble le geste elle-même", () => {
    for (const f of ["src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"]) {
      const src = lire(f);
      expect(src).toMatch(/useSheetGrip/);
      expect(src).not.toMatch(/useSwipeToDismiss/);
    }
  });

  it("la poignée ne s'arme qu'au doigt", () => {
    for (const f of ["src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"]) {
      expect(lire(f)).toMatch(/useSheetGrip\(requestClose, useIsTouch\(\)/);
    }
  });

  it("ne pose aucun transform au repos — le bouton Retour est en fixed", () => {
    const src = lire("src/components/cinema/CinemaDetailLayout.tsx");
    expect(src).toMatch(/style: held\s*\n?\s*\?/);
    expect(src).not.toMatch(/transform: `translateY\(\$\{swipe\.offset\}px\)` }\s*;/);
  });
});

describe("une seule source pour la bannière", () => {
  /**
   * Le survol, les flèches et le doigt mènent tous les trois à `onFocusItem` — par le focus natif
   * du navigateur, que `useTvGridNav` a établi et que `useCentredCard` emprunte. Une quatrième
   * source qui appellerait `setFocusedItem` de son côté rouvrirait la question « qui commande la
   * bannière », à laquelle ce dépôt a déjà répondu.
   */
  it("le geste tactile passe par le focus, et non par un état à lui", () => {
    const src = lire("src/lib/useCentredCard.ts");
    expect(src).toMatch(/\.focus\(\{ preventScroll: true \}\)/);
    expect(src).not.toMatch(/useState|setFocusedItem/);
  });

  it("un seul écouteur pour toutes les rangées, et il est passif", () => {
    const src = lire("src/lib/useCentredCard.ts");
    expect(src).toMatch(/addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/);
    // Une rangée qui se câblerait elle-même serait la copie qu'on évite.
    for (const f of ["CinemaRow", "CinemaSeriesRow", "CinemaTop10Row", "CinemaDiscoveryRow"]) {
      expect(lire(`src/components/cinema/${f}.tsx`)).not.toMatch(/useCentredCard/);
    }
  });
});

describe("l'amorce du catalogue et la requête qui la consomme", () => {
  /**
   * Le catalogue part avec le HTML (voir le `layout` du groupe `(player)`), et c'est une décision
   * prise à **deux endroits qui doivent se correspondre au bit près** : l'amorce dans le document,
   * et le récupérateur qui suivra. Le navigateur ne réutilise l'une pour l'autre que si le mode et
   * le régime d'identification coïncident.
   *
   * Mesuré le 20/09/2026 dans Chrome, sur un banc où le serveur compte ce qu'il reçoit :
   *
   *     crossorigin="anonymous"        → 1 requête   (l'amorce est reprise)
   *     aucun attribut crossorigin     → 2 requêtes
   *     crossorigin="use-credentials"  → 2 requêtes
   *
   * Deux requêtes, ici, c'est le plus gros envoi du démarrage téléchargé deux fois. D'où ces deux
   * assertions, qui tiennent chacune un bout du contrat.
   */
  it("l'amorce déclare le régime qui correspond à un fetch nu", () => {
    const src = lire("src/app/(player)/layout.tsx");
    expect(src).toMatch(/rel="preload" as="fetch" crossOrigin="anonymous" href=\{MOVIES_CATALOGUE_KEY\}/);
  });

  it("le récupérateur du catalogue reste un fetch nu", () => {
    // `fetch(url, { … })` — en-têtes, `credentials`, `cache` — romprait la correspondance sans
    // qu'aucun écran ne change d'apparence : le catalogue partirait deux fois, en silence.
    const src = lire("src/lib/cinemaPayload.ts");
    expect(src).toMatch(/const res = await fetch\(url\);/);
  });

  it("le service worker laisse passer les appels d'API sans les toucher", () => {
    // Une amorce interceptée puis resservie par le worker ne serait plus la même requête.
    expect(lire("public/sw.js")).toMatch(/if \(url\.pathname\.startsWith\("\/api\/"\)\) return;/);
  });
});

describe("le décodage anticipé suit la liste, pas son nombre", () => {
  /**
   * Le défaut trouvé en relisant le travail du 20/09/2026, et que les tests du crochet ne
   * pouvaient pas voir : il était dans l'appel, pas dans le crochet.
   *
   * `useDecodeAhead(gridRef, shown.length)` a l'air prudent et il est faux — changer le tri garde
   * exactement le même nombre de cartes, donc l'effet ne repartait pas. Or l'observateur cesse de
   * suivre chaque carte dès qu'il l'a chauffée : après un tri, le premier écran n'était plus
   * anticipé du tout, précisément là où quelqu'un se remet à faire défiler.
   */
  it("la grille passe la liste elle-même", () => {
    const src = lire("src/components/cinema/CinemaBrowseSheet.tsx");
    expect(src).toMatch(/useDecodeAhead\(gridRef, shown\)/);
    expect(src).not.toMatch(/useDecodeAhead\([^)]*\.length\)/);
  });
});

describe("une seule règle de reprise, une seule d'épisode suivant, une seule conversion de piste", () => {
  /**
   * Ajoutés le 21/09/2026, après l'inventaire de `DECISIONS.md`. Chacune de ces règles vivait en
   * plusieurs copies ; l'une avait déjà divergé (la fiche film lisait « réponse arrivée » là où il
   * fallait « serveur a répondu »), les autres pas encore.
   */
  const codeOnly = (f: string) =>
    lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");

  it("la position de départ se calcule par `resumeAtFor`, pas à la main", () => {
    for (const f of ["src/components/PlayButton.tsx", "src/components/cinema/mobile/CinemaMobileDetail.tsx"]) {
      expect([f, codeOnly(f)]).toEqual([f, expect.stringContaining("resumeAtFor(")]);
      expect([f, /!resumeKnown \? undefined/.test(codeOnly(f))]).toEqual([f, false]);
    }
  });

  it("« connu » veut dire que Jellyfin a répondu, pas que la requête est revenue", () => {
    for (const f of ["src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/mobile/CinemaMobileDetail.tsx"]) {
      expect([f, /progress !== undefined/.test(codeOnly(f))]).toEqual([f, false]);
      expect([f, codeOnly(f)]).toEqual([f, expect.stringContaining("progress?.known === true")]);
    }
  });

  it("le lecteur stable demande au serveur une position absente", () => {
    expect(codeOnly("src/components/PlayerHost.tsx")).toContain("resolveResumeAt(itemId, initialResumeAt)");
  });

  it("l'épisode suivant du cinéma vient de `nextEpisodeIn`", () => {
    for (const f of [
      "src/components/cinema/CinemaSeriesDetail.tsx",
      "src/components/cinema/mobile/CinemaMobileDetail.tsx",
      "src/lib/playSeriesNextEpisode.ts",
    ]) {
      expect([f, codeOnly(f)]).toEqual([f, expect.stringContaining("nextEpisodeIn(")]);
      expect([f, /flat\.findIndex/.test(codeOnly(f))]).toEqual([f, false]);
    }
  });

  it("une piste du conteneur devient une `EngineTrack` en un seul endroit", () => {
    for (const f of ["src/lib/webcodecs/engine.ts", "src/lib/webcodecs/remuxPlayback.ts"]) {
      expect([f, codeOnly(f)]).toEqual([f, expect.stringContaining("fromMatroskaTrack")]);
      expect([f, /isForced: (t|track)\.isForced/.test(codeOnly(f))]).toEqual([f, false]);
    }
  });

  it("le canevas ouvre sur la piste que l'écran choisira, par la même règle", () => {
    const host = codeOnly("src/components/ExperimentalPlayerHost.tsx");
    expect(host).toMatch(/chooseAudioTrack: \(tracks\) => \{[\s\S]{0,300}chooseAudioTrack\(tracks, preferences\)/);
  });
});
