/// <reference types="vite/client" />

/** L'empreinte des assets 3D, posée par `vite.config.ts` — voir `assetUrl`. */
declare const __ASSETS_VERSION__: string;
/** Les paquets d'assets du build (`vite.config.ts`, `assetPacks`) : nom et taille ; vide en développement. */
declare const __PACKS__: { name: string; bytes: number }[];
