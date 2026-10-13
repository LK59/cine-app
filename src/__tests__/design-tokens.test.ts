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
    "FileTrackChips", "GlobalSearch", "KeyboardShortcutsModal", "MediaCard", "MediaInfoModal", "MediaRatings",
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
  it("rien sous 11 px, hors les libellés de la barre du bas", () => {
    expect(offenders(/text-\[(\d|10)px\]/g, (path) => path.endsWith("PlayerBottomBar.tsx"))).toEqual([]);
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

// Option B, validée par Louis le 13/10/2026 (DECISIONS.md §83) : le blanc reste aux actions, et le
// violet du logo dit ce qui est *à moi* — vu, dans ma liste, où j'en suis, ce qui m'attend. Deux
// fautes à garder : le violet qui se répand hors de ces états (un copier-coller suffit, et la
// règle ne veut plus rien dire), et un texte blanc sur le violet clair, illisible à 2,8:1.
describe("le violet de la marque dit ce qui est à moi", () => {
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

  it("le violet est celui du logo, et se lit sur le noir", () => {
    expect(rgbOf("brand")).toEqual([155, 140, 255]);
    expect(contrast(rgbOf("brand"), INK)).toBeGreaterThanOrEqual(4.5);
  });

  it("la teinte appuyée porte un texte blanc lisible", () => {
    expect(contrast(rgbOf("brand-strong"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  // Chaque surface « à moi » passe par le violet — et par la pièce commune quand il y en a une.
  it.each([
    ["src/components/cinema/ProgressFill.tsx", /\bbg-brand\b/], // Reprendre : cartes, bannière, épisodes
    ["src/components/cinema/detailMenu.ts", /\bbg-brand-strong\b/], // « Vu », « Dans ma liste » des menus des fiches
    ["src/components/PlayButton.tsx", /\bbg-brand-strong\b/], // la barre de « Reprendre » d'une ligne de menu
    ["src/components/player/NavDot.tsx", /\bbg-brand\b/], // la pastille d'un onglet
    ["src/components/player/PlayerAccountPanel.tsx", /\bbg-brand-strong\b/], // les compteurs
    ["src/components/reports/ReportParts.tsx", /\bbg-brand\b/], // un signalement non lu
    ["src/components/WatchlistButton.tsx", /\bbtn-mine\b/], // dans ma liste
    ["src/components/cinema/CinemaEpisodeBrowser.tsx", /\bbg-brand-strong\b/], // la coche d'un épisode vu
    ["src/components/cinema/mobile/CinemaMobileDetail.tsx", /\bbg-brand-strong\b/],
  ])("%s porte le violet", (path, pattern) => {
    expect(readFileSync(path, "utf8")).toMatch(pattern);
  });

  it("la partie lue du lecteur est violette, et `btn-mine` aussi", () => {
    expect(theme).toMatch(/\.player-seek::-webkit-slider-runnable-track \{[^}]*var\(--color-brand\) 0 var\(--played/);
    expect(theme).toMatch(/\.player-seek::-moz-range-track \{[^}]*var\(--color-brand\) 0 var\(--played/);
    expect(theme).toMatch(/@utility btn-mine \{\s*@apply bg-brand-strong\/\d+ text-white;/);
  });

  function everySource(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" || name === "animlab" ? [] : everySource(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const BRAND = /(?:^|[\s"'`:])((?:bg|text|ring|border|fill|stroke|from|to|via|outline|decoration)-brand(?:-strong)?(?:\/\d+)?)(?=[\s"'`]|$)/g;
  const uses = everySource("src").flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(BRAND)].map((m) => ({ path, cls: m[1] })),
  );

  // Les seuls fichiers où le violet a droit de cité : le logo (le clap), et les états personnels.
  // Un nouvel emploi ajoute sa ligne ici — et dit, en la justifiant, que c'est bien « à moi ».
  const ALLOWED = [
    "src/components/Sidebar.tsx", "src/components/player/PlayerRail.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx", // le logo
    "src/components/cinema/ProgressFill.tsx", "src/components/PlayButton.tsx", "src/components/cinema/detailMenu.ts",
    "src/components/cinema/CinemaEpisodeBrowser.tsx", "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx", "src/components/player/PlayerListAdd.tsx",
    "src/components/player/NavDot.tsx", "src/components/player/PlayerAccountPanel.tsx", "src/components/reports/ReportParts.tsx",
    "src/app/(dashboard)/radarr/[id]/page.tsx", "src/app/(dashboard)/sonarr/[id]/page.tsx", // « Vu » dans la gestion
  ];

  it("pas de violet ailleurs", () => {
    expect(uses.length).toBeGreaterThan(10);
    expect(uses.filter((u) => !ALLOWED.includes(u.path)).map((u) => `${u.path}: ${u.cls}`)).toEqual([]);
  });

  it("jamais de texte blanc sur le violet clair", () => {
    const bad = everySource("src").flatMap((path) =>
      readFileSync(path, "utf8")
        .split(/["'`]|\$\{|\}/)
        .filter((chunk) => /(?:^|\s)bg-brand(?:\/(?:[5-9]\d|100))?(?:\s|$)/.test(chunk) && /(?:^|\s)text-white(?:\s|$)/.test(chunk))
        .map((chunk) => `${path}: ${chunk.trim()}`),
    );
    expect(bad).toEqual([]);
  });
});
