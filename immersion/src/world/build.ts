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

  /** Une poutre tendue d'un point à un autre (section `w` × `h`, le fil dans sa longueur). */
  beam(from: [number, number, number], to: [number, number, number], w: number, h: number): this {
    const a = new Vector3(...from);
    const b = new Vector3(...to);
    const length = a.distanceTo(b);
    const geometry = projectUVs(new BoxGeometry(length, h, w), this.tile, 0);
    // L'axe X local de la boîte est couché sur la direction de la poutre.
    quaternion.setFromUnitVectors(new Vector3(1, 0, 0), b.clone().sub(a).normalize());
    matrix.compose(a.add(b).multiplyScalar(0.5), quaternion, scale);
    this.parts.push(geometry.applyMatrix4(matrix).toNonIndexed());
    return this;
  }

  /** N'importe quelle géométrie : ses UV sont posés ici, puis elle est placée. */
  add(geometry: BufferGeometry, placement: Placement, grain: Axis | null = null): this {
    const projected = projectUVs(geometry, this.tile, grain);
    this.parts.push(place(projected, placement).toNonIndexed());
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
