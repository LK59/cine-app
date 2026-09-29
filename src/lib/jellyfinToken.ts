// Le jeton Jellyfin d'une session : encore accepté, ou révoqué derrière elle.
//
// La session de l'application porte le jeton que Jellyfin a remis à la connexion, et se prolonge
// à chaque visite. Jellyfin, lui, révoque tous les jetons d'un compte quand son mot de passe est
// changé ou réinitialisé. Les deux vivaient donc chacun leur vie : un compte dont le mot de passe
// avait été réinitialisé plusieurs fois a continué d'utiliser l'application six jours avec un jeton
// mort (24/09/2026). Chaque rapport de lecture était refusé — « Invalid token » toutes les 10 s
// dans le journal de Jellyfin —, rien ne s'affichait, et Jellyfin croyait qu'il n'avait jamais rien
// regardé : un film repris le lendemain repartait de zéro.
//
// Deux moments le découvrent, et un seul conclut :
//  - un rapport de lecture refusé (`markJellyfinTokenDead`) : pendant un film, on n'interrompt
//    rien, la position est sauvée autrement (voir `playbackReport.ts`) ;
//  - le proxy, au chargement d'une page (`jellyfinTokenAlive`), au plus une fois par heure et par
//    session : c'est lui qui ferme la session et renvoie à la connexion, jamais pendant un film.
//
// La même question relit aussi le compte. Le rôle n'était lu qu'à la connexion, et la prolongation
// glissante le recopiait sans fin : un administrateur rétrogradé dans Jellyfin restait
// administrateur ici à vie, et un compte désactivé gardait sa session tant que son jeton n'était
// pas refusé par un 401. Retirer un accès dans Jellyfin ne retirait donc rien. Désormais un 403,
// `Policy.IsDisabled`, ou un `Policy.IsAdministrator` qui ne dit plus le rôle de la session ferment
// la session par le même chemin qu'un jeton révoqué — la connexion suivante relit le rôle.

import { jellyfin } from "@/lib/clients/jellyfin";
import { HttpError } from "@/lib/http";
import { logError } from "@/lib/logger";
import type { SessionPayload } from "@/lib/auth";

/** Au plus une question à Jellyfin par session et par heure. */
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** Une réponse qui n'en était pas une (serveur absent, trop lent) : reposée plus tôt. */
const RETRY_UNKNOWN_MS = 5 * 60 * 1000;

type Verdict = { at: number; alive: boolean; certain: boolean };
const verdicts = new Map<string, Verdict>();

function forget(now: number): void {
  // Borné par le nombre de sessions, mais un redémarrage n'arrive pas toujours avant qu'elles
  // s'accumulent : ce qui a plus de deux heures ne dit plus rien.
  if (verdicts.size < 500) return;
  for (const [jti, verdict] of verdicts) if (now - verdict.at > 2 * CHECK_EVERY_MS) verdicts.delete(jti);
}

function who(session: SessionPayload): string {
  return session.jfUser ?? session.u;
}

/**
 * Jellyfin vient de refuser le jeton de cette session. Écrit une fois par session : un film
 * rapporte sa position toutes les dix secondes, et c'est le même fait.
 */
export function markJellyfinTokenDead(
  session: SessionPayload,
  where: string,
  why = "Jellyfin refuse le jeton de ce compte",
): void {
  const known = verdicts.get(session.jti ?? "");
  if (!session.jti || (known && !known.alive)) return;
  verdicts.set(session.jti, { at: Date.now(), alive: false, certain: true });
  logError("jellyfin-token", new Error(why), { user: who(session), where });
}

/**
 * Ce que le compte dit de lui-même contredit-il la session ? `null` quand il ne dit rien : une
 * réponse sans `Policy` ne permet pas de conclure, et on ne ferme pas une session sur un silence.
 */
function accountChanged(session: SessionPayload, me: Awaited<ReturnType<typeof jellyfin.checkUserToken>>): string | null {
  const policy = me?.Policy;
  if (!policy) return null;
  if (policy.IsDisabled === true) return "Compte désactivé dans Jellyfin";
  if (typeof policy.IsAdministrator === "boolean" && policy.IsAdministrator !== (session.role === "admin")) {
    return "Rôle changé dans Jellyfin depuis la connexion";
  }
  return null;
}

/**
 * La session peut-elle continuer ? Faux seulement sur un refus explicite (401, ou 403 d'un compte
 * désactivé) ou sur un compte qui contredit la session (désactivé, rôle changé) : un Jellyfin
 * absent, lent ou en erreur ne dit rien du jeton, et fermer une session là-dessus déconnecterait
 * tout le monde à chaque redémarrage du serveur.
 */
export async function jellyfinTokenAlive(session: SessionPayload): Promise<boolean> {
  if (!session.jfToken || !session.jti) return true;
  const now = Date.now();
  const known = verdicts.get(session.jti);
  if (known && !known.alive) return false;
  if (known && now - known.at < (known.certain ? CHECK_EVERY_MS : RETRY_UNKNOWN_MS)) return true;
  forget(now);
  try {
    const me = await jellyfin.checkUserToken(session.jfToken);
    const changed = accountChanged(session, me);
    if (changed) {
      markJellyfinTokenDead(session, "vérification au chargement d'une page", changed);
      return false;
    }
    verdicts.set(session.jti, { at: now, alive: true, certain: true });
    return true;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      markJellyfinTokenDead(session, "vérification au chargement d'une page");
      return false;
    }
    verdicts.set(session.jti, { at: now, alive: true, certain: false });
    return true;
  }
}

/** La session vient d'être fermée : son verdict n'a plus d'objet. */
export function forgetJellyfinToken(jti: string): void {
  verdicts.delete(jti);
}

export const __testing = { reset: () => verdicts.clear() };
