import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";

/**
 * Chaque appareil déclaré a bien son image, dans les deux sens.
 *
 * iOS ne redimensionne pas un écran de lancement : il lui faut le fichier aux pixels exacts de
 * l'appareil, sinon il affiche du blanc. Une ligne ajoutée au tableau sans le fichier qui va avec
 * ne casse rien, ne lève rien, et ne se voit que sur l'appareil concerné — exactement le genre
 * d'oubli qu'un test doit porter à la place de quelqu'un.
 */
const layout = readFileSync("src/app/layout.tsx", "utf8");
const declares = [...layout.matchAll(/\{ width: (\d+), height: (\d+), dpr: (\d+) \}/g)].map((m) => ({
  width: Number(m[1]),
  height: Number(m[2]),
  dpr: Number(m[3]),
}));

describe("écrans de lancement iOS", () => {
  it("le tableau n'est pas vide et couvre iPhone comme iPad", () => {
    expect(declares.length).toBeGreaterThan(15);
    // Un iPad se reconnaît à sa largeur logique : aucun iPhone n'atteint 700 points.
    expect(declares.some((d) => d.width >= 700)).toBe(true);
  });

  it("chaque appareil a son image en portrait et en paysage", () => {
    const manquants: string[] = [];
    for (const d of declares) {
      for (const [w, h] of [[d.width, d.height], [d.height, d.width]]) {
        const f = `public/splash/apple-splash-${w * d.dpr}-${h * d.dpr}.png`;
        if (!existsSync(f)) manquants.push(f);
      }
    }
    expect(manquants).toEqual([]);
  });

  it("toutes les images sont des PNG, et aucune n'est un aplat", () => {
    /**
     * Le poids fait office de sonde, et il suffit ici : une image d'un seul ton se compresse à
     * quelques kilo-octets, celles qui portent le logo en pèsent plusieurs dizaines. C'est la
     * différence entre l'écran noir qu'on avait — indiscernable de l'absence d'image — et un vrai
     * écran de lancement. Le contenu lui-même a été vérifié en décodant deux images à la main le
     * 20/09/2026 : fond `#0a0a0c` en haut et en bas, violet du logo au centre.
     */
    const fichiers = readdirSync("public/splash");
    expect(fichiers.length).toBeGreaterThanOrEqual(declares.length * 2);
    for (const nom of fichiers) {
      const png = readFileSync(`public/splash/${nom}`);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // Rapporté à la surface, parce qu'un aplat se compresse proportionnellement à elle :
      // mesuré, un noir uni coûte 2,9 Ko par mégapixel, une image portant le logo 7,8.
      const [w, h] = nom.match(/(\d+)-(\d+)\.png$/)!.slice(1).map(Number);
      const koParMegapixel = png.length / 1024 / ((w * h) / 1e6);
      expect(koParMegapixel).toBeGreaterThan(5);
    }
  });

  it("le fond de la racine est déclaré dans le document lui-même", () => {
    // Sans prétendre que cela corrige le blanc du lancement : ce point-là n'a pas pu être
    // démontré, et le commentaire du layout dit pourquoi. La couleur, elle, doit rester celle
    // du manifeste — deux noirs différents se verraient à la bascule.
    expect(layout).toMatch(/html,body\{background:#0a0a0c\}/);
    expect(readFileSync("public/manifest.json", "utf8")).toMatch(/"background_color": "#0a0a0c"/);
  });
});
