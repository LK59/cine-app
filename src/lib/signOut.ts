"use client";

import { forgetPrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { clearPersistedCache } from "@/lib/persistentCache";
import { clearResumeStore } from "@/lib/resumeCache/store";

/**
 * Se déconnecter : prévenir le serveur, puis aller à la page de connexion — **quoi qu'il arrive**.
 *
 * Trois boutons l'écrivaient chacun (`await fetch(...)` puis `router.replace("/login")`), et aucun
 * ne gardait l'appel : hors ligne, `fetch` levait, la redirection ne partait jamais, et l'échec
 * finissait en rejet non géré dans server.log. On appuyait sur « Se déconnecter » et rien ne se
 * passait. L'appel au serveur est une politesse — il révoque la session de son côté — ; partir
 * vers la connexion, c'est ce que la personne a demandé.
 */
export async function signOut(go: (path: string) => void): Promise<void> {
  // L'état du spectateur demandé d'avance n'est rangé que par titre, et partir vers la connexion
  // ne recharge pas la page : le compte suivant, ouvrant le même film dans les trente secondes,
  // reprenait à la position du compte qui venait de partir (chasse aux bugs du 22/09/2026).
  forgetPrefetchedPlaybackState();
  // Le catalogue gardé sur l'appareil part avec la session : un iPad partagé ne doit rien garder
  // de la bibliothèque ni de la reprise de qui que ce soit. Borné : un stockage lent ne retient
  // pas la personne sur la page qu'elle quitte.
  // Les octets gardés pour la reprise instantanée aussi (`src/lib/resumeCache/`), dans le même délai.
  await Promise.race([Promise.all([clearPersistedCache(), clearResumeStore()]), new Promise((resolve) => setTimeout(resolve, 500))]);
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Hors ligne ou serveur absent : la page de connexion reste la destination demandée.
  }
  go("/login");
}
