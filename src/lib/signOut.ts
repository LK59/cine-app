"use client";

import { forgetPrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { clearPersistedCache } from "@/lib/persistentCache";
import { clearResumeStore } from "@/lib/resumeCache/store";
import { forgetSearches } from "@/lib/recentSearches";

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
  // Les recherches récentes ne sont rangées sous aucun compte : le suivant voyait ce que le
  // précédent avait tapé et ouvert (audit du 26/09/2026).
  forgetSearches();
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

/**
 * Changer de compte recharge la page, en partant comme en arrivant.
 *
 * Une navigation interne garde toute la mémoire de la page : le cache de SWR, le compte sous lequel
 * le cache de l'appareil et la reprise instantanée rangent ce qu'ils écrivent, les préchargements.
 * Après « Se déconnecter » puis une autre connexion dans le même onglet, le compte suivant voyait
 * « Reprendre » et « Ma liste » du précédent, et ses propres données étaient rangées sous l'autre
 * nom (chasse aux défauts du 25/09/2026). Un vrai chargement repart de zéro — c'est l'écran de
 * lancement d'une seconde, à un moment où aucun film ne joue.
 */
export function hardNavigate(path: string): void {
  window.location.replace(path);
}

/**
 * La destination après connexion : un chemin de ce site, jamais une autre adresse. `next` vient de
 * l'adresse de la page — un lien piégé pouvait sinon renvoyer ailleurs une fois connecté.
 *
 * Résolue comme le navigateur la résoudra, puis comparée par origine : refuser `//` et `/\` à la
 * main laissait passer `/<tab>/ailleurs.example`, que l'analyseur d'URL lit `//ailleurs.example`
 * après avoir retiré la tabulation (audit du 26/09/2026). Les caractères de contrôle sont refusés
 * d'office — aucun chemin légitime n'en porte.
 */
export function safeNextPath(asked: string | null, fallback: string): string {
  if (!asked || !asked.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(asked)) return fallback;
  try {
    const base = "https://cine.invalid";
    const url = new URL(asked, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

