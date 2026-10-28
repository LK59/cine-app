"use client";

import { forgetPrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { forgetDirectInfo } from "@/lib/directInfo";
import { touchHintHeaders } from "@/lib/deviceLabel";
import { clearPersistedCache } from "@/lib/persistentCache";
import { clearResumeStore } from "@/lib/resumeCache/store";
import { forgetSearches } from "@/lib/recentSearches";
import { forgetHomeLayoutMirror } from "@/lib/useHomeLayout";
import { forgetGuidedScrollMirror } from "@/lib/guidedScroll";
import { dropPushOnSignOut } from "@/lib/pushOnSignOut";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { forgetOfflineAccount } from "@/lib/offline/offlineEntry";

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
  // Le compte que l'entrée hors ligne des téléchargements montre (`offlineEntry.ts`, §109) : les
  // fichiers restent sur l'appareil, mais `/hors-ligne`, ouverte sans session, ne les montre plus.
  // Propre au bouton : une session expirée garde cette entrée (`noteUnauthorized`) — la question
  // des téléchargements n'est posée qu'à qui se déconnecte lui-même (20/10/2026).
  forgetOfflineAccount();
  await forgetAccountOnDevice(500);
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: touchHintHeaders() });
  } catch {
    // Hors ligne ou serveur absent : la page de connexion reste la destination demandée.
  }
  go("/login");
}

/**
 * Ce que l'appareil oublie du compte qui part — par le bouton (`signOut`) comme quand la session
 * disparaît sous la page (`noteUnauthorized`, sept jours écoulés ou session fermée ailleurs).
 *
 * Seul le bouton nettoyait : une session expirée sur un iPad partagé laissait au compte suivant le
 * catalogue, la reprise, les recherches et les notifications du précédent (revue de sécurité du
 * 20/10/2026). Une seule fonction pour les deux sorties, pour qu'elles ne divergent plus.
 *
 * Ne lève jamais, et n'attend jamais plus de `budgetMs` : un stockage lent ne retient pas la
 * personne sur la page qu'elle quitte. Chaque étape est gardée seule — une qui échoue ne prive pas
 * les autres de leur effacement.
 */
export async function forgetAccountOnDevice(budgetMs: number): Promise<void> {
  const step = (f: () => void) => {
    try {
      f();
    } catch {
      // Une étape de plus ou de moins : la sortie continue.
    }
  };
  // L'état du spectateur demandé d'avance n'est rangé que par titre, et partir vers la connexion
  // ne recharge pas la page : le compte suivant, ouvrant le même film dans les trente secondes,
  // reprenait à la position du compte qui venait de partir (chasse aux bugs du 22/09/2026).
  step(forgetPrefetchedPlaybackState);
  // La description des fichiers aussi : la route la refuse à un compte qui lit par le serveur.
  step(forgetDirectInfo);
  // Les recherches récentes ne sont rangées sous aucun compte : le suivant voyait ce que le
  // précédent avait tapé et ouvert (audit du 26/09/2026).
  step(forgetSearches);
  // Les choix d'accueil gardés sur l'appareil (disposition, défilement guidé) : le compte suivant
  // voyait un instant l'accueil du précédent, le temps que ses propres préférences arrivent
  // (audit du 08/10/2026).
  step(forgetHomeLayoutMirror);
  step(forgetGuidedScrollMirror);
  // Les livres (§127) : la file des positions et signets en attente, les positions et signets gardés
  // pour la lecture hors ligne (`books/bookSync.ts`) — tous rangés sous `laterna:books:`. Écrit ici sans
  // importer le module des livres, que le cinéma ne charge pas. Les réglages du lecteur
  // (`laterna:books:reader`) sont ceux de l'appareil, pas du compte : ils restent.
  step(() => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith("laterna:books:") && key !== "laterna:books:reader") localStorage.removeItem(key);
    }
  });
  // Le catalogue gardé sur l'appareil part avec la session : un iPad partagé ne doit rien garder
  // de la bibliothèque ni de la reprise de qui que ce soit.
  // Les octets gardés pour la reprise instantanée aussi (`src/lib/resumeCache/`), dans le même délai.
  // Sous quel compte retenir que les notifications étaient activées — voir `pushOnSignOut`. Lu
  // avant l'effacement, qui oublie le compte de la page.
  let account: string | null = null;
  step(() => {
    account = persistedCacheAccount();
  });
  const guarded = (f: () => Promise<unknown>) => {
    try {
      return f().catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
  // Les notifications de cet appareil aussi : sinon elles iraient au compte suivant.
  await Promise.race([
    Promise.all([guarded(clearPersistedCache), guarded(clearResumeStore), guarded(() => dropPushOnSignOut(account))]),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);
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
/**
 * `next`, complété du fragment que la page de connexion porte elle-même (DECISIONS.md §101).
 *
 * Un navigateur ne transmet jamais le fragment au serveur, mais le recolle à l'adresse d'arrivée
 * d'une redirection qui n'en a pas : `/#film=920` refusé par le proxy devient
 * `/login?next=%2F#film=920`. Le fragment était donc là, sous les yeux de la page, et perdu à la
 * connexion. Un `next` qui nomme déjà son fragment (`noteUnauthorized`) l'emporte ; le résultat
 * passe toujours par `safeNextPath`.
 */
export function nextWithFragment(asked: string | null, hash: string): string | null {
  if (!asked || asked.includes("#") || !hash || hash === "#") return asked;
  return asked + (hash.startsWith("#") ? hash : `#${hash}`);
}

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

