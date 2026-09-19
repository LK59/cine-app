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
