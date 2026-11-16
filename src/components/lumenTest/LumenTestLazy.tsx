"use client";

import dynamic from "next/dynamic";

// La page de banc appelle le moteur du lecteur actuel (`currentPlayer.ts` → `remuxPlayback`, décodeurs
// en WebAssembly) : rendue côté serveur, elle faisait entrer ce moteur dans le rendu serveur, et
// `next build` échouait sur `@eshaz/web-worker` (import dynamique introuvable, 16/11/2026). Comme le
// lecteur lui-même (`PlayerHostLazy`), elle ne se rend que dans le navigateur.
export const LumenTestLazy = dynamic(() => import("@/components/lumenTest/LumenTest").then((m) => m.LumenTest), { ssr: false });
