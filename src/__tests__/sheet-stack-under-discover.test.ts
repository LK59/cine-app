import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * La pile des fiches reste dessinée sous une fiche TMDB.
 *
 * Ce que ça évite, et qui n'était visible que sur un vrai appareil : une rangée de saga ouvre une
 * fiche découverte pour tout titre absent de la bibliothèque — près d'un tiers d'entre eux. Tant
 * que la pile n'était pas rendue dans ce cas, le film d'où l'on venait était démonté : on voyait
 * la grille derrière l'animation de fermeture, puis il revenait d'un coup, en haut de page.
 *
 * Le test lit la source parce que la faute était une *condition de rendu*, et qu'aucune assertion
 * sur le DOM d'un composant monté seul ne l'aurait montrée : il aurait fallu la pile, l'adresse,
 * l'historique et deux fiches. La règle, elle, tient en une ligne — et c'est cette ligne qui avait
 * été écrite trois fois de suite sans qu'on la voie.
 */
const FILES = [
  "src/components/cinema/mobile/CinemaMobileClient.tsx",
  "src/components/cinema/CinemaClient.tsx",
];

describe("la pile des fiches sous une fiche découverte", () => {
  it.each(FILES)("%s ne conditionne pas le rendu de la pile à l'absence de fiche TMDB", (file) => {
    const src = readFileSync(file, "utf8");
    // Les deux formes exactes qui portaient la faute.
    expect(src).not.toMatch(/route\.discover === null &&\s*\n\s*route\.person === null &&\s*\n\s*stack\.map/);
    expect(src).not.toMatch(/\{!sheetAbove &&\s*\n\s*\w+Stack\.map/);
  });

  it.each(FILES)("%s rend la fiche du dessus inerte quand une fiche TMDB la recouvre", (file) => {
    const src = readFileSync(file, "utf8");
    // `top` doit tomber à faux dès qu'une fiche TMDB est ouverte, sinon la fiche du dessous
    // garderait ses gestes et son plan sous une fiche qui, elle, est au-dessus d'elle.
    expect(src).toMatch(/const top = !(covered|sheetAbove) && i === \w+\.length - 1;/);
  });
});

/**
 * Une fiche ne peut pas être derrière elle-même.
 *
 * Ouvrir une fiche TMDB garde le `film` de l'adresse : sans cette garde, « ce qu'on laisse
 * derrière » désigne la fiche affichée, la pile porte deux fois la même clé, et React en remonte
 * une — la fiche du dessous se retrouvait en haut de page, puis se recalait au retour.
 */
describe("la fiche du dessous n'est jamais celle du dessus", () => {
  it("le téléphone écarte l'entrée qui désigne la fiche courante", () => {
    const src = readFileSync("src/components/cinema/mobile/CinemaMobileClient.tsx", "utf8");
    // Le motif ne fige que ce qu'il protège : une comparaison avec la fiche affichée, suivie d'un
    // abandon. La forme de la condition a déjà changé une fois — le jour où la fiche a cessé
    // d'être désignée par l'onglet — et ce test est tombé alors qu'aucune garde n'avait disparu.
    expect(src).toMatch(/id === itemId\(selected\.item\)\) return null;/);
  });

  it("le bureau garde la sienne", () => {
    const src = readFileSync("src/components/cinema/CinemaClient.tsx", "utf8");
    expect(src).toMatch(/behind\.film !== route\.film/);
    expect(src).toMatch(/behind\.serie !== route\.serie/);
  });
});

/** Les deux sortes de fiche entrent et sortent de la même façon sur téléphone. */
describe("les fiches TMDB s'animent comme les fiches de bibliothèque", () => {
  it.each([
    "src/components/player/PlayerDiscoverSheet.tsx",
    "src/components/player/PlayerPersonSheet.tsx",
  ])("%s utilise sheet-in / sheet-out", (file) => {
    const src = readFileSync(file, "utf8");
    // Par la fonction que partagent toutes les fiches qu'on tire (voir `sheetMotionClass`), dont
    // ce sont les classes par défaut — ou écrites en toutes lettres quand la fiche en ajoute.
    expect(src).toContain("sheetMotionClass(");
    const shared = readFileSync("src/lib/sheetMotion.ts", "utf8");
    expect(shared).toMatch(/out = "sheet-out"/);
    expect(shared).toMatch(/into = "sheet-in"/);
    // Les anciennes classes, qui ne ressemblaient à aucune fiche de bibliothèque.
    expect(src).not.toMatch(/"animate-slide-up/);
    expect(src).not.toMatch(/"animate-fade-out-down/);
  });

  it("leur sursis de sortie couvre sheet-out sur téléphone, plus une marge avant le démontage", () => {
    // La durée exacte ne suffisait pas : le démontage tombait sur les dernières images de la
    // sortie (23/09/2026). Voir `SHEET_UNMOUNT_SLACK_MS`.
    const src = readFileSync("src/components/player/PlayerShell.tsx", "utf8");
    expect(src).toMatch(/isMobile \? SHEET_OUT_MS \+ SHEET_UNMOUNT_SLACK_MS : EXIT_MS/);
  });
});

/**
 * Le geste de fermeture va au bout — et **un seul** mécanisme s'en charge.
 *
 * `cinemaClose` change l'adresse immédiatement : sans sursis, la fiche cesserait d'être dessinée
 * au premier pixel de sa sortie et le lancer du doigt s'interromprait net. La garantie n'a pas
 * bougé ; ce qui a changé, c'est qui la tient.
 *
 * Ces deux fiches en avaient deux à la fois, ce que la section « The sheet lifecycle » de
 * CLAUDE.md interdit : `useDelayedClose` à l'intérieur, qui retenait l'adresse 280 ms, et
 * `useExitDelay` dans la coquille, qui les gardait montées 280 ms *après* que l'adresse ait
 * changé. Les deux s'enchaînaient au lieu de se recouvrir — jusqu'à une demi-seconde de fiche
 * sortante pendant laquelle la suivante se montait déjà. C'est ce qui rendait les imbrications
 * profondes poisseuses puis bloquées : refermer deux fois de suite laissait deux écrans pleins
 * vivants en même temps, chacun avec son geste et son écouteur de touches. Signalé le 19/09/2026.
 *
 * Le sursis appartient donc à la coquille seule, qui est aussi la seule à savoir quand il est
 * inutile — une autre fiche attend derrière. Voir `sheetExitMs` dans PlayerShell.
 */
describe("la sortie des fiches TMDB n'a qu'un seul maître", () => {
  it.each([
    "src/components/player/PlayerDiscoverSheet.tsx",
    "src/components/player/PlayerPersonSheet.tsx",
  ])("%s laisse le sursis à la coquille", (file) => {
    const src = readFileSync(file, "utf8");
    // Le second mécanisme, celui qui s'ajoutait à l'autre. Sur l'appel, pas sur le mot : les
    // commentaires le nomment, et ils expliquent précisément pourquoi il n'est plus là.
    expect(src).not.toMatch(/useDelayedClose\(/);
    // Et l'état qu'il portait : la classe de sortie ne part plus que de `leaving`, donc du parent.
    expect(src).not.toMatch(/\bclosing\b/);
    // Le geste aboutit à la fermeture du parent — directement, ou décalée de deux images pour
    // que le glissement démarre avant que l'accueil se redessine (fiche personne, 23/09/2026).
    // Décalée, jamais retenue : aucune minuterie, rien qui garde la fiche montée plus longtemps.
    expect(src).toMatch(/useSwipeToDismiss\((requestClose|closeAfterSlideStarts)\)/);
    if (src.includes("useSwipeToDismiss(closeAfterSlideStarts)")) {
      expect(src).toMatch(
        /const closeAfterSlideStarts = useCallback\(\(\) => \{\s*requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => requestClose\(\)\)\);\s*\}, \[requestClose\]\);/
      );
    }
  });

  // Et le sursis existe bel et bien, sinon la fiche disparaîtrait sous le doigt.
  it("la coquille garde la fiche montée le temps de son animation", () => {
    const src = readFileSync("src/components/player/PlayerShell.tsx", "utf8");
    expect(src).toMatch(/useExitDelay\(route\.person !== null, sheetExitMs\)/);
    expect(src).toMatch(/useExitDelay\(route\.discover !== null, sheetExitMs\)/);
  });
});
