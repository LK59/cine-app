import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode, type EffectComposer as Composer } from "postprocessing";
import { HalfFloatType } from "three";
import { useProfile, useStore } from "../state/store";

/**
 * Le post-traitement : peu d'effets, chacun à sa place.
 *
 * - **AgX** pour le mappage de tons : il garde la couleur des hautes lumières (une flamme reste
 *   orange au lieu de virer au blanc) et descend doucement dans les ombres — ce qu'il faut à une
 *   pièce éclairée à la bougie.
 * - Un **halo** léger sur ce qui dépasse le blanc (flammes, abat-jour, écran).
 * - Une **occlusion ambiante** en espace écran aux préréglages hauts seulement : elle coûte cher à
 *   un processeur graphique intégré.
 * - **Vignette**, puis **SMAA**.
 *
 * Le rendu de la scène se fait en demi-flottants : les flammes y valent plus que 1, et c'est ce
 * surplus que le halo ramasse.
 */
/** La vignette, lue aussi par la passe qui redessine la vidéo après le compositeur (`Television`). */
export const VIGNETTE = { offset: 0.3, darkness: 0.55 } as const;

/** Le compositeur courant : sa profondeur sert à la passe de la vidéo. */
export const effects: { composer: Composer | null } = { composer: null };

export function Effects() {
  const profile = useProfile();
  // L'occlusion ambiante est cuite avec la lumière : en espace écran elle la compterait deux fois.
  const baked = useStore((s) => s.baked);
  const ao = baked ? "none" : profile.ao;
  return (
    <EffectComposer
      ref={(composer) => {
        effects.composer = composer;
      }}
      multisampling={0}
      frameBufferType={HalfFloatType}
      key={`${ao}-${profile.bloom}-${profile.smaa}`}
    >
      {/* Toujours en pleine résolution : le chemin demi-résolution de N8AO 2.0 crée une cible de rendu
          multiple que three r187 ne sait plus préparer (« texture.mipmaps » indéfini) — vu à la première
          capture. Le préréglage règle donc le nombre d'échantillons, pas la résolution. */}
      {ao !== "none" ? <N8AO aoRadius={1.1} distanceFalloff={1.2} intensity={2.4} quality={ao === "full" ? "high" : "low"} color="#0a0503" /> : <></>}
      {profile.bloom ? <Bloom mipmapBlur intensity={0.5} luminanceThreshold={1.05} luminanceSmoothing={0.25} radius={0.7} /> : <></>}
      <ToneMapping mode={ToneMappingMode.AGX} />
      <Vignette offset={VIGNETTE.offset} darkness={VIGNETTE.darkness} />
      {profile.smaa ? <SMAA /> : <></>}
    </EffectComposer>
  );
}
