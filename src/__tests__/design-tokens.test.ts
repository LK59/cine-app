import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Le vocabulaire visuel du cinéma, et ce qui ne doit pas y revenir.
 *
 * Relevé le 23/09/2026 sur les écrans du cinéma et du lecteur : neuf opacités de blanc et six gris
 * pleins pour le texte secondaire, six arrondis, trois rouges d'erreur — et des teintes de
 * l'accent (`accent-200`, `accent-300`) que le thème ne définit pas, donc que Tailwind n'émet
 * pas : le badge « en cours » d'une demande prenait la couleur de son parent au lieu du violet.
 *
 * Aucune de ces fautes ne se voit dans un test de comportement, et chacune revient par un simple
 * copier-coller. Ces tests lisent donc la source, comme `decisions-partagees.test.ts`.
 */

const ROOTS = ["src/components/cinema", "src/components/player"];

function sources(dir: string): string[] {
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
        /(?:text|bg|border|ring)-(red|amber|emerald|green|yellow|rose)-\d{3}/g,
        (path, m) =>
          (path.endsWith("CinemaNewBadge.tsx") && m === "bg-red-600") ||
          (path.endsWith("PlayerPersonSheet.tsx") && /amber-/.test(m)),
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
