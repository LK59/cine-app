import { Bloom, EffectComposer, FXAA, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { Effect, ToneMappingMode, type EffectComposer as Composer } from "postprocessing";
import { useMemo } from "react";
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
 * - **Vignette**, puis l'anticrénelage (**FXAA**).
 *
 * Le rendu de la scène se fait en demi-flottants : les flammes y valent plus que 1, et c'est ce
 * surplus que le halo ramasse.
 */
/** La vignette, lue aussi par la passe qui redessine la vidéo après le compositeur (`Television`). */
export const VIGNETTE = { offset: 0.3, darkness: 0.55 } as const;

/** Le compositeur courant : sa profondeur sert à la passe de la vidéo. */
export const effects: { composer: Composer | null } = { composer: null };

/**
 * Le grain : un bruit ajouté à la couleur, plus présent dans les ombres. Écrit ici plutôt que pris à la
 * bibliothèque : son effet « Noise » tient compte de la transparence laissée dans l'image par les
 * vitres et les flammes, et y semait des points blancs.
 */
class GrainEffect extends Effect {
  constructor() {
    super(
      "GrainEffect",
      /* glsl */ `
        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          float n = fract(sin(dot(uv * resolution.xy + mod(time, 10.0) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
          float shadows = 1.0 - dot(inputColor.rgb, vec3(0.3333));
          outputColor = vec4(max(inputColor.rgb + n * 0.014 * (0.5 + 0.5 * shadows), 0.0), inputColor.a);
        }
      `
    );
  }
}

export function Effects() {
  const profile = useProfile();
  const grain = useMemo(() => new GrainEffect(), []);
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
{/* Un grain très léger : il casse les aplats des dégradés sombres (les bandes d'un ciel de nuit) et donne
          à l'image sa matière. La vidéo, redessinée après le compositeur, n'en reçoit pas. */}
      {profile.bloom ? <primitive object={grain} dispose={null} /> : <></>}
      {/* FXAA et non SMAA : SMAA charge ses deux tables depuis des images embarquées (`data:`), que la politique
          de sécurité de l'application refuse (`img-src` sans `data:`) — l'effet restait sans ses tables en
          production. FXAA n'est qu'un programme : rien à charger. */}
      {profile.smaa ? <FXAA /> : <></>}
    </EffectComposer>
  );
}
