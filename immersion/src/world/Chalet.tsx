import { Atmosphere } from "./Atmosphere";
import { Candles } from "./Candles";
import { Exterior } from "./Exterior";
import { Furniture } from "./Furniture";
import { Lights } from "./Lights";
import { Props } from "./Props";
import { Shell } from "./Shell";

/** Le chalet : l'enveloppe du salon, son mobilier, ses lumières, et la nuit autour. */
export function Chalet() {
  return (
    <group>
      <Shell />
      <Furniture />
      <Props />
      <Candles />
      <Lights />
      <Exterior />
      <Atmosphere />
    </group>
  );
}
