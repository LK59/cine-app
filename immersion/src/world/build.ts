import { BoxGeometry, BufferAttribute, BufferGeometry, Euler, Matrix4, Quaternion, Vector3, type EulerOrder } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/**
 * De quoi bâtir le chalet en code.
 *
 * Deux idées tiennent tout le fichier :
 *
 * 1. **Les UV viennent des dimensions réelles.** Une texture de bois couvre « tant de mètres » : une
 *    poutre de six mètres doit la répéter trois fois plus qu'une de deux. `projectUVs` pose donc les UV
 *    par projection, en mètres, dans le repère **local** de la pièce — avant qu'elle soit tournée —, et
 *    le fil du bois suit l'axe qu'on lui donne (`grain`), quelle que soit l'inclinaison finale.
 * 2. **Une matière = un maillage.** Les centaines de pièces d'une charpente ou d'une baie à petits
 *    carreaux sont fusionnées par matière (`Kit`) : quelques appels de dessin au lieu de centaines.
 */
export type Axis = 0 | 1 | 2;

const position = new Vector3();
const normal = new Vector3();

/**
 * Pose des UV en mètres : chaque sommet est projeté sur le plan que regarde sa normale.
 *
 * @param tile  côté, en mètres, que couvre une répétition de la texture
 * @param grain axe local le long duquel court le U de la texture (le fil du bois) ; sans lui, U suit
 *              l'horizontale de la face
 */
export function projectUVs<T extends BufferGeometry>(geometry: T, tile: number, grain: Axis | null = null): T {
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const uv = new Float32Array(positions.count * 2);
  for (let i = 0; i < positions.count; i++) {
    position.fromBufferAttribute(positions, i);
    normal.fromBufferAttribute(normals, i);
    const ax = Math.abs(normal.x);
    const ay = Math.abs(normal.y);
    const az = Math.abs(normal.z);
    const facing: Axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    // Les deux axes de la face : (horizontal, vertical) par défaut.
    let u: Axis = facing === 0 ? 2 : 0;
    let v: Axis = facing === 1 ? 2 : 1;
    if (grain !== null && grain !== facing && grain !== u) {
      const swap = u;
      u = v;
      v = swap;
    }
    uv[i * 2] = position.getComponent(u) / tile;
    uv[i * 2 + 1] = position.getComponent(v) / tile;
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  return geometry;
}

export interface Placement {
  /** Centre de la pièce. */
  at: [number, number, number];
  /** Rotation (Euler, radians). */
  rot?: [number, number, number];
  /** Ordre des rotations ; « YXZ » pour un objet qu'on oriente (lacet) puis qu'on incline. */
  order?: EulerOrder;
}

const matrix = new Matrix4();
const quaternion = new Quaternion();
const euler = new Euler();
const scale = new Vector3(1, 1, 1);

function place(geometry: BufferGeometry, { at, rot, order }: Placement): BufferGeometry {
  euler.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, order ?? "XYZ");
  quaternion.setFromEuler(euler);
  matrix.compose(position.set(at[0], at[1], at[2]), quaternion, scale);
  return geometry.applyMatrix4(matrix);
}

/** Sans index : la fusion veut des pièces toutes indexées ou toutes non indexées. */
const flat = (geometry: BufferGeometry) => (geometry.index ? geometry.toNonIndexed() : geometry);

/** Les pièces d'une même matière, fusionnées en un seul maillage. */
export class Kit {
  private parts: BufferGeometry[] = [];

  constructor(
    /** Côté couvert par une répétition de la texture, en mètres. */
    private tile: number
  ) {}

  /** Une boîte : dimensions, emplacement, axe du fil. */
  box(size: [number, number, number], placement: Placement, grain: Axis | null = null): this {
    return this.add(new BoxGeometry(size[0], size[1], size[2]), placement, grain);
  }

  /** Une boîte aux arêtes adoucies (coussins, meubles). */
  rounded(size: [number, number, number], radius: number, placement: Placement, grain: Axis | null = null): this {
    return this.add(new RoundedBoxGeometry(size[0], size[1], size[2], 3, Math.min(radius, Math.min(...size) / 2 - 0.001)), placement, grain);
  }

  /** Une boîte donnée par ses bornes. */
  span(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, grain: Axis | null = null): this {
    return this.box([Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], { at: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] }, grain);
  }

  /**
   * Un mur percé : une plaque verticale d'épaisseur `t`, le long de X (`axis: "x"`, à la cote `at` en Z)
   * ou le long de Z (`axis: "z"`, à la cote `at` en X), de `a0` à `a1`, du sol `y0` à la hauteur `top`
   * (un nombre, ou une fonction de la position pour un pignon), moins ses ouvertures — portes et
   * fenêtres, données par leurs bornes le long du mur et en hauteur.
   */
  wall(axis: "x" | "z", at: number, t: number, a0: number, a1: number, y0: number, top: number | ((a: number) => number), openings: { a0: number; a1: number; y0: number; y1: number }[] = [], step = 0.5): this {
    const cuts = new Set<number>([a0, a1]);
    for (const o of openings) {
      if (o.a0 > a0 && o.a0 < a1) cuts.add(o.a0);
      if (o.a1 > a0 && o.a1 < a1) cuts.add(o.a1);
    }
    // Un sommet en pente se suit par bandes étroites.
    if (typeof top === "function") for (let a = a0 + step; a < a1 - 1e-6; a += step) cuts.add(Math.round(a * 1000) / 1000);
    const edges = [...cuts].sort((p, q) => p - q);
    for (let i = 0; i < edges.length - 1; i++) {
      const s0 = edges[i];
      const s1 = edges[i + 1];
      if (s1 - s0 < 1e-4) continue;
      const mid = (s0 + s1) / 2;
      const height = typeof top === "function" ? Math.min(top(s0), top(s1)) : top;
      // Les vides de cette bande, du bas vers le haut ; entre eux, le mur.
      const holes = openings.filter((o) => mid > o.a0 && mid < o.a1).sort((p, q) => p.y0 - q.y0);
      let from = y0;
      for (const hole of [...holes, { y0: height, y1: height }]) {
        const to = Math.min(hole.y0, height);
        if (to - from > 1e-4) {
          // Le dernier morceau d'une bande en pente suit la pente : son dessus va de `top(s0)` à `top(s1)`.
          // Il était plat, à la plus basse des deux hauteurs — un mur en escalier sous le toit, et entre
          // chaque marche et les planches un jour en triangle par où, de la mezzanine, on voyait le ciel.
          const sloped = typeof top === "function" && to === height && Math.abs(top(s0) - top(s1)) > 1e-6;
          if (sloped) this.slopedBlock(axis, at, t, s0, s1, from, top(s0), top(s1));
          else if (axis === "x") this.span(s0, s1, from, to, at, at + t);
          else this.span(at, at + t, from, to, s0, s1);
        }
        from = Math.max(from, hole.y1);
      }
    }
    return this;
  }

  /**
   * Un bloc de mur dont le dessus est en pente : de `s0` à `s1` le long du mur, du bas `y0` jusqu'à `top0`
   * en `s0` et `top1` en `s1`. Une boîte dont on relève les sommets du dessus ; ses faces restent planes.
   */
  private slopedBlock(axis: "x" | "z", at: number, t: number, s0: number, s1: number, y0: number, top0: number, top1: number): void {
    const length = s1 - s0;
    const high = Math.max(top0, top1);
    const geometry = new BoxGeometry(axis === "x" ? length : t, high - y0, axis === "x" ? t : length);
    const positions = geometry.getAttribute("position");
    const along = axis === "x" ? 0 : 2;
    for (let i = 0; i < positions.count; i++) {
      if (positions.getY(i) <= 0) continue;
      // Le long du mur, de -length/2 (en s0) à +length/2 (en s1) : la hauteur voulue, centrée sur la boîte.
      const k = positions.getComponent(i, along) / length + 0.5;
      positions.setY(i, top0 + (top1 - top0) * k - (high + y0) / 2);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    const centre = (s0 + s1) / 2;
    this.add(geometry, { at: axis === "x" ? [centre, (high + y0) / 2, at + t / 2] : [at + t / 2, (high + y0) / 2, centre] });
  }

  /** Une poutre tendue d'un point à un autre (section `w` × `h`, le fil dans sa longueur). */
  beam(from: [number, number, number], to: [number, number, number], w: number, h: number): this {
    const a = new Vector3(...from);
    const b = new Vector3(...to);
    const length = a.distanceTo(b);
    const geometry = projectUVs(new BoxGeometry(length, h, w), this.tile, 0);
    // L'axe X local de la boîte est couché sur la direction de la poutre.
    quaternion.setFromUnitVectors(new Vector3(1, 0, 0), b.clone().sub(a).normalize());
    matrix.compose(a.add(b).multiplyScalar(0.5), quaternion, scale);
    this.parts.push(flat(geometry.applyMatrix4(matrix)));
    return this;
  }

  /** N'importe quelle géométrie : ses UV sont posés ici, puis elle est placée. */
  add(geometry: BufferGeometry, placement: Placement, grain: Axis | null = null): this {
    const projected = projectUVs(geometry, this.tile, grain);
    this.parts.push(flat(place(projected, placement)));
    return this;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  /** Le maillage fusionné. Les pièces sont libérées : le kit ne sert qu'une fois. */
  build(): BufferGeometry {
    const cleaned = this.parts.map((part) => {
      // Seuls ces trois attributs sont communs à toutes les géométries de three.
      for (const name of Object.keys(part.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") part.deleteAttribute(name);
      return part;
    });
    const merged = mergeGeometries(cleaned, false) ?? new BufferGeometry();
    for (const part of this.parts) part.dispose();
    this.parts = [];
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}
