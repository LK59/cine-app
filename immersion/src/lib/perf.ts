/**
 * Les interrupteurs de mesure : ce que le banc (`tests/perf.mjs`) coupe pour savoir ce que chaque chose
 * coûte sur une vraie carte graphique. Tous vrais en temps normal ; rien dans l'interface ne les touche.
 */
import { MeshBasicMaterial } from "three";

export const perf = {
  /** De quoi fabriquer des matières de remplacement depuis le banc. */
  three: { MeshBasicMaterial },
  /** La passe qui redessine la vidéo par-dessus le compositeur. */
  overlay: true,
  /** La lumière des écrans dans les matières (ambilight, halo, reflets). */
  screenLight: true,
  /** La copie réduite de l'image vidéo et sa relecture. */
  sample: true,
};
