import { BED, BREAST, KITCHEN, LAMPS, PLAN, ROOM, TABLE, span, type Solid } from "./layout";
import { useStore } from "../state/store";
import { visibleGroups } from "./Parts";
import { Model } from "./Model";
import { Solids } from "./Solids";

const W = ROOM.halfW;

const LOFT = ROOM.loft;

const SOLIDS: Solid[] = [
  // Le fauteuil du coin de la baie et sa table d'appoint.
  span(3.05, 4.0, 0, 0.9, -6.1, -5.15),
  span(4.25, 4.85, 0, 0.6, -6.3, -5.7),
  // Le fauteuil de lecture, côté sud.
  span(-4.6, -3.6, 0, 0.9, 2.2, 3.2),
  // Les plantes.
  span(-5.0, -4.4, 0, 1.2, -6.5, -5.9),
  span(4.35, 4.95, 0, 1.2, 2.2, 2.8),
  // Les tabourets de l'îlot.
  span(KITCHEN.island.x0 + 0.2, KITCHEN.island.x1 - 0.2, 0, 0.8, KITCHEN.island.z0 - 0.55, KITCHEN.island.z0),
  // La mezzanine : la méridienne, le fauteuil.
  span(2.3, 4.5, LOFT, LOFT + 0.8, 5.0, 6.0),
  span(-2.3, -1.3, LOFT, LOFT + 0.9, 5.3, 6.3),
  // Le fauteuil de la chambre.
  span(-1.6, -0.6, 0, 0.9, PLAN.bedroom.z1 - 1.3, PLAN.bedroom.z1 - 0.3),
];

/**
 * Les objets posés dans le salon : des modèles de la bibliothèque d'assets (tous CC0, voir
 * ASSETS.md). Ce sont eux qui font qu'une pièce a l'air habitée.
 */
export function Props() {
  const hearthY = 0.44;
  const hearthX = BREAST.face - 0.34;
  const visible = visibleGroups(useStore((s) => s.room));
  const stoolZ = KITCHEN.island.z0 - 0.3;
  return (
    <group>
      <group visible={visible.salon}>
        {/* Le coin de la baie : un fauteuil de cuir tourné vers la pièce, sa table, une lanterne. */}
        <Model id="modern_arm_chair_01" position={[3.5, 0, -5.6]} turn={-2.45} />
        <Model id="side_table_01" position={[4.55, 0, -6.0]} turn={0.2} />
        <Model id="wooden_lantern_01" position={[4.55, 0.56, -6.0]} turn={0.6} shadow={false} />
        {/* Le fauteuil de lecture, derrière le canapé côté sud. */}
        <Model id="mid_century_lounge_chair" position={[-4.1, 0, 2.7]} turn={2.3} />
        {/* Les plantes : au coin nord-ouest, et au sud du massif de pierre. */}
        <Model id="potted_plant_01" position={[-4.7, 0, -6.2]} scale={1.5} />
        <Model id="potted_plant_02" position={[4.65, 0, 2.5]} scale={1.6} />
        {/* Sur le banc de l'âtre : deux vases et deux lanternes, aux extrémités. */}
        <Model id="ceramic_vase_01" position={[hearthX, hearthY, BREAST.z0 + 0.02]} scale={1.15} />
        <Model id="ceramic_vase_03" position={[hearthX - 0.08, hearthY, BREAST.z1 + 0.02]} scale={1.1} />
        <Model id="Lantern_01" position={[hearthX - 0.12, hearthY, BREAST.z0 + 0.92]} turn={0.5} shadow={false} />
        <Model id="Lantern_01" position={[hearthX - 0.1, hearthY, BREAST.z1 - 0.72]} turn={-0.8} shadow={false} />
        {/* Sur la table basse : la coupe en bois. */}
        <Model id="wooden_bowl_01" position={[TABLE.x + 0.48, TABLE.h, TABLE.z - 0.12]} turn={0.7} shadow={false} />
        {/* Sur les guéridons, à côté des lampadaires. */}
        <Model id="mantel_clock_01" position={[LAMPS[0][0] + 0.62, 0.585, LAMPS[0][1]]} turn={Math.PI / 2 - 0.3} shadow={false} />
        <Model id="wooden_candlestick" position={[LAMPS[1][0] + 0.62, 0.585, LAMPS[1][1]]} shadow={false} />
        {/* Un tableau sur le mur ouest, entre deux fenêtres. */}
        <Model id="hanging_picture_frame_02" position={[-W + 0.03, 2.1, 1.25 + 1.4]} turn={Math.PI / 2} shadow={false} />
      </group>
      {/* La cuisine : trois tabourets devant l'îlot, tournés vers lui ; des vases sur les étagères. */}
      {[0.75, 1.4, 2.05].map((x) => (
        <Model key={x} id="bar_chair_round_01" position={[x, 0, stoolZ]} turn={Math.PI} />
      ))}
      <Model id="ceramic_vase_03" position={[1.55, 1.56, ROOM.back - 0.13]} scale={0.8} shadow={false} />
      <Model id="ceramic_vase_01" position={[2.1, 1.94, ROOM.back - 0.13]} scale={0.7} shadow={false} />
      <Model id="wooden_candlestick" position={[W - 0.24, KITCHEN.sideboard.top, KITCHEN.sideboard.z0 + 0.25]} shadow={false} />
      {/* La mezzanine : une méridienne sous la pente, un fauteuil et sa table, une plante. */}
      <Model id="vintage_day_bed" position={[3.4, LOFT, 5.5]} turn={Math.PI} />
      <Model id="modern_arm_chair_01" position={[-1.8, LOFT, 5.8]} turn={2.6} />
      <Model id="side_table_01" position={[-0.9, LOFT, 5.5]} turn={0.4} />
      <Model id="wooden_lantern_01" position={[-0.9, LOFT + 0.56, 5.5]} turn={-0.4} shadow={false} />
      <Model id="potted_plant_02" position={[4.7, LOFT, 9.0]} scale={1.3} />
      <group visible={visible.nuit}>
        {/* Le couloir : un tableau au-dessus de la console, un vase dessus. */}
        <Model id="hanging_picture_frame_02" position={[-4.0, 1.55, ROOM.back + 0.33]} shadow={false} />
        <Model id="ceramic_vase_01" position={[-3.7, 0.82, ROOM.back + 0.47]} scale={0.8} shadow={false} />
        {/* La chambre : un fauteuil près de la fenêtre, une plante, une horloge sur le meuble bas. */}
        <Model id="mid_century_lounge_chair" position={[-1.1, 0, PLAN.bedroom.z1 - 0.8]} turn={-2.4} />
        <Model id="potted_plant_01" position={[-5.0, 0, PLAN.bedroom.z1 - 0.5]} scale={1.3} />
        <Model id="mantel_clock_01" position={[PLAN.bedroom.x1 - 0.22, 0.59, BED.z + 0.62]} turn={-Math.PI / 2} shadow={false} />
      </group>
      <Solids solids={SOLIDS} />
    </group>
  );
}
