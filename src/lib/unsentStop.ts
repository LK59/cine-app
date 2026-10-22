"use client";

import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { persistedCacheAccount } from "@/lib/persistentCache";

/**
 * Le bilan d'une séance, gardé sur l'appareil tant qu'il n'est pas parti.
 *
 * Une page qu'iOS tue en arrière-plan ne reçoit ni `pagehide` ni rien d'autre : sa ligne `stop`
 * ne peut pas partir à ce moment-là. Sur les 163 séances du 21 au 23/09/2026, douze n'en avaient
 * pas — l'application quittée, tuée, relancée, et le même film rouvert à la position que Jellyfin
 * avait gardée. Le bilan est donc écrit ici au fil de la séance, effacé quand l'arrêt part, et
 * envoyé au lancement suivant s'il est resté là : en retard, marqué `why: "lost"`, mais avec ce
 * qui s'était passé.
 *
 * Une clé par séance, pour que deux onglets ne s'écrasent pas. Un bilan n'est déclaré perdu
 * qu'après `ORPHAN_AFTER_MS` sans mise à jour : la séance vivante le réécrit bien plus souvent.
 * Si un onglet endormi se réveille après avoir été déclaré perdu, sa vraie ligne `stop` part
 * quand même — le bilan hebdomadaire garde la dernière ligne d'une même séance (`session`).
 *
 * Le stockage du navigateur peut manquer ou refuser (navigation privée, stockage plein) : rien
 * ici ne doit jamais gêner un film, tout est donc dans un `try`.
 */

const PREFIX = "cine:unsent-stop:";
/**
 * « La séance vit encore » : un horodatage seul, à côté du bilan (13/10/2026).
 *
 * Le bilan entier (~2 Ko, et ses centiles triés) était réécrit toutes les 30 s pour la seule raison
 * de rester frais. Il ne l'est plus que lorsqu'il a changé (voir `ExperimentalPlayerHost`) ; entre
 * deux, la séance vivante pose ici l'heure — une quinzaine d'octets —, et c'est la plus récente des
 * deux qui dit si le bilan est en plan. Le préfixe diffère de `PREFIX` dès son treizième caractère :
 * la recherche des bilans ne le confond pas avec l'un d'eux.
 */
const ALIVE_PREFIX = "cine:unsent-stop-alive:";
/** Deux minutes sans signe de vie : la séance vivante en donne un toutes les 30 s au plus. */
export const ORPHAN_AFTER_MS = 2 * 60_000;

interface Saved {
  savedAt: number;
  fields: Record<string, unknown>;
  /**
   * Le compte de la séance. Sans lui, un bilan resté en plan partait sous la session suivante,
   * quelle qu'elle soit : sur un iPad partagé, le film d'une personne s'inscrivait dans le journal
   * — et dans la reprise Jellyfin — d'une autre (audit du 26/09/2026). Absent des bilans d'avant.
   */
  account?: string | null;
}

/** Un bilan d'un autre compte attend son retour — une semaine, pas davantage. */
const OTHER_ACCOUNT_KEEP_MS = 7 * 24 * 3600_000;

/**
 * Les séances que cette page fait vivre en ce moment (22/10/2026).
 *
 * Un Mac endormi quatre heures au milieu d'un film ne donne aucun signe de vie ; à son réveil, la
 * minuterie de `flushOrphanStops` passait avant celle de la séance, trouvait le bilan en plan et
 * l'envoyait comme perdu — suivi une seconde plus tard du vrai `stop "close"` de la même séance
 * (13 séances ainsi dans le journal d'octobre). Une séance que cette page tient encore n'est pas
 * perdue, quel que soit son silence : seule une page tuée, dont ce module disparaît avec elle, en
 * laisse une à renvoyer au lancement suivant.
 */
const livingHere = new Set<string>();

export function saveUnsentStop(session: string, fields: Record<string, unknown>, now = Date.now(), { livesHere = false }: { livesHere?: boolean } = {}): void {
  if (livesHere) livingHere.add(session);
  try {
    // Le build de la séance, gardé avec elle : le bilan part au lancement suivant, qui peut tourner
    // sur un autre code.
    localStorage.setItem(
      PREFIX + session,
      JSON.stringify({ savedAt: now, fields: { build: APP_BUILD, version: APP_VERSION, ...fields }, account: persistedCacheAccount() } satisfies Saved)
    );
  } catch {
    // Pas de stockage : la séance se passera de filet.
  }
}

/**
 * La séance vit, son bilan n'a pas changé : seule l'heure est posée — voir `ALIVE_PREFIX`. Rien si
 * aucun bilan n'a encore été gardé (il n'y aurait rien à garder frais).
 */
export function touchUnsentStop(session: string, now = Date.now()): void {
  try {
    if (localStorage.getItem(PREFIX + session) === null) return;
    localStorage.setItem(ALIVE_PREFIX + session, String(now));
  } catch {
    // Pas de stockage : la séance se passera de filet.
  }
}

export function clearUnsentStop(session: string): void {
  livingHere.delete(session);
  try {
    localStorage.removeItem(PREFIX + session);
    localStorage.removeItem(ALIVE_PREFIX + session);
  } catch {
    // Rien à faire.
  }
}

/** Le dernier signe de vie d'une séance : son bilan, ou l'heure posée depuis, la plus récente. */
function lastAlive(key: string, savedAt: number): number {
  try {
    const touched = Number(localStorage.getItem(ALIVE_PREFIX + key.slice(PREFIX.length)));
    return Number.isFinite(touched) && touched > savedAt ? touched : savedAt;
  } catch {
    return savedAt;
  }
}

/**
 * Les bilans restés en plan, prêts à envoyer — sans les retirer : ils ne partent du stockage
 * qu'une fois acceptés (voir `flushOrphanStops`).
 */
export function findOrphanStops(now = Date.now(), account: string | null = persistedCacheAccount()): { key: string; fields: Record<string, unknown> }[] {
  // Personne de connu (l'écran de connexion) : rien ne partirait, la route refuse sans session.
  if (!account) return [];
  const found: { key: string; fields: Record<string, unknown> }[] = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let saved: Saved | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? "null") as Saved | null;
      } catch {
        saved = null;
      }
      // Illisible : on ne le gardera pas indéfiniment.
      if (!saved || typeof saved.savedAt !== "number" || !saved.fields) {
        localStorage.removeItem(key);
        localStorage.removeItem(ALIVE_PREFIX + key.slice(PREFIX.length));
        continue;
      }
      // Tenue par cette page : vivante, même endormie — voir `livingHere`.
      if (livingHere.has(key.slice(PREFIX.length))) continue;
      // Vivante tant que la séance donne signe de vie, même sans réécrire son bilan.
      const aliveAt = lastAlive(key, saved.savedAt);
      if (now - aliveAt < ORPHAN_AFTER_MS) continue;
      // Trop vieux, même pour ce compte (08/10/2026) : un bilan refusé chaque minute depuis une
      // semaine ne passera plus — il repartait pourtant à chaque tour, sans fin.
      if (now - saved.savedAt > OTHER_ACCOUNT_KEEP_MS) {
        localStorage.removeItem(key);
        localStorage.removeItem(ALIVE_PREFIX + key.slice(PREFIX.length));
        continue;
      }
      // Le bilan d'un autre compte n'est pas le nôtre : il attend que ce compte revienne.
      if (saved.account && saved.account !== account) {
        if (now - saved.savedAt > OTHER_ACCOUNT_KEEP_MS) localStorage.removeItem(key);
        continue;
      }
      // En retard depuis son dernier signe de vie : c'est là que la séance s'est tue (§42).
      found.push({ key, fields: { ...saved.fields, why: "lost", lateByMs: now - aliveAt } });
    }
  } catch {
    // Stockage indisponible.
  }
  return found;
}

/**
 * Envoie ce qui est resté en plan. Appelé au lancement, puis chaque minute.
 *
 * Par `fetch` et non par balise, et retiré seulement sur une réponse acceptée : l'application
 * s'ouvre aussi sur l'écran de connexion, où la route refuse faute de session — un bilan envoyé
 * là et effacé aussitôt aurait été perdu une seconde fois.
 */
let flushing = false;

export async function flushOrphanStops(now = Date.now()): Promise<void> {
  // Un envoi lent ne doit pas croiser le suivant : la même ligne partirait deux fois.
  if (flushing) return;
  flushing = true;
  try {
    await sendOrphans(now);
  } finally {
    flushing = false;
  }
}

async function sendOrphans(now: number): Promise<void> {
  for (const { key, fields } of findOrphanStops(now)) {
    try {
      const res = await fetch("/api/player/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "stop", fields }),
      });
      if (res.ok || res.status === 400) {
        // 400 : le serveur ne veut pas de cette ligne, et ne la voudra jamais.
        localStorage.removeItem(key);
        localStorage.removeItem(ALIVE_PREFIX + key.slice(PREFIX.length));
      }
      // Tout autre refus (session absente, trop de lignes, serveur qui redémarre) vaut pour les
      // suivantes aussi : le tour s'arrête là, comme celui de `unsentLines` (08/10/2026).
      else return;
    } catch {
      // Hors ligne : ce sera pour la prochaine fois — les suivantes aussi.
      return;
    }
  }
}
