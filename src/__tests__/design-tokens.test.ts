import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Le vocabulaire visuel du cinéma, et ce qui ne doit pas y revenir.
 *
 * Relevé le 23/09/2026 sur les écrans du cinéma et du lecteur : neuf opacités de blanc et six gris
 * pleins pour le texte secondaire, six arrondis, trois rouges d'erreur — et des teintes de
 * l'accent (`accent-200`, `accent-300`) que le thème ne définit pas, donc que Tailwind n'émet
 * pas : le badge « en cours » d'une demande prenait la couleur de son parent au lieu de l'accent.
 *
 * Aucune de ces fautes ne se voit dans un test de comportement, et chacune revient par un simple
 * copier-coller. Ces tests lisent donc la source, comme `decisions-partagees.test.ts`.
 */

const ROOTS = [
  "src/components/cinema",
  "src/components/player",
  // La gestion prend le design du cinéma depuis le 13/10/2026 (DECISIONS.md §81) : ses pages, le
  // panneau Activité, les cartes de réglages, et les fenêtres et pièces qu'elle partage. Les gris
  // « slate » y étaient 650 — le même relevé qu'au cinéma le 23/09, deux ans de retard en moins.
  "src/app/(dashboard)",
  "src/components/activity",
  "src/components/settings",
  "src/components/gestion",
  "src/components/reports",
  ...[
    "ActionSheet", "ActorModal", "CapabilityStatus", "Collapsible", "CollectionModal", "DetailSkeleton",
    "FileTrackChips", "GlobalSearch", "KeyboardShortcutsModal", "LiquidNavPill", "MediaCard", "MediaInfoModal", "MediaRatings",
    "MobileNav", "Modal", "MoreMenu", "PageHeader", "PosterCard", "PosterImage", "Rail", "ReleaseSearchModal",
    "RequestFlowModal", "ServiceNotConfigured", "Sidebar", "SimilarMedia", "SkeletonCard", "StateViews",
    "SubtitleSearchModal", "Toggle", "TorrentDetailModal", "TrailerModal", "WatchlistButton",
  ].map((name) => `src/components/${name}.tsx`),
];

/** Les pages de la gestion et ses pièces — elles gardent leurs couleurs de séries (graphiques). */
const isGestion = (path: string) => !/src\/components\/(cinema|player)\//.test(path);

function sources(dir: string): string[] {
  if (/\.tsx?$/.test(dir)) return [dir];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = ROOTS.flatMap(sources).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** Chaque occurrence d'un motif, avec son fichier — le message d'échec dit où regarder. */
function offenders(pattern: RegExp, except: (path: string, match: string) => boolean = () => false): string[] {
  return files.flatMap(({ path, text }) =>
    [...text.matchAll(pattern)].map((m) => m[0]).filter((m) => !except(path, m)).map((m) => `${path}: ${m}`),
  );
}

describe("le texte a trois niveaux", () => {
  // `text-white`, `text-muted` (70 %), `text-subtle` (50 %). Pas d'opacité à la main, pas de
  // second système de gris.
  it("aucune opacité de blanc écrite à la main", () => {
    expect(offenders(/text-white\/[\d[]+/g)).toEqual([]);
  });

  it("aucun gris plein pour du texte", () => {
    expect(offenders(/text-(slate|gray|zinc|neutral)-\d{3}/g)).toEqual([]);
  });

  // 10 px se lit mal sur un téléphone tenu à bout de bras. La barre du bas est la seule
  // exception : ses mots sont posés sous des pictogrammes, à la taille des barres d'onglets du
  // système, et une ligne de plus lui coûterait sa place.
  // Depuis le 13/10/2026, ces libellés sont écrits une fois, dans la pilule partagée par le cinéma
  // et la gestion (`LiquidNavPill`).
  it("rien sous 11 px, hors les libellés de la barre du bas", () => {
    expect(offenders(/text-\[(\d|10)px\]/g, (path) => path.endsWith("LiquidNavPill.tsx"))).toEqual([]);
  });
});

describe("les surfaces sont neutres", () => {
  // `slate` est un gris bleuté, hérité de l'ancien fond : sur le noir neutre de l'app, il faisait
  // des champs et des cartes bleu marine (23/09/2026). La surface s'appelle `surface`.
  it("aucun fond slate", () => {
    expect(offenders(/bg-slate-\d{3}/g)).toEqual([]);
  });

  // Ni bord, ni séparateur, ni anneau, ni dégradé : « aucun slate » veut dire aucun (§81).
  it("aucun gris slate, nulle part", () => {
    expect(offenders(/\b(?:border|divide|ring|from|to|via|placeholder|fill|stroke)-slate-\d{3}/g)).toEqual([]);
  });
});

describe("les arrondis ont un rôle chacun", () => {
  // Pilule : `rounded-full`. Pastille sur une image : `rounded`. Affiche, vignette, bouton,
  // ligne de liste : `rounded-lg`. Bloc et champ : `rounded-xl`. Fiche, panneau, fenêtre :
  // `rounded-2xl`. Les deux tailles qui n'avaient pas de rôle ne reviennent pas.
  it("ni rounded-md ni rounded-3xl", () => {
    expect(offenders(/rounded(-[tblr]{1,2})?-(md|3xl)\b/g)).toEqual([]);
  });
});

describe("une couleur par état", () => {
  // `danger`, `warning`, `success`. Le rouge du badge « Nouveau » et les couleurs des sites
  // liés depuis une fiche personne ne sont pas des états.
  it("aucune teinte d'état écrite à la main", () => {
    expect(
      offenders(
        /(?:text|bg|border|ring)-(red|amber|emerald|green|yellow|rose)-\d{3}(?:\/[\d[\]]+)?/g,
        (path, m) =>
          (path.endsWith("CinemaNewBadge.tsx") && m === "bg-red-600") ||
          (path.endsWith("PlayerPersonSheet.tsx") && /amber-/.test(m)) ||
          // Dans la gestion, un fond plein est une couleur de série — la part des seeds dans le
          // disque, une barre de graphique, un point de légende —, pas un état. Les textes, bords
          // et voiles teintés, eux, disent un état et passent par les jetons.
          (isGestion(path) && /^bg-[a-z]+-\d{3}$/.test(m)),
      ),
    ).toEqual([]);
  });

  // Une teinte absente du thème ne produit aucune règle : le texte garde la couleur de son parent,
  // et rien ne le signale — ni la compilation, ni le navigateur.
  it("aucune teinte de l'accent que le thème ne définit pas", () => {
    const theme = readFileSync("src/app/globals.css", "utf8");
    const defined = new Set([...theme.matchAll(/--color-accent-(\d+):/g)].map((m) => m[1]));
    const used = offenders(/-accent-(\d+)/g).filter((line) => !defined.has(line.match(/-accent-(\d+)$/)![1]));
    expect(used).toEqual([]);
  });
});

// Chrome dessine les listes des menus déroulants lui-même : sans `color-scheme: dark`, il les
// ouvrait sur fond clair avec le texte blanc du champ — des options blanches sur blanc (23/09/2026).
describe("les contrôles natifs sont sombres", () => {
  it("le document déclare son thème sombre au navigateur", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*dark/);
  });
});

// L'accent est blanc depuis le 13/10/2026 (DECISIONS.md §83) : blanc neutre façon Apple TV, et la
// couleur réservée aux états. Deux fautes ne doivent pas revenir, et aucune ne se voit ailleurs
// qu'à l'œil : une teinte glissée dans l'échelle (le violet revenu par un copier-coller), et un
// texte blanc posé sur un fond d'accent — invisible, puisque ce fond est maintenant blanc.
describe("l'accent est blanc neutre", () => {
  const theme = readFileSync("src/app/globals.css", "utf8");
  const scale = [...theme.matchAll(/--accent-(\d+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)].map((m) => ({
    step: m[1],
    rgb: [Number(m[2]), Number(m[3]), Number(m[4])],
  }));

  it("chaque teinte de l'échelle est un gris pur", () => {
    expect(scale.length).toBeGreaterThanOrEqual(6);
    expect(scale.filter(({ rgb: [r, g, b] }) => r !== g || g !== b).map((x) => x.step)).toEqual([]);
  });

  it("les teintes pleines de l'accent sont blanches", () => {
    const solid = scale.filter((x) => ["400", "500", "600"].includes(x.step));
    expect(solid.map((x) => x.rgb[0])).toEqual([255, 255, 255]);
  });

  // Chaque morceau de chaîne entre guillemets, accents graves ou `${…}` : une branche de ternaire
  // n'est pas mêlée à l'autre. Dans un morceau, chaque fond d'accent (ou blanc) à 50 % et plus est
  // confronté au texte qui s'affiche avec lui : celui des mêmes variantes (`focus-visible:bg-white
  // focus-visible:text-ink`), sinon celui sans variante (`hover:bg-white` sur un `text-white` de
  // base devient blanc sur blanc au survol).
  const SOLID_BG = /^bg-(?:accent-(?:400|500|600)|white)(?:\/(?:[5-9]\d|100))?$/;
  const LIGHT_TEXT = /^text-(?:white|accent-\d+|slate-[1-3]00|muted|subtle)$/;
  const TEXT = /^text-(?:white|black|ink|current|accent-\d+|slate-\d+|muted|subtle|danger|warning|success|[a-z]+-\d{3})(?:\/[\d[\].]+)?$/;

  function whiteOnWhite(chunk: string): string[] {
    const tokens = chunk.split(/[\s;]+/).filter(Boolean).map((token) => {
      const parts = token.split(":");
      return { variants: parts.slice(0, -1).join(":"), utility: parts[parts.length - 1] };
    });
    const textFor = (variants: string) =>
      tokens.filter((t) => TEXT.test(t.utility) && t.variants === variants).map((t) => t.utility);
    return tokens
      .filter((t) => SOLID_BG.test(t.utility))
      .flatMap((bg) => {
        const own = textFor(bg.variants);
        const shown = own.length ? own : textFor("");
        return shown.filter((text) => LIGHT_TEXT.test(text)).map((text) => `${bg.variants ? bg.variants + ":" : ""}${bg.utility} + ${text}`);
      });
  }

  function everySource(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : everySource(path);
      return /\.(tsx?|css)$/.test(name) ? [path] : [];
    });
  }

  it("aucun texte blanc sur un fond d'accent ou blanc", () => {
    const bad = everySource("src").flatMap((path) =>
      readFileSync(path, "utf8")
        .split(/["'`]|\$\{|\}/)
        .flatMap((chunk) => whiteOnWhite(chunk).map((pair) => `${path}: ${pair}`)),
    );
    expect(bad).toEqual([]);
  });

  it("le test reconnaît la faute qu'il garde", () => {
    expect(whiteOnWhite("rounded-full bg-accent-500 px-1.5 text-white")).toHaveLength(1);
    expect(whiteOnWhite("@apply btn bg-accent-600/90 text-slate-100")).toHaveLength(1);
    expect(whiteOnWhite("text-white hover:bg-white")).toHaveLength(1);
    expect(whiteOnWhite("bg-accent-500/22 text-white")).toEqual([]);
    expect(whiteOnWhite("bg-accent-500 text-ink")).toEqual([]);
    expect(whiteOnWhite("text-white hover:bg-white/10 focus-visible:bg-white focus-visible:text-ink")).toEqual([]);
  });
});

// Option B, validée par Louis le 13/10/2026 (DECISIONS.md §83) : le blanc reste aux actions, et la
// couleur de la marque dit ce qui est *à moi* — vu, dans ma liste, où j'en suis, ce qui m'attend.
// Depuis le nouveau logo (23/10/2026), cette couleur est son dégradé, violet → bleu : le faisceau
// (`--beam`, `bg-beam`) sur une barre ou un voile, son aplat (`beam-mid`, `beam-strong`) sur une
// icône, un point ou une pastille. Le violet `brand` ne reste qu'au clap, aux graphiques et à la
// gestion. Trois fautes à garder : la couleur « à moi » qui se répand hors de ces états (un
// copier-coller suffit, et la règle ne veut plus rien dire), un dégradé recopié dans un composant
// (deux définitions divergent), et un texte blanc sur une teinte claire, illisible.
describe("le dégradé du logo (ou son aplat) dit ce qui est à moi", () => {
  const theme = readFileSync("src/app/globals.css", "utf8");
  const rgbOf = (name: string) => {
    const m = theme.match(new RegExp(`--color-${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+)\\)`));
    expect(m, name).not.toBeNull();
    return [Number(m![1]), Number(m![2]), Number(m![3])];
  };
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: number[], b: number[]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const INK = [10, 10, 12];
  const WHITE = [255, 255, 255];
  const VIOLET = [124, 92, 255]; // #7c5cff, le départ du logo
  const BLUE = [56, 189, 248]; // #38bdf8, son arrivée

  it("le faisceau est le dégradé du logo, de gauche à droite, défini une fois", () => {
    const defs = [...theme.matchAll(/--beam:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(defs).toEqual([`linear-gradient(to right, rgb(${VIOLET.join(" ")}), rgb(${BLUE.join(" ")}))`]);
    expect(theme).toMatch(/@utility bg-beam \{\s*background-image: var\(--beam\);\s*\}/);
  });

  it("ses deux bouts se lisent sur le noir, comme barre", () => {
    // Une barre est un élément graphique : 3:1 suffit (WCAG 1.4.11) ; le violet passe même 4,5:1.
    expect(contrast(VIOLET, INK)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BLUE, INK)).toBeGreaterThanOrEqual(4.5);
  });

  it("l'aplat est le milieu du dégradé, et se lit sur le noir", () => {
    const mid = rgbOf("beam-mid");
    VIOLET.forEach((v, i) => expect(Math.abs(mid[i] - (v + BLUE[i]) / 2)).toBeLessThanOrEqual(1));
    expect(contrast(mid, INK)).toBeGreaterThanOrEqual(4.5);
  });

  it("l'aplat appuyé porte un texte blanc lisible, et reste de la même teinte", () => {
    const strong = rgbOf("beam-strong");
    expect(contrast(strong, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(strong, INK)).toBeGreaterThanOrEqual(3);
    // Assombri, pas déteint : le bleu domine, le rouge reste le plus faible — comme au milieu.
    expect(strong[2]).toBeGreaterThan(strong[1]);
    expect(strong[1]).toBeGreaterThan(strong[0]);
  });

  it("le violet du logo reste au clap, et se lit sur le noir", () => {
    expect(rgbOf("brand")).toEqual([155, 140, 255]);
    expect(contrast(rgbOf("brand"), INK)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgbOf("brand-strong"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  // Chaque surface « à moi » passe par le faisceau ou son aplat — et par la pièce commune quand il y en a une.
  it.each([
    ["src/components/cinema/ProgressFill.tsx", /\bbg-beam\b(?!-)/], // Reprendre : cartes, bannière, épisodes — le faisceau
    ["src/components/PlayButton.tsx", /\bbg-beam opacity-35\b/], // le voile du bouton Reprendre — le faisceau
    ["src/components/PlayButton.tsx", /\bbg-beam-strong\b/], // la barre de « Reprendre » d'une ligne de menu, 3 px sous le sélecteur blanc — aplat
    ["src/components/cinema/detailMenu.ts", /\bbg-beam-strong\b/], // « Vu », « Dans ma liste » des menus des fiches
    ["src/components/cinema/TitleToggles.tsx", /\btext-beam-mid\b/], // « À voir » et « Vu » allumés
    ["src/components/player/NavDot.tsx", /\bbg-beam-mid\b/], // la pastille d'un onglet
    ["src/components/player/PlayerAccountPanel.tsx", /\bbg-beam-strong\b/], // les compteurs
    ["src/components/reports/ReportParts.tsx", /\bbg-beam-mid\b/], // un signalement non lu
    ["src/components/WatchlistButton.tsx", /\bbtn-mine\b/], // dans ma liste
    ["src/components/cinema/CinemaEpisodeBrowser.tsx", /\bbg-beam-strong\b/], // la coche d'un épisode vu
    ["src/components/cinema/mobile/CinemaMobileDetail.tsx", /\bbg-beam-strong\b/],
  ])("%s porte la couleur « à moi »", (path, pattern) => {
    expect(readFileSync(path, "utf8")).toMatch(pattern);
  });

  it("la partie lue du lecteur porte le faisceau (23/10/2026), `btn-mine` son aplat", () => {
    expect(theme).toMatch(/\.player-seek::-webkit-slider-runnable-track \{[^}]*background: var\(--beam\) 0 0 \/ var\(--played, 0%\) 100% no-repeat;/);
    expect(theme).toMatch(/\.player-seek::-moz-range-track \{[^}]*background: var\(--beam\) 0 0 \/ var\(--played, 0%\) 100% no-repeat;/);
    expect(theme).toMatch(/@utility btn-mine \{\s*@apply bg-beam-strong\/\d+ text-white;/);
  });

  function everySource(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" || name === "animlab" ? [] : everySource(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const PREFIX = "(?:bg|text|ring|border|fill|stroke|from|to|via|outline|decoration)";
  const classesOf = (family: string) =>
    new RegExp(`(?:^|[\\s"'\`:])(${PREFIX}-${family}(?:\\/\\d+)?)(?=[\\s"'\`]|$)`, "g");
  const BRAND = classesOf("brand(?:-strong)?");
  const BEAM = classesOf("beam(?:-mid|-strong)?");
  const sources = everySource("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const usesOf = (re: RegExp) => sources.flatMap(({ path, text }) => [...text.matchAll(re)].map((m) => ({ path, cls: m[1] })));

  // Les seuls fichiers où le faisceau (ou son aplat) a droit de cité : les états personnels.
  // Un nouvel emploi ajoute sa ligne ici — et dit, en la justifiant, que c'est bien « à moi ».
  const MINE = [
    "src/components/cinema/ProgressFill.tsx", "src/components/PlayButton.tsx", "src/components/cinema/detailMenu.ts",
    "src/components/cinema/CinemaEpisodeBrowser.tsx", "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx", "src/components/player/PlayerListAdd.tsx",
    "src/components/cinema/TitleToggles.tsx", // « À voir » et « Vu » allumés, la forme commune des fiches (§117.4)
    "src/components/player/PlayerEpisodesMenu.tsx", // « Vu » d'un épisode dans le menu « Épisodes » du lecteur, comme sur la fiche
    "src/components/offline/OfflineTitleSheet.tsx", // « Vu » d'un épisode dans la fiche hors ligne, comme sur la fiche en ligne
    "src/components/shareGuest/ShareTitleSheet.tsx", // « Vu » d'un épisode sur la fiche d'un lien de partage (§112), comme sur la fiche du téléphone
    "src/components/player/NavDot.tsx", "src/components/player/PlayerAccountPanel.tsx", "src/components/reports/ReportParts.tsx",
  ];
  // Et ceux où le violet du logo reste : le clap, les « Vu » de la gestion, les graphiques.
  const BRAND_ONLY = [
    "src/components/Sidebar.tsx", "src/components/player/PlayerRail.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx", // le logo
    "src/app/(dashboard)/radarr/[id]/page.tsx", "src/app/(dashboard)/sonarr/[id]/page.tsx", // « Vu » dans la gestion
    // Les graphiques (14/10/2026, Louis) : l'accent devenu blanc les avait décolorés — séances par jour
    // de l'Activité ; ajouts mensuels, qualité, langues et encodage des Statistiques.
    "src/components/activity/parts.tsx", "src/components/activity/views/ActivityOverview.tsx", "src/app/(dashboard)/stats/page.tsx",
  ];

  it("pas de faisceau ailleurs que dans un état personnel", () => {
    const uses = usesOf(BEAM);
    expect(uses.length).toBeGreaterThan(10);
    expect(uses.filter((u) => !MINE.includes(u.path)).map((u) => `${u.path}: ${u.cls}`)).toEqual([]);
  });

  it("pas de violet ailleurs qu'au logo, à la gestion et aux graphiques — un état personnel n'y revient pas", () => {
    const uses = usesOf(BRAND);
    expect(uses.length).toBeGreaterThan(5);
    expect(uses.filter((u) => !BRAND_ONLY.includes(u.path)).map((u) => `${u.path}: ${u.cls}`)).toEqual([]);
  });

  it("le dégradé n'est jamais recopié : ni `var(--beam)` ni un dégradé de ses couleurs dans un composant", () => {
    // Un logo dessiné en ligne peut porter ses couleurs (c'est le logo) ; un dégradé CSS ou Tailwind
    // fait avec elles, non : c'est le faisceau recopié, et deux copies divergent.
    const COLOR = String.raw`(?:#7c5cff|#38bdf8|124[ ,]+92[ ,]+255|56[ ,]+189[ ,]+248)`;
    const COPY = new RegExp(String.raw`var\(--beam\)|gradient\([^)]*${COLOR}|(?:from|via|to)-\[${COLOR}`, "i");
    expect(sources.filter(({ text }) => COPY.test(text)).map(({ path }) => path)).toEqual([]);
    expect(COPY.test("background: linear-gradient(90deg, #7C5CFF, #38bdf8)")).toBe(true);
    expect(COPY.test("bg-gradient-to-r from-[#7c5cff] to-[#38bdf8]")).toBe(true);
    expect(COPY.test('<stop stopColor="#7c5cff" />')).toBe(false);
    // Et une seule fois dans le thème : `--beam`, que l'utilitaire et la barre du lecteur lisent.
    expect(theme.match(/rgb\(124 92 255\)/g)).toHaveLength(1);
    expect(theme.match(/rgb\(56 189 248\)/g)).toHaveLength(1);
  });

  it("jamais de texte blanc sur une teinte claire de la marque", () => {
    const LIGHT = /(?:^|\s)bg-(?:brand|beam-mid|beam)(?:\/(?:[5-9]\d|100))?(?:\s|$)/;
    const bad = sources.flatMap(({ path, text }) =>
      text
        .split(/["'`]|\$\{|\}/)
        .filter((chunk) => LIGHT.test(chunk) && /(?:^|\s)text-white(?:\s|$)/.test(chunk))
        .map((chunk) => `${path}: ${chunk.trim()}`),
    );
    expect(bad).toEqual([]);
  });

  it("le test reconnaît les fautes qu'il garde", () => {
    expect([..."x bg-beam-mid y".matchAll(BEAM)].map((m) => m[1])).toEqual(["bg-beam-mid"]);
    expect([...'"text-beam-strong/50"'.matchAll(BEAM)].map((m) => m[1])).toEqual(["text-beam-strong/50"]);
    expect([..."a bg-beam opacity-35".matchAll(BEAM)].map((m) => m[1])).toEqual(["bg-beam"]);
    expect([..."ring-brand/50".matchAll(BRAND)].map((m) => m[1])).toEqual(["ring-brand/50"]);
  });
});
