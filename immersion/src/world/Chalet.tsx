import { Atmosphere } from "./Atmosphere";
import { Candles } from "./Candles";
import { Exterior } from "./Exterior";
import { Fixtures } from "./Fixtures";
import { Parts } from "./Parts";
import { Lights } from "./Lights";
import { Props } from "./Props";
import { SoundScape } from "./SoundScape";
import { Screens } from "./Screens";

/** Le chalet : l'enveloppe du salon, son mobilier, ses lumières, et la nuit autour. */
export function Chalet() {
  return (
    <group>
      <Parts />
      <Fixtures />
      <Screens />
      <SoundScape />
      <Props />
      <Candles />
      <Lights />
      <Exterior />
      <Atmosphere />
    </group>
  );
}
