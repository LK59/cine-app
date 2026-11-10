/**
 * L'adresse d'un asset 3D (`public/assets/…`).
 *
 * Elle porte l'empreinte de l'ensemble des assets : le serveur peut alors la dire `immutable`, et
 * une deuxième visite ne redemande rien. Les fichiers qu'un `.gltf` nomme lui-même (`.bin`,
 * textures) partent sans elle et sont simplement revalidés.
 */
export function assetUrl(file: string): string {
  return `${import.meta.env.BASE_URL}assets/${file}?v=${__ASSETS_VERSION__}`;
}

/** Le dossier du transcodeur Basis (émis par `vite.config.ts`). */
export const BASIS_PATH = `${import.meta.env.BASE_URL}basis/`;
