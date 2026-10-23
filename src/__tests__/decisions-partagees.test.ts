import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { posix } from "path";

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

/** Le code sans les lignes de commentaire : un nom cité dans un commentaire n'est pas un appel. */
const sansCommentaires = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

/**
 * Les sources du lecteur, où que le découpage les range (22/10/2026).
 *
 * Ces règles lisaient `ExperimentalPlayerHost.tsx`, `PlayerHost.tsx` et `PlayerControls.tsx` à leur
 * chemin : découper ces fichiers géants — ce que l'audit du lecteur prévoit — aurait cassé des tests
 * dont la règle, elle, tenait toujours. Elles lisent maintenant un **ensemble** :
 *
 *  * `src/lib/webcodecs/**` — le moteur ;
 *  * sous `src/components/`, tout fichier dont un segment du chemin contient « player » (casse
 *    ignorée) : les hôtes, les commandes, `src/components/player/**` et ses sous-dossiers
 *    (`player/native/…`, `player/server/…`), `offline/OfflinePlayerHost.tsx`.
 *
 * Une règle « personne ne fait X » parcourt tout l'ensemble. Une règle « chacun des deux lecteurs
 * passe par Y » lit le **graphe d'imports** de l'hôte (`codeDe`) : son module d'entrée, retrouvé
 * par son export et non par son chemin, et tout ce qu'il importe dans l'ensemble, sans entrer dans
 * l'autre hôte ni dans les commandes, qu'ils partagent — sans quoi l'appel de l'un compterait pour
 * l'autre. Un module extrait d'un hôte reste donc vu tant qu'il vit sous un dossier du lecteur ;
 * sorti vers `src/lib/`, il quitte la vue et la règle échoue — c'est voulu : y ranger un morceau du
 * lecteur, c'est l'ôter de ce que ces tests gardent.
 */
const SOURCES = () =>
  (readdirSync("src", { recursive: true }) as string[])
    .map((f) => `src/${f.replaceAll("\\", "/")}`)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"));
const estDuLecteur = (f: string) =>
  f.startsWith("src/lib/webcodecs/") ||
  (f.startsWith("src/components/") && f.slice("src/components/".length).split("/").some((seg) => /player/i.test(seg)));
const sourcesDuLecteur = () => SOURCES().filter(estDuLecteur);

/** Le module de l'ensemble qui exporte `nom` — un seul, sinon la règle ne sait plus qui elle lit. */
const entrees = new Map<string, string>();
function entreeDe(nom: string): string {
  const connue = entrees.get(nom);
  if (connue) return connue;
  const exporte = new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s+${nom}\\b|const\\s+${nom}\\b)`);
  const hits = sourcesDuLecteur().filter((f) => exporte.test(lire(f)));
  expect(hits, `le module du lecteur qui exporte ${nom}`).toHaveLength(1);
  entrees.set(nom, hits[0]);
  return hits[0];
}

function resoudre(depuis: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(depuis), spec));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Les deux hôtes, celui hors ligne et les commandes : les frontières entre lesquelles `codeDe` lit. */
const PIECES_DU_LECTEUR = ["ExperimentalPlayerHost", "PlayerHost", "OfflinePlayerHost", "PlayerControls"];

/**
 * Le code (sans commentaires) d'une pièce du lecteur : son module d'entrée et ce qu'il importe dans
 * l'ensemble du lecteur, sans franchir les autres pièces. Chaque fichier y est précédé de son chemin.
 */
function codeDe(piece: string): string {
  const bornes = new Set(PIECES_DU_LECTEUR.filter((p) => p !== piece).map(entreeDe));
  const vus = new Set<string>();
  const pile = [entreeDe(piece)];
  while (pile.length > 0) {
    const f = pile.pop()!;
    if (vus.has(f)) continue;
    vus.add(f);
    for (const m of sansCommentaires(lire(f)).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      const cible = resoudre(f, m[1]);
      if (cible && estDuLecteur(cible) && !bornes.has(cible) && !vus.has(cible)) pile.push(cible);
    }
  }
  return [...vus]
    .sort()
    .map((f) => `/* ${f} */\n${sansCommentaires(lire(f))}`)
    .join("\n");
}

/** Les fichiers de tout l'ensemble du lecteur dont le code (sans commentaires) répond au motif. */
const lecteurQui = (motif: RegExp) => sourcesDuLecteur().filter((f) => motif.test(sansCommentaires(lire(f))));

const NATIF = "ExperimentalPlayerHost";
const SERVEUR = "PlayerHost";
const HOTES = [NATIF, SERVEUR];

describe("un seul repli stéréo", () => {
  /**
   * Le lecteur canevas repliait le multicanal pour son graphe audio, le remultiplexage avant de
   * ré-encoder, chacun avec sa matrice. Il ne reste que `fold` (audioTranscode.ts) depuis le
   * retrait du canevas, le 24/09/2026 — et ce test garde le coefficient qui avait divergé.
   */
  it("le coefficient de demi-puissance est écrit exactement", () => {
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
    // La carte des deux catalogues (et celle d'un lien de partage, §112) : écrite une fois depuis le
    // 20/10/2026, hors des deux routes qui la construisaient chacune.
    "src/lib/cinemaEntries.ts",
    "src/app/api/player/lists/route.ts",
  ];

  it.each(ROUTES)("%s passe par cataloguePoster (donc libraryPoster), et non par posterUrl seul", (route) => {
    const src = lire(route);
    expect(src).toMatch(/cataloguePoster\(/);
  });

  /**
   * Le 11/10/2026, « Vus » montrait l'affiche d'origine de 38 films sur 40 et « Ma liste »
   * l'original de TheTVDB des séries, quand le catalogue montrait l'affiche française et celle de
   * Jellyfin : chacun appelait `libraryPoster` avec ses propres arguments. Une seule règle désormais,
   * `cataloguePoster`, et personne d'autre n'appelle `libraryPoster` ni `jellyfinPoster` directement.
   */
  it("catalogue, listes et préchauffage montrent la même affiche (`cataloguePoster`)", () => {
    for (const f of [...ROUTES, "src/lib/posterPrewarm.ts"]) {
      const src = lire(f);
      expect(src, f).toMatch(/cataloguePoster\(/);
      expect(src, f).not.toMatch(/\blibraryPoster\(/);
      expect(src, f).not.toMatch(/\bjellyfinPoster\(/);
    }
  });

  it("le choix de la langue n'est écrit qu'à un endroit", () => {
    const src = lire("src/lib/images.ts");
    expect(src).toMatch(/export function libraryPoster\(/);
    // La règle elle-même : la langue si on l'a, l'affiche d'origine sinon.
    expect(src).toMatch(/posterByLang\?\.\[locale\] \?\? (orElse \?\? )?posterUrl\(/);
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

  // Et pendant ce sursis, elles n'ont plus d'avis — la règle 2, tenue par une seule fonction.
  // Chacune avait son écouteur d'Échap, et aucun ne regardait `leaving`.
  it.each(FICHES)("%s se tait pendant sa sortie par `useSheetExit`", (fiche) => {
    const src = lire(fiche);
    expect(src).toMatch(/useSheetExit\(close, \{ leaving/);
    expect(src).not.toMatch(/if \(e\.key !== "Escape" && e\.key !== "Backspace"\) return;\s*\n\s*(if \(showSynopsis\) return;\s*\n\s*)?e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);\s*\n\s*requestClose\(\)/);
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
  it("l'amorce est un fetch lancé avec le HTML, sur tous les moteurs (15/10/2026)", () => {
    // L'ancienne `<link rel="preload">` n'était pas reprise par Safari une fois sur deux, et coupée
    // sur WebKit depuis le 08/10 : l'iPhone envoyait le catalogue une seconde après son code.
    const layout = lire("src/app/(player)/layout.tsx");
    expect(layout).toMatch(/<script dangerouslySetInnerHTML=\{\{ __html: earlyFetchScript\(\) \}\} \/>/);
    expect(layout).not.toMatch(/rel="preload"/);
    expect(layout).not.toMatch(/!webkit/);
    // Et le script fait un fetch nu — le même que les récupérateurs.
    expect(lire("src/lib/earlyFetch.ts")).toMatch(/var p=fetch\(u\);/);
  });

  it("les récupérateurs reprennent l'amorce, sinon font un fetch nu", () => {
    // `fetch(url, { … })` — en-têtes, `credentials`, `cache` — donnerait à l'écran une autre réponse
    // que celle qu'il aurait demandée lui-même. Les deux passent par `fetchOrEarly`, qui retombe sur
    // le fetch nu d'avant.
    for (const file of ["src/lib/cinemaPayload.ts", "src/lib/swr.ts"]) {
      expect(lire(file)).toMatch(/const res = await fetchOrEarly\(url\);/);
    }
    const early = lire("src/lib/earlyFetch.ts");
    expect(early).toMatch(/return early \? early\.catch\(\(\) => fetch\(url\)\) : fetch\(url\);/);
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
    // La liste que la grille dessine : `grid`, construite en arrière-plan depuis `shown` (04/10/2026,
    // ouverture en deux temps) — toujours la liste elle-même, jamais son nombre.
    expect(src).toMatch(/useDecodeAhead\(gridRef, grid[,)]/);
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

  it("« Recommencer » des fiches du bureau passe par `PlayButton`, pas par une ligne réécrite", () => {
    // Les deux copies n'avaient pas la garde de lecture intégrée : avec `PLAYER_ENABLED=false`,
    // elles s'affichaient et menaient à « Lecteur intégré désactivé » (29/09/2026).
    for (const f of ["src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"]) {
      expect([f, codeOnly(f)]).toEqual([f, expect.stringMatching(/<PlayButton\s+restart\b/)]);
      expect([f, /resumeAt: 0\s*[,}]/.test(codeOnly(f))]).toEqual([f, false]);
    }
  });

  it("« connu » veut dire que Jellyfin a répondu, pas que la requête est revenue", () => {
    for (const f of ["src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/mobile/CinemaMobileDetail.tsx"]) {
      expect([f, /progress !== undefined/.test(codeOnly(f))]).toEqual([f, false]);
      expect([f, codeOnly(f)]).toEqual([f, expect.stringContaining("progress?.known === true")]);
    }
  });

  // Le comportement (une position absente → `playback-state`, puis le recul) est éprouvé par
  // `decisions-partagees-lecteur.test.tsx` ; ici, le seul porteur.
  it("le lecteur stable demande au serveur une position absente, par `resolveResumeAt`", () => {
    expect(codeDe(SERVEUR)).toMatch(/resolveResumeAt\(\s*\w+\s*,\s*\w+\s*\)/);
  });

  it("l'épisode suivant du cinéma vient de `nextEpisodeIn`", () => {
    // Les deux fiches de série passent par `useNextEpisodeFromCache`, qui l'appelle au moment où
    // l'épisode se termine (25/09/2026).
    for (const f of [
      "src/components/cinema/CinemaSeriesDetail.tsx",
      "src/components/cinema/mobile/CinemaMobileDetail.tsx",
      "src/lib/playSeriesNextEpisode.ts",
    ]) {
      expect([f, codeOnly(f)]).toEqual([f, expect.stringMatching(/nextEpisodeIn\(|useNextEpisodeFromCache\(/)]);
      expect([f, /flat\.findIndex/.test(codeOnly(f))]).toEqual([f, false]);
    }
  });

  it("une piste du conteneur devient une `PlayerTrack` en un seul endroit", () => {
    const f = "src/lib/webcodecs/remuxPlayback.ts";
    expect([f, codeOnly(f)]).toEqual([f, expect.stringContaining("fromMatroskaTrack")]);
    expect([f, /isForced: (t|track)\.isForced/.test(codeOnly(f))]).toEqual([f, false]);
  });

  // Le lecteur canevas avait sa propre ouverture, gardée alignée par un test ici ; retiré le
  // 24/09/2026, il ne reste que celle du chemin natif — la même fonction que l'écran.
  it("le chemin natif ouvre sur la piste que l'écran choisira, par la même règle", () => {
    expect(codeOnly("src/lib/webcodecs/remuxPlayback.ts")).toMatch(/chooseAudioTrack\(/);
  });
});

describe("une seule rangée de casting pour les trois fiches", () => {
  // Revenue le 21/09/2026. Trois fiches la montrent — film, série, téléphone — et c'est l'axe
  // « film contre série » qui a déjà coûté un correctif manqué : une seule rangée, appelée trois fois.
  it("film, série et téléphone passent par `CinemaCastRow`", () => {
    for (const f of [
      "src/components/cinema/CinemaMovieDetail.tsx",
      "src/components/cinema/CinemaSeriesDetail.tsx",
      "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    ]) {
      expect([f, lire(f)]).toEqual([f, expect.stringContaining("<CinemaCastRow cast=")]);
    }
  });
});

describe("le second écran des fiches laisse sa place au bouton Retour", () => {
  // Vu le 21/09/2026 sur Dirty Dancing : avec trois rangées, l'écran dépassait la fenêtre,
  // commençait en haut, et « Distribution » passait sous le bouton Retour, fixe.
  it("une réserve en haut, écrite une fois pour le film et la série", () => {
    expect(lire("src/components/cinema/CinemaDetailLayout.tsx")).toMatch(/BELOW_SECTION_CLASS =[\s\S]{0,200}pt-\[calc\(5rem/);
    // Depuis le 14/10/2026, une seule section écrite, pour le film, la série et la découverte.
    expect(lire("src/components/cinema/CinemaDetailPages.tsx")).toContain("className={BELOW_SECTION_CLASS}");
  });
});

describe("la fiche découverte montre la même distribution que les autres", () => {
  // Elle avait sa propre rangée — plus petite, sans le rôle : la cascade acteur → film → acteur
  // changeait d'aspect à chaque cran selon que le film était dans la bibliothèque ou non.
  it("passe par `CinemaCastRow`", () => {
    const src = lire("src/components/player/PlayerDiscoverSheet.tsx");
    // La même conversion, faite une fois par réponse (voir « ne reconstruit pas ses rangées »).
    expect(src).toContain("castFromTitle(data.cast)");
    expect(src).toContain("<CinemaCastRow cast={cast}");
    expect(src).not.toMatch(/function CastRow\(/);
  });
});

describe("l'accroche, la durée et l'arrivée : une écriture pour toutes les fiches", () => {
  // Trois détails repris de la gestion le 21/09/2026 ; cinq mises en page les montrent.
  const fiches = [
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
  ];
  it("toutes les fiches passent par `CinemaTagline`", () => {
    for (const f of fiches) expect([f, lire(f)]).toEqual([f, expect.stringContaining("<CinemaTagline text=")]);
  });
  it("la durée d'une série se dit par `useRuntimeLabel`, jamais à la main", () => {
    for (const f of fiches.slice(1)) expect([f, lire(f)]).toEqual([f, expect.stringContaining("useRuntimeLabel()")]);
  });
  it("le pourcentage d'arrivée vient de `CinemaDownloading`", () => {
    for (const f of ["src/components/player/PlayerDiscoverSheet.tsx", "src/components/cinema/CinemaMissingEpisodes.tsx"]) {
      expect([f, lire(f)]).toEqual([f, expect.stringContaining("<CinemaDownloading progress=")]);
    }
  });
});

describe("les notes critiques : dans « Voir plus », sur grand écran seulement", () => {
  // Le choix de Louis (21/09/2026) : pas sur la fiche, et pas du tout sur téléphone.
  it("les deux fiches du bureau les mettent dans la fenêtre du synopsis", () => {
    for (const f of ["src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"]) {
      expect([f, lire(f)]).toEqual([f, expect.stringContaining("<CinemaRatingsLine imdbId={info?.imdbId} />")]);
    }
  });
  it("le téléphone ne les montre pas", () => {
    expect(lire("src/components/cinema/mobile/CinemaMobileDetail.tsx")).not.toContain("CinemaRatingsLine");
  });
});

describe("une seule animation de fiche qu'on tire", () => {
  /**
   * `swipe.touched ? "" : closing ? "sheet-out" : …`, écrit trois fois : après un simple appui sur
   * la bannière, chaque fermeture suivante disparaissait d'un coup. Voir `sheetMotionClass`.
   */
  it.each([
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
    "src/components/player/PlayerPersonSheet.tsx",
  ])("%s", (f) => {
    const src = lire(f);
    expect(src).toContain("sheetMotionClass(");
    expect(src).not.toMatch(/swipe\.touched \? "" :/);
  });

  // La croix posée dans la poignée arrête l'appui par le même objet partout.
  it.each(["src/components/cinema/mobile/CinemaMobileDetail.tsx", "src/components/player/PlayerDiscoverSheet.tsx"])(
    "%s : la croix n'est pas la poignée",
    (f) => {
      expect(lire(f)).toContain("{...NOT_THE_HANDLE}");
    }
  );
});

describe("une seule façon de savoir que le lecteur tient le clavier", () => {
  // La fiche du téléphone l'avait oublié : Échap refermait le lecteur *et* elle.
  it.each([
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/cinema/CinemaEpisodeBrowser.tsx",
  ])("%s", (f) => {
    const src = lire(f);
    expect(src).toContain("playerHoldsKeyboard(playback)");
    expect(src).not.toMatch(/playerOwnsKeyboard = playback\.mode === "full"/);
  });
});

describe("le lecteur plein écran, une seule façon de le demander", () => {
  // Le dernier à le lire en direct était la grille du bureau (« / », les flèches), par
  // `gridIsTop`. Aucun écran du cinéma ne compare plus `mode` à "full" lui-même.
  it("personne dans le cinéma ne compare `mode` à \"full\" à la main", () => {
    const hits = (readdirSync("src", { recursive: true }) as string[])
      .map((f) => `src/${f}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"))
      .filter((f) => f.startsWith("src/components/cinema/") || f.startsWith("src/lib/cinema"))
      .filter((f) => /[mM]ode\s*[!=]==\s*"full"/.test(lire(f)));
    expect(hits).toEqual([]);
  });

  it("gridIsTop passe par playerHoldsKeyboard", () => {
    expect(lire("src/lib/cinemaGridTop.ts")).toContain("playerHoldsKeyboard(");
  });
});

describe("une seule prise de pointeur", () => {
  // Règle 3 de « The sheet lifecycle » : la capture passe par `usePointerCapture`, qui la rend au
  // démontage et ne lève pas sur un pointeur déjà parti. Le carrousel de la bannière la prenait
  // à la main.
  it("personne d'autre n'appelle setPointerCapture", () => {
    const hits = (readdirSync("src", { recursive: true }) as string[])
      .map((f) => `src/${f}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"))
      .filter((f) => /\.(set|release)PointerCapture\??\.?\(/.test(lire(f)));
    expect(hits).toEqual(["src/lib/usePointerCapture.ts"]);
  });
});

describe("ce que Lire trouve déjà prêt", () => {
  // Une fonction, appelée par les trois fiches et par elles seules : une carte ou une ligne
  // d'épisode qui l'appellerait ferait partir une rafale de requêtes à chaque grille affichée.
  const code = (f: string) =>
    lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
  const sources = () =>
    (readdirSync("src", { recursive: true }) as string[])
      .map((f) => `src/${f}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"));

  it("les trois fiches, et elles seules, préparent la lecture", () => {
    const hits = sources().filter((f) => f !== "src/lib/usePlaybackPrefetch.ts" && /usePlaybackPrefetch\(/.test(code(f)));
    expect(hits.sort()).toEqual([
      "src/components/cinema/CinemaMovieDetail.tsx",
      "src/components/cinema/CinemaSeriesDetail.tsx",
      "src/components/cinema/mobile/CinemaMobileDetail.tsx",
      // La fiche d'un lien de partage (§112) : une fiche, avec le seul titre de son bouton principal.
      "src/components/shareGuest/ShareTitleSheet.tsx",
    ]);
  });

  it("le lecteur lit la description sous la clé que la fiche précharge", () => {
    const host = codeDe(NATIF);
    expect(host).toMatch(/useSWR<DirectPlayInfo>\(\s*\[\s*directInfoKey\((\w+)\)[^\]]*\]\s*,\s*\(\)\s*=>\s*directInfoForOpening\(\1\)/);
    expect(host).toMatch(/takePrefetchedPlaybackState\((\w+)\)\s*\?\?\s*fetchPlaybackState\(\1\)/);
    // L'adresse écrite à la main, qui ferait précharger dans le vide — nulle part dans le lecteur.
    expect(lecteurQui(/`\/api\/jellyfin\/(direct|playback-state)\//)).toEqual([]);
  });
});

describe("une seule recherche du lecteur", () => {
  // `keepPreviousData` gardait les résultats d'avant sous une recherche qui avait échoué, sur les
  // deux écrans à la fois. Voir `useSearchResults`.
  // La recherche de la gestion en était une troisième copie, sous le `keepPreviousData` global.
  it.each(["src/components/player/PlayerSearchPanel.tsx", "src/components/player/PlayerListAdd.tsx", "src/components/GlobalSearch.tsx"])("%s", (f) => {
    const src = lire(f);
    expect(src).toContain("useSearchResults(");
    // L'option, pas le mot : les commentaires l'expliquent, et c'est bien leur rôle.
    expect(src).not.toMatch(/keepPreviousData:/);
  });
});

describe("« Reprendre » et « Ma liste » tiennent leur place, sur les deux interfaces", () => {
  // Le squelette évite qu'elles fassent sauter l'écran en arrivant quand rien n'est encore connu —
  // ni sur l'appareil, ni du réseau. « Reprendre » décide sa place dans `useContinueRow`.
  it.each(["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"])(
    "%s",
    (f) => {
      const src = lire(f);
      expect(src).toContain("useCinemaMyListPending()");
      expect(src).toContain("continueRowState.pending");
      expect(src.match(/<CinemaSkeletonCards /g)?.length).toBeGreaterThanOrEqual(2);
    }
  );
});

describe("« Reprendre » : une seule rangée, dessinée du cache et corrigée en glissant (§86)", () => {
  /**
   * Les deux accueils avaient chacun leurs `useSWR` sur « Reprendre » et « À suivre », leur tri,
   * leur place tenue et leurs « Lire » à la position du flux. Une rangée dessinée depuis le cache de
   * l'appareil ne doit jamais lancer la position du cache : la règle tient dans `useContinueRow`,
   * et ni l'un ni l'autre ne la réécrit.
   */
  it.each(["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"])(
    "%s passe par useContinueRow",
    (f) => {
      const src = lire(f);
      expect(src).toContain("useContinueRow(continueTrack)");
      expect(src).toContain("continueRowState.shown");
      expect(src).not.toMatch(/useSWR<[^>]*>\((RESUME_KEY|NEXT_UP_KEY)/);
      expect(src).not.toMatch(/feedResumeAt\(|bannerResumeAt\(/);
      expect(src).not.toMatch(/useFlipGrid\(continueTrack/);
      // Chaque lecture lancée depuis les flux attend la réponse fraîche.
      expect(src).toMatch(/playWhenFresh\(\(feeds\) => [\w.]*play\(movieStartFrom\(feeds/);
    }
  );
});

describe("Jellyfin en panne : une seule conduite pour les deux accueils (§92)", () => {
  /**
   * Le bandeau, l'écran sans catalogue (Réessayer, essai annoncé), la relecture toutes les 30 s d'un
   * catalogue de secours et le message d'un titre introuvable : décidés dans `catalogueOutage.ts` et
   * `CatalogueOutage.tsx`. Le bureau avait son écran noir et le téléphone sa ligne rouge — deux
   * réponses à une seule panne.
   */
  it.each(["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"])(
    "%s passe par les pièces communes",
    (f) => {
      const src = lire(f);
      expect(src).toContain("useCatalogueOutage(movies, series)");
      expect(src).toContain("<CatalogueOutageBanner outage={outage}");
      expect(src).toContain("<CatalogueUnavailable error=");
      expect(src).toContain("sheetRepairDuring(route.film, moviesError, movies, seriesError, series, outage)");
      // La relecture de panne vit dans `useCatalogueOutage`, pas dans les accueils.
      expect(src).not.toMatch(/refreshInterval/);
    }
  );

  // Un fichier téléchargé n'a pas besoin de Jellyfin (§109) : il part pendant la panne.
  it("le bouton Lecture est refusé à un seul endroit : l'ouverture du lecteur", () => {
    expect(lire("src/components/PlaybackProvider.tsx")).toMatch(/if \(!s\.offline && playBlockedByOutage\(\)\) return;/);
  });
});

describe("« Ma liste » ne se propose qu'à un titre qui a un identifiant TMDB", () => {
  /**
   * Sonarr ne résout pas toujours d'identifiant TMDB pour une série. Les deux fiches envoyaient
   * alors `tmdbId ?? 0` : la route répondait 400, et la fiche en affichait l'erreur brute — en
   * français quelle que soit la langue du compte. Relevé le 21/09/2026.
   */
  it("la règle est une fonction, et elle refuse l'absence comme le zéro", async () => {
    const { canJoinWatchlist } = await import("@/lib/useAddToWatchlist");
    expect(canJoinWatchlist(null)).toBe(false);
    expect(canJoinWatchlist(undefined)).toBe(false);
    expect(canJoinWatchlist(0)).toBe(false);
    expect(canJoinWatchlist(1396)).toBe(true);
  });

  // Le bouton lui-même n'est rendu que si la règle l'accepte — une garde dans le seul geste
  // laisserait un bouton qui ne fait rien.
  it.each([
    ["src/components/cinema/CinemaSeriesDetail.tsx", /\{listable && \(\s*<button\s+data-detail-menu\s+onClick=\{toggleAddToList\}/],
    ["src/components/cinema/mobile/CinemaMobileDetail.tsx", /\{canJoinWatchlist\(tmdbId\) && \(\s*<button type="button" onClick=\{toggleInList\}/],
  ])("%s la demande avant de dessiner le bouton", (f, guarded) => {
    const src = lire(f);
    expect(src).toMatch(guarded);
    // La forme exacte qui portait la faute sur la fiche du bureau.
    expect(src).not.toMatch(/tmdbId: item\.tmdbId \?\? 0/);
  });
});

describe("une seule animation de colonne pour les fiches du bureau", () => {
  /**
   * `closing ? "animate-fade-out-down" : "animate-fade-in-up"`, écrit deux fois, et une troisième
   * sans sortie : au retour arrière, le texte des fiches remontait quand même. Voir
   * `detailColumnMotion` (23/09/2026).
   */
  it.each([
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
  ])("%s", (f) => {
    const src = lire(f);
    expect(src).toContain("detailColumnMotion(");
    expect(src).not.toMatch(/closing \? "animate-fade-out-down" : "animate-fade-in-up"/);
    expect(src).not.toContain("flex animate-fade-in-up flex-col");
  });
});

describe("une seule hauteur de bannière pour l'écran du bureau et son squelette", () => {
  // Le squelette était resté à 50 % quand l'écran est passé à 44 : les rangées remontaient d'un
  // coup à chaque chargement à froid (23/09/2026). Voir `HERO_BASIS`.
  it("aucune hauteur de bannière écrite en dur", () => {
    const src = lire("src/components/cinema/CinemaClient.tsx");
    expect(src).not.toMatch(/flexBasis: "\d+%"/);
    expect(src.match(/flexBasis: HERO_BASIS/g)?.length).toBe(2);
  });
});

describe("une fiche qu'on tire ne reconstruit pas ses rangées", () => {
  /**
   * Un glissement de fermeture redessine la fiche à chaque mouvement du doigt. Ce qui est lourd y
   * est mémorisé, mais une mémorisation ne sert à rien si on lui passe un tableau construit en
   * ligne : il est neuf à chaque rendu (23/09/2026, fermeture des fiches découverte saccadée). La
   * filmographie des fiches personne a son propre test de rendu (player-person-sheet.test.tsx).
   */
  it("la distribution n'est pas reconstruite à chaque rendu", () => {
    for (const f of ["src/components/player/PlayerDiscoverSheet.tsx"]) {
      expect([f, /cast=\{castFromTitle\(/.test(lire(f))]).toEqual([f, false]);
    }
  });
});

describe("« Retirer de Reprendre », sur les deux écrans et pour les films seulement", () => {
  // Un geste présent d'un côté et absent de l'autre est une moitié de correctif (CLAUDE.md). Et
  // « À suivre » ne se retire pas d'une série sans la marquer vue : pas de menu sur un épisode.
  it("le bureau : sur les films de la rangée", () => {
    const src = lire("src/components/cinema/CinemaClient.tsx");
    // Un seul menu, posé sur les films seulement (la carte reçoit un rappel stable — 08/10/2026).
    expect(src.match(/onMenu=\{entry\.kind === "movie" \? openContinueMenu : undefined\}/g)?.length).toBe(1);
    expect(src.match(/setResumeMenu\(\{/g)?.length).toBe(1);
    expect(src).toContain("useRemoveFromResume()");
  });
  it("le téléphone : sur les films de la rangée", () => {
    const src = lire("src/components/cinema/mobile/CinemaMobileClient.tsx");
    expect(src.match(/<LongPressButton\b/g)?.length).toBe(1);
    expect(src).toContain("useRemoveFromResume()");
  });
});

describe("une seule façon de savoir qui l'on est pour Jellyseerr", () => {
  // Quatre endroits le résolvaient, de trois façons, dont une qui ne savait lire que le cookie de
  // session : un compte sans cookie y devenait « personne », ou signait au nom du propriétaire de
  // la clé (23/09/2026). La réponse vit dans jellyseerrIdentity.ts, et nulle part ailleurs.
  it("ni getMe ni recherche par nom en dehors du module d'identité", () => {
    const racines = ["src/app", "src/lib", "src/components"];
    const fichiers: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) parcourir(p);
        else if (/\.tsx?$/.test(e.name)) fichiers.push(p);
      }
    };
    racines.forEach(parcourir);
    const fautifs = fichiers.filter(
      (f) =>
        !f.endsWith("jellyseerrIdentity.ts") &&
        !f.endsWith("clients/jellyseerr.ts") &&
        /jellyseerr\.getMe\(|jellyfinUsername\?\.toLowerCase\(\)/.test(lire(f)),
    );
    expect(fautifs).toEqual([]);
  });
});

describe("les notifications se règlent à un seul endroit", () => {
  // La gestion et le panneau Compte réglaient les mêmes choix sous des libellés différents
  // (23/09/2026). Il n'en reste qu'un : le panneau Compte.
  it("la gestion ne dessine plus ses propres interrupteurs de notification", () => {
    // Toutes les pages de la Configuration (DECISIONS.md §81), et leurs cartes communes.
    const src = ["", "/lecture", "/sous-titres", "/comptes", "/administration", "/deploiement"]
      .map((p) => lire(`src/app/(dashboard)/parametres${p}/page.tsx`))
      .concat(lire("src/components/settings/AdminTools.tsx"))
      .join("\n");
    expect(src).not.toMatch(/NOTIFICATION_CATEGORIES|\/api\/notifications\/settings|\/api\/push\/test/);
  });
});

describe("un titre similaire s'ouvre sans toucher à l'onglet, sur les deux écrans", () => {
  // Le téléphone réécrivait l'onglet (`openLibraryTitle`) : la fiche du dessous se démontait et la
  // grille changeait d'onglet sous la fiche — le défaut corrigé sur le bureau le 21/09/2026, resté
  // entier sur le téléphone jusqu'au 23/09/2026.
  it("le téléphone passe par openSimilarTitle", () => {
    const src = lire("src/components/cinema/mobile/CinemaMobileClient.tsx");
    expect(src).toMatch(/onSelectSimilar=\{\(next\) => openSimilarTitle\(/);
  });
});

describe("un seul « ce navigateur lira-t-il le HLS lui-même ? »", () => {
  /**
   * La sonde des codecs et l'hôte du lecteur serveur posaient la question chacun à sa manière :
   * la première demandait WebKit, le second seulement `canPlayType`. Opera sous Windows
   * (25/09/2026) a été sondé comme hls.js puis servi au HLS intégré de Chromium, qui a refusé.
   */
  it("src/lib/codecSupport.ts passe par playsHlsNatively", () => {
    const code = sansCommentaires(lire("src/lib/codecSupport.ts"));
    expect(code).toMatch(/playsHlsNatively\(/);
    expect(code).not.toMatch(/canPlayType\(\s*["']application\/vnd\.apple\.mpegurl/);
  });

  it("le lecteur serveur passe par playsHlsNatively, et personne dans le lecteur ne pose la question à sa façon", () => {
    expect(codeDe(SERVEUR)).toMatch(/playsHlsNatively\(/);
    expect(lecteurQui(/canPlayType\(\s*["']application\/vnd\.apple\.mpegurl/)).toEqual([]);
  });
});

describe("une seule bannière face aux données fraîches", () => {
  /**
   * Le bureau et le téléphone ont chacun leur bannière et leur rotation. La règle « on suit le titre
   * affiché, la nouveauté vient au passage suivant, l'ordre officiel revient hors de l'écran » ne
   * vit que dans `heroCarousel.ts` (25/09/2026) : une rotation par index qui reviendrait d'un côté
   * ferait de nouveau désigner un autre film à l'arrivée d'une nouveauté.
   */
  const code = (f: string) =>
    lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");

  it.each(["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileHero.tsx"])(
    "%s tourne par useHeroOrder, et non par un index à lui",
    (f) => {
      expect(code(f)).toMatch(/useHeroOrder\(/);
      expect(code(f)).not.toMatch(/useRotatingIndex\(/);
    }
  );

  it("les deux écrans jugent « hors de l'écran » par la même fonction", () => {
    expect(code("src/components/cinema/CinemaClient.tsx")).toMatch(/heroOffscreen\(/);
    expect(code("src/components/cinema/mobile/CinemaMobileClient.tsx")).toMatch(/heroOffscreen\(/);
  });
});

describe("un seul « rien à montrer tant que ça charge »", () => {
  /**
   * 25/09/2026 : le catalogue de la dernière visite était posé pendant que la requête courait, et le
   * bureau restait sur ses squelettes jusqu'à la réponse réseau — il lisait `isLoading` seul, que
   * SWR garde vrai tant que la première requête n'a pas répondu, donnée présente ou non.
   */
  it.each([
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
    "src/components/player/PlayerListPanel.tsx",
  ])("%s attend par nothingToShowYet", (f) => {
    const code = lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).toMatch(/nothingToShowYet\(/);
    // Un indicateur de chargement lu seul, sans la donnée, ne doit pas revenir.
    expect(code).not.toMatch(/if \((movies|series)Loading\)|\{(movies|series)Loading && \(/);
  });
});

describe("un seul chemin pour les onglets gardés, les rangées chauffées et les listes fraîches", () => {
  /**
   * 25/09/2026 : le bureau et le téléphone gardent chacun leurs onglets montés, chauffent chacun
   * leurs rangées et redemandent chacun les listes de la personne. Une règle, trois porteurs,
   * deux écrans — et aucun des deux ne doit la réécrire à sa façon.
   */
  it.each(["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"])(
    "%s passe par useKeptTabs, tabPaneProps, useDecodeRowsAhead et useFreshPersonalLists",
    (f) => {
      const code = lire(f);
      for (const porteur of ["useKeptTabs(", "tabPaneProps(", "useDecodeRowsAhead(", "useFreshPersonalLists("]) {
        expect([f, porteur, code.includes(porteur)]).toEqual([f, porteur, true]);
      }
    }
  );
});

describe("une seule position d'ouverture pour le lecteur et pour la reprise instantanée", () => {
  /**
   * 25/09/2026 : la reprise instantanée garde les octets de l'ouverture à la position reculée. Si
   * l'hôte recalculait le recul à sa façon, les octets gardés ne seraient plus ceux qu'il lit — rien
   * ne casserait, l'ouverture redeviendrait simplement « mixte ». Les deux passent par
   * `openingPosition` — et la reprise instantanée, qui garde d'avance sans savoir quand on ouvrira,
   * par `openingSpan`, qui couvre toutes ses ouvertures possibles (28/09/2026).
   */
  it("src/lib/resumeCache/useResumeCache.ts passe par openingSpan, sans appeler awayFrom", () => {
    const code = sansCommentaires(lire("src/lib/resumeCache/useResumeCache.ts"));
    expect(code).toMatch(/openingSpan\(/);
    expect(code).not.toMatch(/awayFrom\(/);
  });

  it("le lecteur natif passe par openingPosition, et personne dans le lecteur n'appelle awayFrom", () => {
    expect(codeDe(NATIF)).toMatch(/openingPosition\(/);
    expect(lecteurQui(/awayFrom\(/)).toEqual([]);
  });
});

describe("une seule décision pour ce qu'une fiche montre avant le réseau", () => {
  /**
   * 25/09/2026 : les trois fiches d'un titre de la bibliothèque attendaient chacune le réseau pour
   * la durée, le synopsis et « Reprendre », et chacune le lisait à sa façon. Elles passent toutes
   * par `sheetFacts.ts` ; le synopsis de TMDB ne doit plus passer devant celui du catalogue.
   */
  it.each([
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
  ])("%s passe par useSheetPlayFacts, sheetOverview, useFileMissing et useLateArrival", (f) => {
    const code = lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    for (const porteur of ["useSheetPlayFacts(", "sheetOverview(", "useFileMissing(", "useLateArrival("]) {
      expect([f, porteur, code.includes(porteur)]).toEqual([f, porteur, true]);
    }
    expect(code).not.toMatch(/info\?\.tmdb\?\.overview \|\|/);
  });
});

describe("un seul endroit rend le volume retenu", () => {
  // DECISIONS.md §35. Le lecteur serveur relisait la valeur à la main, le lecteur natif pas du
  // tout (29/09/2026) : les deux passent par `restoreRememberedVolume`, et la clé n'est lue nulle
  // part ailleurs.
  // Le comportement est éprouvé par `remembered-volume.test.tsx` (natif) et
  // `decisions-partagees-lecteur.test.tsx` (serveur). Les commandes, seules à écrire la clé, sont
  // hors du graphe de chaque hôte (`codeDe`).
  it.each(HOTES)("%s appelle `restoreRememberedVolume` et ne lit pas la clé lui-même", (hote) => {
    const code = codeDe(hote);
    expect(code).toMatch(/restoreRememberedVolume\(/);
    expect(code).not.toMatch(/VOLUME_STORAGE_KEY|cine:player-volume/);
  });
});

describe("une seule règle pour l'erreur du catalogue", () => {
  // DECISIONS.md §37. Le bureau testait `moviesError` seul et remplaçait tout l'écran, catalogue en
  // main ; le téléphone gardait ses rangées (29/09/2026). Les deux clients passent par
  // `catalogueErrorView`, et aucun ne teste plus l'erreur nue.
  it.each([
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
  ])("%s appelle `catalogueErrorView`", (f) => {
    const code = lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect([f, code.includes("catalogueErrorView(moviesError, movies)")]).toEqual([f, true]);
    expect([f, /if \(moviesError\)|\{moviesError &&|\{seriesError &&/.test(code)]).toEqual([f, false]);
  });
});

describe("une seule règle pour la saison ouverte", () => {
  // DECISIONS.md §38. Le bureau ouvrait la première saison possédée, le téléphone la première de
  // la réunion possédées ∪ manquantes, recalculée à chaque rendu (29/09/2026). Les deux passent par
  // `openingSeason`, et aucun n'appelle plus `defaultSeason` lui-même.
  it.each([
    "src/components/cinema/CinemaEpisodeBrowser.tsx",
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
  ])("%s appelle `openingSeason`", (f) => {
    const code = lire(f)
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect([f, code.includes("openingSeason(")]).toEqual([f, true]);
    expect([f, /defaultSeason\(/.test(code)]).toEqual([f, false]);
  });
});

describe("une seule clé pour la grille complète", () => {
  // DECISIONS.md §39. Le bureau donnait à `CinemaBrowseSheet` une clé par genre, le téléphone
  // aucune : rouvrir « Voir tout » sur un autre genre pendant la sortie de la grille précédente y
  // gardait son tri, sa décennie et sa recherche (29/09/2026). Les deux passent par `browseSheetKey`.
  it.each([
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
  ])("%s donne à chaque grille la clé de `browseSheetKey`", (f) => {
    const grids = lire(f).match(/<CinemaBrowseSheet[\s\S]*?\/>/g) ?? [];
    expect([f, grids.length > 0]).toEqual([f, true]);
    for (const g of grids) expect([f, /key=\{browseSheetKey\(/.test(g)]).toEqual([f, true]);
  });
});

describe("une seule recherche d'ajout de la gestion", () => {
  // DECISIONS.md §40. Les fenêtres « Ajouter » de Radarr et de Sonarr lisaient chacune la réponse
  // sans `res.ok` : un 502 les laissait vides et muettes (29/09/2026). Les deux passent par
  // `useLookupSearch`, et aucune n'appelle plus l'adresse de recherche elle-même.
  it.each([
    ["src/app/(dashboard)/radarr/page.tsx", "/api/radarr/movies/lookup"],
    ["src/app/(dashboard)/sonarr/page.tsx", "/api/sonarr/series/lookup"],
  ])("%s", (f, url) => {
    const src = lire(f);
    expect([f, src.includes(`useLookupSearch<`)]).toEqual([f, true]);
    expect([f, src.includes(`fetch(\`${url}`)]).toEqual([f, false]);
  });
});

describe("une seule signature", () => {
  // DECISIONS.md §41. « CineApp 8.1 par LK59 · GitHub » s'affiche à trois endroits, et à trois
  // endroits seulement : chacun rend `<AppSignature />`, et le texte n'est écrit nulle part ailleurs
  // — une version recopiée à la main finit toujours par en annoncer une autre (29/09/2026).
  const EMPLACEMENTS = [
    "src/components/player/PlayerAccountPanel.tsx",
    "src/app/login/page.tsx",
    "src/components/Sidebar.tsx",
    "src/components/MobileNav.tsx",
  ];

  it.each(EMPLACEMENTS)("%s rend <AppSignature />", (f) => {
    expect([f, /<AppSignature\b[^>]*\/>/.test(lire(f))]).toEqual([f, true]);
  });

  it("aucun autre fichier ne l'écrit ni ne l'appelle", () => {
    const files = (readdirSync("src", { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"))
      .map((f) => `src/${f.replaceAll("\\", "/")}`);
    const porteurs = ["src/components/AppSignature.tsx", "src/lib/appBuild.ts"];
    const autres = files.filter((f) => !porteurs.includes(f) && !EMPLACEMENTS.includes(f));
    // Ni le composant ailleurs, ni l'adresse du dépôt, ni « by LK59 » recopiés à la main.
    const fautifs = autres.filter((f) => /<AppSignature\b|github\.com\/LK59|\bby LK59\b|APP_REPOSITORY_URL/.test(lire(f)));
    expect(fautifs).toEqual([]);
    for (const f of EMPLACEMENTS) expect([f, /github\.com\/LK59|by LK59/.test(lire(f))]).toEqual([f, false]);
  });
});

describe("un seul instant pour une ligne en retard", () => {
  // DECISIONS.md §42. La séance et la frise lisaient chacune `lateByMs`, chacune pour `stop`
  // seulement : le jour où les lignes renvoyées l'ont porté aussi (01/10/2026), il fallait les
  // changer toutes deux, ou placer la même ligne à deux instants.
  it("seul `lineLateByMs` lit le retard d'une ligne", () => {
    const lecteurs = (readdirSync("src/lib/activity", { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => `src/lib/activity/${f.replaceAll("\\", "/")}`);
    const codeOnly = (f: string) =>
      lire(f)
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
    // Permis : le porteur lui-même, et le résumé de la séance qui garde le chiffre brut
    // (`lateByMs: num(r.lateByMs)`) — ce n'est pas une datation.
    const reste = (f: string) =>
      codeOnly(f)
        .replace(/export function lineLateByMs[\s\S]*?\n}\n/, "")
        .replace(/lateByMs: num\(r\.lateByMs\)/g, "");
    expect(lecteurs.filter((f) => /\.lateByMs\b/.test(reste(f)))).toEqual([]);
  });
});

describe("une seule minuterie de veille", () => {
  // DECISIONS.md §43. Les deux lecteurs ont les mêmes commandes et la même minuterie : chacun monte
  // `useSleepTimer`, et « Fin de l'épisode » se lit par `blocksAutoAdvance` — dans les commandes
  // (ni carte ni décompte) comme à la fin du fichier (l'hôte reste sur sa fin).
  it.each([
    [NATIF, /holdAtEndRef\.current\(\)/],
    [SERVEUR, /holdAtEnd\(\)/],
  ])("%s monte useSleepTimer et lui demande la fin", (hote, fin) => {
    const code = codeDe(hote);
    expect([hote, /useSleepTimer\(/.test(code), fin.test(code)]).toEqual([hote, true, true]);
  });

  // Que la carte disparaisse sous « Fin de l'épisode » est éprouvé à l'écran par
  // `decisions-partagees-commandes.test.tsx` ; ici, que les commandes lisent le magasin et que le
  // magasin décide par `blocksAutoAdvance`.
  it("les commandes retirent la carte de l'épisode suivant par la même règle", () => {
    expect(codeDe("PlayerControls")).toMatch(/useSyncExternalStore\([^)]*sleepBlocksAdvanceSnapshot/);
    expect(lire("src/lib/sleepTimer.ts")).toMatch(/sleepBlocksAdvanceSnapshot = \(\): boolean => blocksAutoAdvance\(state\)/);
  });

  it("aucun minuteur de veille n'est tenu ailleurs que dans le magasin", () => {
    const files = (readdirSync("src", { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"))
      .map((f) => `src/${f.replaceAll("\\", "/")}`)
      .filter((f) => f !== "src/lib/sleepTimer.ts");
    expect(files.filter((f) => /tickSleepTimer|chooseSleepTimer\(/.test(lire(f)))).toEqual([]);
  });
});

describe("une seule suite de saga", () => {
  // DECISIONS.md §44. L'écran de fin lit la saga par le crochet de la rangée de la fiche — pas par
  // une seconde route qui finirait par ranger les films autrement — et ne décide de la suite que
  // par `collectionSuite`.
  it("l'écran de fin passe par useCinemaCollection et collectionSuite", () => {
    const src = lire("src/components/player/PlayerEndScreen.tsx");
    expect(src).toMatch(/useCinemaCollection\(/);
    expect(src).toMatch(/collectionSuite\(/);
    expect(src).not.toMatch(/\/api\/tmdb\/collection/);
  });
});

describe("un seul défilement guidé (§50)", () => {
  // Le calage vertical du cinéma est réglable par compte : un `snap-y snap-mandatory` écrit à la
  // main sur un nouvel écran ignorerait le réglage de la personne.
  it("aucun écran du cinéma n'écrit le calage à la main", () => {
    const dir = "src/components/cinema";
    const offenders = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /snap-y snap-mandatory/.test(lire(`${dir}/${f}`)));
    expect(offenders).toEqual([]);
  });

  it("les trois volets qui défilent passent par guidedScrollClass", () => {
    // Les fiches (film, série, découverte) par `CinemaDetailPages` depuis le 14/10/2026.
    expect(lire("src/components/cinema/CinemaClient.tsx")).toMatch(/guidedScrollClass\(guidedScroll\)/);
    expect(lire("src/components/cinema/CinemaDetailPages.tsx")).toMatch(/guidedScrollClass\(guided\)/);
  });
});

describe("une seule ouverture de fiche (§61)", () => {
  // L'affiche touchée devient le visuel de la fiche, et la fiche y retourne : quatre fiches, un seul
  // crochet. Une fiche qui réécrirait sa propre sortie (`sheet-out`, un fondu de sortie sur sa racine)
  // la jouerait par-dessus celle de la copie — deux mécanismes de sortie, ce que la règle du cycle de
  // vie des fiches interdit.
  const SHEETS = [
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
  ];

  it.each(SHEETS)("%s passe par useSheetMorph, sans sortie CSS à elle", (f) => {
    const src = lire(f);
    // Directement, ou par `useSheetTransition` — qui choisit au montage entre lui et la continuité
    // du fond au bureau, et l'appelle toujours.
    expect(src).toMatch(/useSheetMorph\(\{|useSheetTransition\(\{/);
    expect(src).not.toMatch(/"sheet-out"/);
    expect(src).not.toMatch(/\? "animate-fade-out"/);
  });

  it("le choix entre trajet et continuité est fait en un seul endroit, qui appelle les deux crochets", () => {
    const src = lire("src/lib/sheetMorph/desktopContinuity.ts");
    expect(src).toMatch(/export function useSheetTransition\(/);
    expect(src).toMatch(/useSheetMorph\(\{ \.\.\.opts, off: continuity \}\)/);
    expect(src).toMatch(/useDesktopContinuity\(\{ \.\.\.opts, off: !continuity \}\)/);
  });

  it("la maquette du banc joue le moteur des vraies fiches, sans copie à elle", () => {
    const src = lire("src/components/animlab/IntroLots.tsx");
    expect(src).toMatch(/from "@\/lib\/sheetMorph\/motion"/);
    for (const fn of ["criticalSpring", "appleResponse", "morphTracks", "sampleMotion", "coverTf"]) {
      expect(src, fn).not.toMatch(new RegExp(`function ${fn}\\(`));
    }
  });
});

describe("une seule lecture des repères d'un épisode", () => {
  // DECISIONS.md §65. Les routes du lecteur natif et du lecteur serveur recopiaient chacune la
  // conversion des repères ; le récap n'aurait été ajouté qu'à l'une. Les deux passent par
  // `playerMarkers`, et aucune ne relit plus `timestamps.Introduction` à la main.
  it.each(["src/app/api/jellyfin/direct/[itemId]/route.ts", "src/app/api/jellyfin/playback/start/route.ts"])(
    "%s appelle `playerMarkers`",
    (f) => {
      const code = lire(f);
      expect([f, code.includes("playerMarkers(timestamps)")]).toEqual([f, true]);
      expect([f, /timestamps\?\.(Introduction|Credits|Recap)/.test(code)]).toEqual([f, false]);
    }
  );

  // Un seul bouton, et le bon, est éprouvé à l'écran par `decisions-partagees-commandes.test.tsx`.
  it("un seul bouton « Passer… », décidé par `activeSkip`", () => {
    expect(codeDe("PlayerControls")).toMatch(/activeSkip\(\s*\w+\s*,\s*introSkip\s*,\s*recapSkip\s*\)/);
    expect(lecteurQui(/(currentTime|time) >= (introSkip|recapSkip)\.start/)).toEqual([]);
  });
});

describe("une seule recherche de ligne pour les sous-titres tenus en mémoire", () => {
  // DECISIONS.md §70. Les fichiers à côté du film et les lignes d'une génération en cours se cherchent
  // par la même bissection (`cueTextAt`) : une seconde copie divergerait le jour où l'une est corrigée
  // — la marche arrière de 8 à 32 lignes l'a déjà été une fois.
  it.each(["src/lib/webcodecs/externalSubtitles.ts", "src/lib/subtitleGen/generatedCues.ts"])("%s passe par `cueTextAt`", (f) => {
    expect(lire(f)).toMatch(/cueTextAt\(/);
  });

  it("la bissection n'est écrite qu'une fois", () => {
    expect(lire("src/lib/webcodecs/externalSubtitles.ts").match(/low - 32/g)).toHaveLength(1);
    expect(lire("src/lib/subtitleGen/generatedCues.ts")).not.toMatch(/low - 32|simultaneousText/);
  });

  it("les étiquettes des pistes générées passent par `trackLabel.ts`", () => {
    expect(codeDe(NATIF)).toMatch(/genere: t\("player\.trackLabel\.generated"\)/);
    expect(lecteurQui(/— généré|— génération/)).toEqual([]);
  });
});

describe("un survol ne désigne une affiche que si le pointeur a bougé", () => {
  // DECISIONS.md §71. Cinq cartes prêtent la bannière au survol ; une seule nue, et la carte qui
  // glisse sous une souris immobile (ou sous le curseur laissé au bord par Silk) reprend la bannière
  // à celle qui a le focus.
  it.each([
    "src/components/cinema/CinemaCard.tsx",
    "src/components/cinema/CinemaSeriesCard.tsx",
    "src/components/cinema/CinemaTop10Card.tsx",
    "src/components/cinema/CinemaClient.tsx",
  ])("%s passe par `onRealHover`", (f) => {
    const src = lire(f);
    expect(src).toMatch(/onMouseEnter=\{[^}]*onRealHover\(/);
    expect(src).not.toMatch(/onMouseEnter=\{(\(\) => onFocusItem|onFocusItem\}|focus\})/);
  });

  // Une carte de découverte ne prête plus rien à la bannière (14/10/2026, §52) : ni survol ni focus,
  // elle garde le dernier titre de la bibliothèque — rien à filtrer, donc.
  it("la rangée de découverte n'écoute ni survol ni focus", () => {
    const src = lire("src/components/cinema/CinemaDiscoveryRow.tsx");
    expect(src).not.toMatch(/onMouseEnter=|onFocus=/);
  });
});

describe("les rangées de découverte : un même choix d'onglet, une même place (§52, 14/10/2026)", () => {
  // Le bureau posait « Recommandé » et « Tendances films » après le dernier genre, et n'affichait
  // jamais « Parce que vous avez regardé… » ; le téléphone les mettait sous les derniers ajouts.
  it.each([
    ["src/components/cinema/CinemaClient.tsx", /t\("cinema\.recentlyAdded"\)/, /\?\.genres\.map\(/],
    ["src/components/cinema/mobile/CinemaMobileClient.tsx", /t\("cinema\.recentlyAdded"\)/, /payload\?\.genres\.map\(/],
  ] as const)("%s passe par discoveryRowsFor et discoveryEyebrow, sous les derniers ajouts", (f, recent, genres) => {
    const src = lire(f);
    expect(src).toMatch(/discoveryEyebrow\(row, t, locale\)/);
    expect(src).not.toMatch(/row\.key === "trendingSeries"|row\.key !== "trendingSeries"|row\.key === "recommended"/);
    // Chaque appel tombe entre une rangée des derniers ajouts et la suivante des genres.
    const calls = [...src.matchAll(/discoveryRowsFor\(/g)].map((m) => m.index!);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) {
      const before = src.slice(0, at);
      const after = src.slice(at);
      expect(before).toMatch(recent);
      expect(after).toMatch(genres);
      // Aucun genre entre les derniers ajouts et la découverte.
      const lastRecent = before.search(new RegExp(`${recent.source}(?![\\s\\S]*${recent.source})`));
      expect(before.slice(lastRecent)).not.toMatch(genres);
    }
  });
});

describe("une seule décision d'ouvrir les Nouveautés", () => {
  // DECISIONS.md §73. La fenêtre est montée une fois, par la coquille commune au bureau et au
  // téléphone, et décide par `shouldOfferNews` — aucun des deux cinémas n'en a sa propre copie.
  const sources = () =>
    (readdirSync("src", { recursive: true }) as string[])
      .map((f) => `src/${f}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"));

  it("seul NewsGate appelle shouldOfferNews", () => {
    expect(sources().filter((f) => f !== "src/lib/news/decide.ts" && /shouldOfferNews\(/.test(lire(f)))).toEqual(["src/components/player/NewsGate.tsx"]);
  });

  it("seule la coquille du cinéma monte NewsGate", () => {
    expect(sources().filter((f) => /<NewsGate\b/.test(lire(f)))).toEqual(["src/components/player/PlayerShell.tsx"]);
  });

  it("les écrans poussés depuis le Compte sont énumérés une fois (`accountScreenOpen`)", () => {
    for (const f of ["src/lib/cinemaGridTop.ts", "src/lib/heroCarousel.ts", "src/components/player/playerNav.ts", "src/components/cinema/mobile/CinemaMobileClient.tsx"]) {
      const src = lire(f);
      expect(src).toContain("accountScreenOpen(");
      expect(src).not.toMatch(/\.report !== null/);
    }
  });
});

describe("une seule exécution de la connexion lente (§79)", () => {
  // DECISIONS.md §79. Les deux lecteurs exécutent les décisions de `slowLinkPolicy.ts` par
  // `SlowLinkRunner` : préchauffer, laisser tomber, l'écran final, le saut traité comme une ouverture.
  // Seule la bascule leur est propre. Écrite deux fois, la règle du saut avait déjà divergé.
  it.each(HOTES)("%s passe par SlowLinkRunner", (hote) => {
    expect(codeDe(hote)).toMatch(/new SlowLinkRunner\(/);
  });

  it("personne dans le lecteur ne refait ni le préchauffage ni le saut", () => {
    expect(lecteurQui(/\bstartPrewarm\(/)).toEqual([]);
    expect(lecteurQui(/prewarm\.state === "ready"/)).toEqual([]);
    expect(lecteurQui(/SEEK_AS_OPENING_MS|SEEK_GIVE_UP_MS/)).toEqual([]);
  });

  it("une seule mémoire de la version allégée : la règle des deux minutes (`playbackQuality.ts`)", () => {
    expect(lecteurQui(/\b(noteLighter|lighterFor|capForLighter)\b/)).toEqual([]);
    for (const f of ["src/lib/slowLinkPolicy.ts", "src/components/PlaybackProvider.tsx"]) {
      expect(lire(f), f).not.toMatch(/\b(noteLighter|lighterFor|capForLighter)\b/);
    }
    expect(lire("src/lib/playbackQuality.ts")).toMatch(/export function carriedLighter\(/);
  });
});

// Une fiche que le catalogue n'a pas (§47) : une seule conclusion, celle du filet, après sa
// relecture. Un second crochet qui disait « indisponible » sur le catalogue tenu effaçait l'adresse
// avant que la relecture ne parte — le titre importé pendant la séance ne s'ouvrait plus.
describe("une fiche sans titre se conclut à un seul endroit", () => {
  it("seul `useRepairUnresolvedSheet` dit « indisponible »", () => {
    const fichiers: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const chemin = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "locales") parcourir(chemin);
        } else if (/\.tsx?$/.test(e.name) && lire(chemin).includes("cinema.titleUnavailable")) fichiers.push(chemin);
      }
    };
    parcourir("src");
    expect(fichiers).toEqual(["src/lib/useRepairUnresolvedSheet.ts"]);
  });
});


describe("deux sous-titres : une apparence, une mémoire, pour les deux lecteurs", () => {
  // DECISIONS.md §87. Le lecteur natif et le lecteur serveur dessinent le second par le même calque
  // (`SubtitleLayer`) et retiennent le choix par les mêmes fonctions : un empilement ou une mémoire
  // écrits deux fois diffèreraient d'un lecteur à l'autre pour le même film.
  it.each(HOTES)("%s dessine par `SubtitleLayer` et retient par `rememberDual` / `pickRememberedDual`", (hote) => {
    const host = codeDe(hote);
    expect(host).toMatch(/<SubtitleLayer/);
    expect(host).toMatch(/rememberDual\(/);
    expect(host).toMatch(/pickRememberedDual\(/);
  });

  it("la clé de la mémoire et la teinte du second ne sont écrites qu'une fois", () => {
    expect(lecteurQui(/cine:dual-subtitles|SECOND_SUBTITLE_SCALE|#e2e5e9/)).toEqual([]);
  });
});

describe("un seul lien d'un élément Jellyfin vers son titre", () => {
  // DECISIONS.md §89. « Reprendre », « À suivre » et le « vu » reliaient chacun Jellyfin au catalogue
  // par les identifiants que Jellyfin avait posés — ceux qu'il avait compris : *Aliens* rangeait son vu
  // sous *Alien³*, une série mal identifiée laissait une carte de reprise qui n'ouvrait rien. Ils lisent
  // tous la même carte, tirée du rapprochement par dossier (`catalogueLinks`).
  const LECTEURS = ["src/app/api/jellyfin/resume/route.ts", "src/app/api/cinema/next-up/route.ts", "src/lib/watched.ts"];
  // `catalogueLinksState` : les mêmes liens, avec le fait qu'ils sont entiers (14/10/2026, §92).
  it.each(LECTEURS)("%s lit `catalogueLinks` (directement, par `catalogueLinksState` ou par `seriesCatalogueIds`)", (f) => {
    expect([f, /catalogueLinks\(|catalogueLinksState\(|seriesCatalogueIds\(/.test(lire(f))]).toEqual([f, true]);
  });
  it("aucun ne retrouve la fiche par les identifiants de Jellyfin", () => {
    for (const f of ["src/app/api/jellyfin/resume/route.ts", "src/app/api/cinema/next-up/route.ts"]) {
      expect([f, /ProviderIds\??\.(Tmdb|Tvdb)|cachedItemProviderIds|cachedMovies|cachedSeries/.test(lire(f))]).toEqual([f, false]);
    }
  });
});

describe("les deux pages des fiches du bureau : une écriture (DECISIONS.md §61, 14/10/2026)", () => {
  /**
   * La fiche découverte avait sa propre mise en page et elle avait dérivé : une seule page, les
   * visages dans la colonne du premier écran — qui débordait par le haut, titre sous le bouton
   * Retour (« Matchbox – Le film »). Le film, la série et la découverte passent par les mêmes pièces.
   */
  const FICHES = [
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
  ];
  it.each(FICHES)("%s passe par `CinemaDetailPages` et `CinemaDetailTitle`", (fiche) => {
    const src = lire(fiche);
    expect(src).toContain("<CinemaDetailPages");
    expect(src).toContain("<CinemaDetailTitle");
    expect(src).toContain("<CinemaDetailCastLine");
    // Plus de section écrite à la main.
    expect(src).not.toMatch(/data-snap-section|SECTION_CLASS|guidedScrollClass/);
  });
  it("Haut et Bas dans le menu : `detailMenuArrowNav`, une fois", () => {
    for (const f of FICHES) expect([f, lire(f).includes("detailMenuArrowNav(e, containerRef.current)")]).toEqual([f, true]);
  });
});

describe("la zone illisible : un motif, une détection, un relais préparé (§93)", () => {
  // DECISIONS.md §93. Le motif est ce que le diagnostic « fichier ou appareil » reconnaît : écrit à
  // un seul endroit. La vérification de l'intégrité lit avec le lecteur du lecteur natif, en strict :
  // ce qu'elle dit sain ne lèvera pas au lecteur. Le relais préparé passe par le préchauffage de la
  // connexion lente (§78), jamais par une seconde négociation à lui.
  it("le motif « zone illisible dans le fichier » n'est écrit que dans unreadableZone.ts", () => {
    const hits = (readdirSync("src", { recursive: true }) as string[])
      .map((f) => `src/${f}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"))
      .filter((f) => lire(f).includes("zone illisible dans le fichier"));
    expect(hits).toEqual(["src/lib/webcodecs/unreadableZone.ts"]);
  });

  it("la vérification de l'intégrité lit par SampleReader, en strict", () => {
    const src = lire("src/lib/integrity/scan.ts");
    expect(src).toMatch(/new SampleReader\(/);
    expect(src).toMatch(/unreadable: "throw"/);
    expect(src).not.toMatch(/readElementHeader|=== 0x00|data\[0\] === 0/);
  });

  it("le relais préparé passe par startPrewarm, et le lecteur serveur par takeOrdinaryPrewarm", () => {
    const handover = lire("src/lib/unreadableZoneHandover.ts");
    expect(handover).toMatch(/\bstartPrewarm\(/);
    expect(handover).not.toMatch(/playback\/start/);
    expect(codeDe(SERVEUR)).toMatch(/takeOrdinaryPrewarm\(/);
  });
});

describe("le catalogue relu au premier plan : une règle, une rangée, une fiche gardée (§96)", () => {
  // DECISIONS.md §96. Le bureau et le téléphone relisent le catalogue par le même crochet, leurs
  // rangées l'affichent par le même (entrée, sortie, rien sous la main), et une fiche ouverte sur un
  // titre retiré reste ouverte par le même.
  const ACCUEILS = ["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"];

  it.each(ACCUEILS)("%s relit par useCatalogueRefresh et garde la fiche par useRetainedTitle", (f) => {
    const src = lire(f);
    expect(src).toMatch(/useCatalogueRefresh\(playback\.mode !== "closed" \|\| route\.browse !== null\)/);
    expect(src).toMatch(/useRetainedTitle\(/);
    expect(src).toMatch(/useRetiredTitleGuard\(/);
  });

  it("les rangées du catalogue passent par useCatalogueRow, jamais par useFlipGrid seul", () => {
    for (const f of ["src/components/cinema/CinemaRow.tsx", "src/components/cinema/CinemaSeriesRow.tsx", "src/components/cinema/CinemaTop10Row.tsx"]) {
      expect([f, /useCatalogueRow\(/.test(lire(f)), /useFlipGrid\(/.test(lire(f))]).toEqual([f, true, false]);
    }
    const mobile = lire("src/components/cinema/mobile/CinemaMobileClient.tsx");
    // Les affiches et le classement ; la découverte (TMDB, hors catalogue) garde `useFlipGrid`.
    expect(mobile.match(/useCatalogueRow\(/g)?.length).toBe(2);
    expect(mobile.match(/useFlipGrid\(/g)?.length).toBe(1);
  });

  it("le placement des cartes partantes n'est écrit qu'une fois (Reprendre et le catalogue)", () => {
    expect(lire("src/lib/useContinueRow.ts")).toMatch(/interleaveLeaving</);
  });

  it("la Lecture d'un titre retiré est refusée par PlaybackProvider, à côté de celle de la panne", () => {
    const src = lire("src/components/PlaybackProvider.tsx");
    expect(src).toMatch(/if \(!s\.offline && playBlockedByOutage\(\)\) return;[\s\S]{0,200}if \(!s\.offline && playBlockedByRetired\(\)\) return;/);
  });
});

describe("le temps regardé s'arrête pendant une attente, dans les trois lecteurs (§97)", () => {
  // DECISIONS.md §97. Une seule règle, `watchElementWaits` (`WatchedClock.stall`) : la coupure du
  // 15/10/2026 comptait 196 s d'image figée comme regardées sur le natif, et le lecteur serveur
  // faisait de même. La diffusion lit l'attente du récepteur (`remote.waiting`), sans élément local.
  it.each(HOTES)("%s branche watchElementWaits", (hote) => {
    expect([hote, /watchElementWaits\(/.test(codeDe(hote))]).toEqual([hote, true]);
  });

  it("la diffusion Chromecast exclut toujours l'attente du récepteur", () => {
    expect(lire("src/components/player/ChromecastPlayer.tsx")).toMatch(/const playing = [^;]*!remote\.waiting/);
  });
});

describe("une seule suite pour fermer le lecteur et passer à l'épisode suivant (§114)", () => {
  // DECISIONS.md §114. Natif, serveur, hors ligne et Chromecast écrivaient chacun la fermeture
  // (arrêt rapporté, fondu, `close(openId)` après 200 ms, relecture des vues) et l'épisode suivant
  // (ligne `stop "next"`, arrêt, `advance`) ; chaque hôte garde sa garde et ses étapes propres, la
  // suite vit dans `playerClose.ts` seulement.
  const MODULE = "src/components/player/playerClose.ts";
  const CHROMECAST = "src/components/player/ChromecastPlayer.tsx";
  const entree = (piece: string) => sansCommentaires(lire(entreeDe(piece)));

  it("seul le module ferme la lecture au terme du fondu et relit les vues", () => {
    expect(lecteurQui(/close\(\s*openId\s*\)/)).toEqual([MODULE]);
    expect(lecteurQui(/refreshAfterPlayback\(/)).toEqual([MODULE]);
  });

  it("seul le module enchaîne un épisode par `advance`", () => {
    expect(lecteurQui(/playback\.advance\(/)).toEqual([MODULE]);
  });

  it.each([NATIF, SERVEUR, "OfflinePlayerHost"])("%s ferme par closePlayerSession", (hote) => {
    expect([hote, /closePlayerSession\(/.test(entree(hote))]).toEqual([hote, true]);
  });

  it.each(HOTES)("%s passe à l'épisode suivant par advanceTo", (hote) => {
    expect([hote, (entree(hote).match(/advanceTo\(/g) ?? []).length]).toEqual([hote, 2]);
  });

  it("Chromecast ferme et enchaîne par la même suite", () => {
    const src = sansCommentaires(lire(CHROMECAST));
    expect(src).toMatch(/closePlayerSession\(/);
    expect(src).toMatch(/advanceTo\(/);
  });
});

describe("les doublons du lecteur fusionnés : une règle, un endroit (§115)", () => {
  // DECISIONS.md §115. Chaque règle ci-dessous était écrite deux à quatre fois entre les deux
  // lecteurs, ou dans la boucle de reconstruction du natif ; elle vit dans un seul module.
  const HELPERS = "src/components/player/nativeHostHelpers.ts";

  it("la ligne `rebuild` se construit dans rebuildLine seulement", () => {
    expect(lecteurQui(/reportPlayback\(\s*"rebuild",\s*\{/)).toEqual([]);
    expect(lecteurQui(/path: "remux", reason\b/)).toEqual([HELPERS]);
  });

  /** Combien de fois `motif` apparaît dans tout l'ensemble du lecteur (code sans commentaires). */
  const occurrences = (motif: RegExp) =>
    sourcesDuLecteur().reduce((n, f) => n + (sansCommentaires(lire(f)).match(new RegExp(motif.source, "g")) ?? []).length, 0);

  it("le natif entre en coupure par enterNetworkLost seulement", () => {
    expect(occurrences(/setNetworkLost\(\{/)).toBe(1);
    expect(occurrences(/lifecycle\.noteNetworkLost\(\)/)).toBe(1);
    expect((sansCommentaires(lire(entreeDe(NATIF))).match(/enterNetworkLost\(/g) ?? []).length).toBe(3);
  });

  it("le mot d'attente du natif s'efface par clearStall seulement", () => {
    expect(occurrences(/setStallAt\(null\)/)).toBe(1);
  });

  it("l'horloge du temps regardé se met en marche dans useWatchedClockRun seulement", () => {
    expect(lecteurQui(/\.run\(Date\.now\(\)\)|\.halt\(Date\.now\(\)\)/)).toEqual(["src/components/player/session/useWatchedClockRun.ts"]);
    for (const f of ["src/components/playerNative/useNativeSessionRecord.ts", entreeDe(SERVEUR), "src/components/player/ChromecastPlayer.tsx"]) {
      expect([f, /useWatchedClockRun\(watched, playing\)/.test(sansCommentaires(lire(f)))]).toEqual([f, true]);
    }
  });

  it.each(HOTES)("%s décide des deux sous-titres par secondSurvives et secondAllowed", (hote) => {
    const code = codeDe(hote);
    expect([hote, /secondSurvives\(/.test(code), /secondAllowed\(/.test(code)]).toEqual([hote, true, true]);
  });

  it("le natif démarre un changement de piste par beginAudioSwitch seulement", () => {
    expect(occurrences(/pendingSwitchRef\.current = \{/)).toBe(1);
    expect((sansCommentaires(lire(entreeDe(NATIF))).match(/beginAudioSwitch\(/g) ?? []).length).toBe(2);
  });

  it("la chronologie de deux minutes s'installe dans useSessionTimeline seulement", () => {
    const MODULE = "src/components/player/session/useSessionTimeline.ts";
    expect(lecteurQui(/new PlaybackTimeline\(/)).toEqual([MODULE]);
    expect(lecteurQui(/registerTimeline\(/)).toEqual([MODULE]);
    for (const hote of HOTES) expect([hote, /useSessionTimeline\(/.test(codeDe(hote))]).toEqual([hote, true]);
  });

  it("aucune copie de la règle des deux sous-titres hors du module", () => {
    expect(lecteurQui(/id === primary \|\| primary === null|primary === null \|\| id === primary/)).toEqual(["src/components/player/session/dualSubtitleRules.ts"]);
  });
});
