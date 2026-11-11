import { Kit } from "../build";
import { ROOF_ANGLE, ROOM, roofY } from "../layout";

const W = ROOM.halfW;

/** Les kits d'une partie : un par matière, créés à la demande avec la taille de carreau de la matière. */
export class Kits {
  private kits = new Map<string, Kit>();
  private static TILE: Record<string, number> = {
    floor: 2.6,
    timber: 1.5,
    planks: 1.9,
    stone: 2.3,
    slab: 1.6,
    plaster: 2.2,
    fabric: 0.55,
    pillowA: 0.4,
    pillowB: 0.3,
    rug: 0.9,
    leather: 0.7,
    wood: 1.1,
    metal: 1,
    counter: 1.4,
    linen: 0.6,
    cabinet: 1.3,
    white: 1,
    snow: 3.2,
  };

  get(id: string): Kit {
    let kit = this.kits.get(id);
    if (!kit) {
      kit = new Kit(Kits.TILE[id] ?? 1);
      this.kits.set(id, kit);
    }
    return kit;
  }

  build() {
    return Object.fromEntries([...this.kits.entries()].filter(([, kit]) => !kit.empty).map(([id, kit]) => [id, kit.build()]));
  }
}

/**
 * Ce que les lames du toit dépassent du faîtage, de chaque côté : les deux pans se croisent au lieu de se
 * toucher par une arête. Une jonction bout à bout ne tient qu'au millimètre près, et le moindre écart
 * laisse passer le ciel en pointillé — c'est ce qu'on voyait de la mezzanine le long du pignon du fond
 * (11/11/2026) ; au faîtage les pans ne se recouvraient que de 1,5 cm, par leur seule épaisseur.
 */
const RIDGE_OVERLAP = 0.02;

/**
 * Le toit du corps principal sur une tranche de sa longueur : les lames du plafond sous les
 * chevrons, le faîtage, les sablières, les pannes, les chevrons. Le salon et la partie sud en ont
 * chacun leur tranche — deux groupes distincts, pour le dessin comme pour la lumière cuite.
 *
 * `overhang` prolonge les lames au-delà de `z0`, `overhangEnd` au-delà de `z1` : au droit d'un pignon,
 * elles passent par-dessus le mur au lieu de s'arrêter contre sa face (voir `GABLE_TOP`).
 */
export function roof(kits: Kits, z0: number, z1: number, overhang = 0, overhangEnd = 0): void {
  const timber = kits.get("timber");
  const planks = kits.get("planks");
  const ridgeY = ROOM.ridge - 0.22;
  timber.beam([0, ridgeY, z0 - overhang], [0, ridgeY, z1], 0.28, 0.36);
  for (const side of [-1, 1]) {
    // Sablière en tête de mur, panne à mi-pente.
    timber.beam([side * (W - 0.16), ROOM.eave - 0.14, z0], [side * (W - 0.16), ROOM.eave - 0.14, z1], 0.3, 0.28);
    const px = side * 2.9;
    timber.beam([px, roofY(px) - 0.16, z0], [px, roofY(px) - 0.16, z1], 0.2, 0.26);
    // Chevrons : leur trame est celle de toute la maison, quelle que soit la tranche.
    for (let z = ROOM.north + 0.35; z < ROOM.back; z += 0.6875) {
      if (z < z0 || z >= z1) continue;
      timber.beam([side * (W - 0.05), ROOM.eave - 0.04, z], [side * 0.14, roofY(0.14) - 0.09, z], 0.09, 0.15);
    }
    // Le pan, du faîtage (dépassé de `RIDGE_OVERLAP`) jusqu'à 0,4 m au-delà du mur : sa ligne médiane suit
    // `roofY + 0,09` — c'est elle que vise le haut des pignons.
    const reach = W + 0.4 + RIDGE_OVERLAP;
    const slopeLength = reach / Math.cos(ROOF_ANGLE);
    const cx = side * ((W + 0.4 - RIDGE_OVERLAP) / 2);
    const cy = ROOM.ridge + 0.09 - ((W + 0.4 - RIDGE_OVERLAP) / 2) * Math.tan(ROOF_ANGLE);
    planks.box([slopeLength, 0.05, z1 - z0 + overhang + overhangEnd], { at: [cx, cy, (z0 - overhang + z1 + overhangEnd) / 2], rot: [0, 0, -side * ROOF_ANGLE] }, 2);
  }
}

/**
 * Le haut d'un pignon du corps principal : la ligne médiane des lames du toit. Le mur entre ainsi dans
 * leur épaisseur (5 cm, de `roofY + 0,06` à `roofY + 0,12`) sans percer le dessus ; les lames, elles,
 * passent par-dessus le mur.
 */
export const GABLE_TOP = (x: number) => roofY(x) + 0.09;
