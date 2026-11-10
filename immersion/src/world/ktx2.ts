import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import type { WebGLRenderer } from "three";
import { BASIS_PATH } from "../lib/assets";

/**
 * Le chargeur KTX2 du moteur de rendu : **un seul**, partagé par les matières, les modèles, le
 * panorama et les lightmaps. Chaque chargeur a son propre groupe de travailleurs de transcodage ;
 * en créer plusieurs les multiplie pour rien (three le signale).
 */
const loaders = new WeakMap<WebGLRenderer, KTX2Loader>();

export function ktx2For(gl: WebGLRenderer): KTX2Loader {
  let loader = loaders.get(gl);
  if (!loader) {
    loader = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(gl);
    loaders.set(gl, loader);
  }
  return loader;
}
