/**
 * Exporte le chalet pour la cuisson de la lumière (Blender) : la géométrie fixe, telle que la page la
 * construit — ce sont les mêmes fonctions (`src/world/geometry/`) —, et la description des lumières.
 *
 * Sortie, dans `assets-src/bake/` :
 * - un fichier OBJ par maillage (`<groupe>__<matière>.obj`), triangles non indexés, **dans l'ordre
 *   exact des sommets de la page** : c'est ce qui permet de rapporter au navigateur les UV de
 *   lightmap, sommet par sommet, sans rien réexporter de la géométrie ;
 * - `scene.json` : les maillages par groupe (un atlas de lumière par groupe), la teinte moyenne de
 *   chaque matière (pour la couleur des rebonds), les lumières, le ciel.
 *
 * Lancement : voir `tools/bake/README.md` (construit par Vite en mode serveur, puis exécuté par Node).
 */
import fs from "node:fs";
import path from "node:path";
import type { BufferGeometry } from "three";
import { CANDLES } from "../../src/world/candles";
import { Kits } from "../../src/world/geometry/envelope";
import { NIGHT_LAMPS, buildNight } from "../../src/world/geometry/night";
import { buildBlockSofa, buildSalon } from "../../src/world/geometry/salon";
import { PENDANTS, buildSouth } from "../../src/world/geometry/south";
import { buildTerrace } from "../../src/world/geometry/terrace";
import type { MaterialId, Part } from "../../src/world/geometry/types";
import { BREAST, CHANDELIER, KITCHEN, LAMPS, MOON, PLAN, ROOM, TUB } from "../../src/world/layout";

const OUT = process.env.BAKE_OUT || "assets-src/bake";
fs.mkdirSync(OUT, { recursive: true });

/** La teinte moyenne de chaque matière, en linéaire : ce que la lumière y prend en rebondissant. */
const ALBEDO: Record<MaterialId, [number, number, number]> = {
  floor: [0.12, 0.07, 0.045],
  timber: [0.16, 0.12, 0.1],
  planks: [0.3, 0.22, 0.16],
  stone: [0.4, 0.34, 0.27],
  slab: [0.25, 0.23, 0.21],
  plaster: [0.72, 0.62, 0.48],
  fabric: [0.62, 0.54, 0.44],
  pillowA: [0.35, 0.3, 0.25],
  pillowB: [0.26, 0.17, 0.11],
  rug: [0.58, 0.5, 0.42],
  leather: [0.22, 0.11, 0.06],
  wood: [0.15, 0.11, 0.09],
  metal: [0.02, 0.02, 0.02],
  counter: [0.16, 0.16, 0.16],
  linen: [0.75, 0.72, 0.66],
  cabinet: [0.07, 0.06, 0.05],
  white: [0.6, 0.56, 0.5],
  snow: [0.82, 0.86, 0.94],
};

/** Taille de l'atlas de lumière de chaque groupe, en pixels. */
const ATLAS: Record<string, number> = { salon: 2048, sud: 2048, nuit: 1024, terrasse: 1024 };

function writeObj(file: string, name: string, geometry: BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  if (geometry.index) throw new Error(`${name} : géométrie indexée — l'ordre des sommets ne serait pas celui de la page`);
  const lines: string[] = [`o ${name}`];
  const f = (n: number) => (Math.abs(n) < 1e-7 ? "0" : n.toFixed(6));
  for (let i = 0; i < position.count; i++) lines.push(`v ${f(position.getX(i))} ${f(position.getY(i))} ${f(position.getZ(i))}`);
  for (let i = 0; i < position.count; i++) lines.push(`vt ${f(uv.getX(i))} ${f(uv.getY(i))}`);
  for (let i = 0; i < position.count; i++) lines.push(`vn ${f(normal.getX(i))} ${f(normal.getY(i))} ${f(normal.getZ(i))}`);
  lines.push("s 1");
  for (let i = 0; i < position.count; i += 3) lines.push(`f ${i + 1}/${i + 1}/${i + 1} ${i + 2}/${i + 2}/${i + 2} ${i + 3}/${i + 3}/${i + 3}`);
  fs.writeFileSync(path.join(OUT, file), lines.join("\n") + "\n");
  return position.count;
}

/**
 * Les objets posés (des modèles, placés dans `src/world/Props.tsx`) ne sont pas cuits, mais ils font
 * de l'ombre : chacun est résumé ici par une ou deux boîtes à sa place — assez pour l'ombre douce d'un
 * fauteuil ou d'un pot sur le parquet. Si un objet déménage dans `Props.tsx`, sa boîte doit suivre.
 */
function propShadows(): Record<string, Part> {
  const kits = { salon: new Kits(), sud: new Kits(), nuit: new Kits() };
  const chair = (group: keyof typeof kits, x: number, y: number, z: number) => {
    kits[group].get("leather").box([0.66, 0.3, 0.66], { at: [x, y + 0.3, z] });
    kits[group].get("leather").box([0.5, 0.36, 0.5], { at: [x, y + 0.62, z] });
  };
  const table = (group: keyof typeof kits, x: number, y: number, z: number) => kits[group].get("wood").box([0.44, 0.05, 0.44], { at: [x, y + 0.53, z] });
  const pot = (group: keyof typeof kits, x: number, y: number, z: number, scale: number) => {
    kits[group].get("plaster").box([0.34 * scale, 0.36 * scale, 0.34 * scale], { at: [x, y + 0.18 * scale, z] });
    // Le feuillage : une masse légère, plus petite que la plante — il laisse passer du jour.
    kits[group].get("plaster").box([0.4 * scale, 0.3 * scale, 0.4 * scale], { at: [x, y + 0.75 * scale, z] });
  };
  chair("salon", 3.5, 0, -5.6);
  table("salon", 4.55, 0, -6.0);
  chair("salon", -4.1, 0, 2.7);
  pot("salon", -4.7, 0, -6.2, 1.5);
  pot("salon", 4.65, 0, 2.5, 1.6);
  // La cuisine : ses tabourets ; la mezzanine : son lit de repos, son fauteuil, sa plante.
  for (const x of [0.75, 1.4, 2.05]) kits.sud.get("wood").box([0.36, 0.05, 0.36], { at: [x, 0.74, KITCHEN.island.z0 - 0.3] });
  kits.sud.get("fabric").box([0.85, 0.34, 1.95], { at: [3.4, ROOM.loft + 0.3, 5.5] });
  chair("sud", -1.8, ROOM.loft, 5.8);
  table("sud", -0.9, ROOM.loft, 5.5);
  pot("sud", 4.7, ROOM.loft, 9.0, 1.3);
  chair("nuit", -1.1, 0, PLAN.bedroom.z1 - 0.8);
  pot("nuit", -5.0, 0, PLAN.bedroom.z1 - 0.5, 1.3);
  return Object.fromEntries(Object.entries(kits).map(([group, k]) => [group, { meshes: k.build(), solids: [] }]));
}

const parts: Record<string, Part> = { salon: buildSalon(), sud: buildSouth(), nuit: buildNight(), terrasse: buildTerrace() };
// Ce qui fait de l'ombre et renvoie de la lumière sans recevoir de lightmap ici : les objets posés, et
// la version en boîtes du canapé (la cuisson la remplace par le vrai modèle quand on le lui donne).
const shadows = propShadows();
const occluders: Record<string, Part[]> = { salon: [buildBlockSofa(), shadows.salon], sud: [shadows.sud], nuit: [shadows.nuit], terrasse: [] };

const groups: Record<string, { atlas: number; meshes: unknown[]; occluders: unknown[] }> = {};
for (const [group, part] of Object.entries(parts)) {
  const meshes = (Object.keys(part.meshes) as MaterialId[]).map((material) => {
    const name = `${group}__${material}`;
    const vertices = writeObj(`${name}.obj`, name, part.meshes[material]!);
    // Trois sommets témoins : la cuisson les recopie, la page vérifie qu'elle parle bien du même maillage.
    const position = part.meshes[material]!.getAttribute("position");
    const probe = [0, Math.floor(vertices / 2), vertices - 1].map((i) => [position.getX(i), position.getY(i), position.getZ(i)].map((n) => Math.round(n * 1000) / 1000));
    return { name, file: `${name}.obj`, material, albedo: ALBEDO[material], vertices, probe };
  });
  // Le premier lot d'un groupe garde le nom historique (`<groupe>__occluder_<matière>`) : pour `salon`
  // c'est le canapé en boîtes, que la cuisson sait remplacer ; les suivants portent leur rang.
  const blockers = (occluders[group] ?? []).flatMap((part, n) =>
    Object.entries(part.meshes).map(([material, geometry]) => {
      const name = n === 0 && group === "salon" ? `${group}__occluder_${material}` : `${group}__props${n}_${material}`;
      writeObj(`${name}.obj`, name, geometry!);
      return { name, file: `${name}.obj`, material, albedo: ALBEDO[material as MaterialId], sofa: n === 0 && group === "salon" };
    })
  );
  groups[group] = { atlas: ATLAS[group], meshes, occluders: blockers };
}

const hex = (color: string): [number, number, number] => {
  const n = parseInt(color.slice(1), 16);
  // sRGB → linéaire.
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.pow(c / 255, 2.2)) as [number, number, number];
};

/**
 * Les lumières, dans les unités de la page (three.js) : une lumière ponctuelle d'intensité I éclaire
 * une surface à la distance d, de face, de I / d² ; une lumière directionnelle d'intensité S, de S.
 * C'est cette grandeur — l'éclairement — que la lightmap doit contenir.
 *
 * Deux couches : `lampes` — ce que le mode cinéma et les interrupteurs baissent (le lustre, les lampes
 * électriques) — et `nuit` — ce qui reste : la lune, le ciel, les bougies posées, la lueur du bain.
 * Le feu du foyer n'est pas cuit : sa lueur danse (`src/world/Fire.tsx`).
 */
const lights = [
  // Le lustre : ses vingt-six bougies, résumées en un anneau de huit sources à mi-hauteur de ses deux cercles.
  ...Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { type: "point", name: `lustre-${i}`, layer: "lampes", position: [CHANDELIER.x + Math.cos(a) * 1.2, CHANDELIER.y + 0.42, CHANDELIER.z + Math.sin(a) * 1.2], color: hex("#ffc98f"), intensity: 210 / 8, radius: 0.12 };
  }),
  ...LAMPS.map(([x, z], i) => ({ type: "point", name: `lampadaire-${i}`, layer: "lampes", position: [x, 1.5, z], color: hex("#ffd0a0"), intensity: 18, radius: 0.16 })),
  // Les bougies du manteau, du banc de l'âtre et de la table basse (celles du lustre sont comptées plus haut).
  ...CANDLES.slice(26).map((c, i) => ({ type: "point", name: `bougie-${i}`, layer: "nuit", position: [c.p[0] - (c.p[0] > BREAST.face - 1 ? 0.06 : 0), c.p[1] + c.h + 0.06, c.p[2]], color: hex("#ffa055"), intensity: 1.6, radius: 0.03 })),
  ...PENDANTS.map(([x, y, z], i) => ({ type: "point", name: `suspension-${i}`, layer: "lampes", position: [x, y - 0.02, z], color: hex("#ffcf9a"), intensity: 8, radius: 0.05 })),
  { type: "point", name: "mezzanine", layer: "lampes", position: [1.2, ROOM.loft + 1.7, 7.4], color: hex("#ffc488"), intensity: 11, radius: 0.2 },
  ...NIGHT_LAMPS.sconces.map(([x, y, z], i) => ({ type: "point", name: `applique-${i}`, layer: "lampes", position: [x, y, z - 0.16], color: hex("#ffbf80"), intensity: 5, radius: 0.06 })),
  ...NIGHT_LAMPS.bedside.map(([x, y, z], i) => ({ type: "point", name: `chevet-${i}`, layer: "lampes", position: [x, y, z], color: hex("#ffc083"), intensity: 6, radius: 0.1 })),
  // Le bain : la lumière au fond de la cuve, qui remonte par l'eau et teinte la margelle.
  { type: "point", name: "bain", layer: "nuit", position: [TUB.x, TUB.water + 0.12, TUB.z], color: hex("#2fd6d0"), intensity: 3.2, radius: 0.5 },
  { type: "sun", name: "lune", layer: "nuit", from: MOON.lightFrom, color: hex(MOON.color), intensity: MOON.intensity, angleDeg: 0.6 },
];

fs.writeFileSync(
  path.join(OUT, "scene.json"),
  JSON.stringify(
    {
      frame: "glTF : Y vers le haut, X vers l'est, Z vers le sud ; mètres",
      groups,
      lights,
      // Le ciel de nuit : un éclairement faible et bleu, qui entre par les ouvertures (elles sont de vrais trous).
      // Une nuit noire : le ciel n'apporte presque rien, c'est la lune qui dessine (taches sur le parquet, ombres nettes).
      sky: { color: hex("#4a66a8"), irradiance: 0.12 },
      // Ce que 1,0 vaut dans la lightmap : l'éclairement est divisé par cette valeur avant d'être écrit (sRGB, 8 bits).
      range: 64,
    },
    null,
    1
  )
);
const total = Object.values(groups).reduce((n, g) => n + g.meshes.length, 0);
console.log(`export : ${total} maillages dans ${OUT}, ${lights.length} lumières`);
