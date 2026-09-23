import { jellyseerr, type JellyseerrUser } from "@/lib/clients/jellyseerr";
import { logError } from "@/lib/logger";
import type { SessionPayload } from "@/lib/auth";

/**
 * Qui est cette personne pour Jellyseerr — la seule réponse à cette question dans cine-app.
 *
 * Le cookie Jellyseerr n'est obtenu qu'à la connexion à cine-app, et la session le garde des
 * semaines. Un compte qui s'est connecté *avant* d'exister dans Jellyseerr — créé dans Jellyfin,
 * importé plus tard, ou jamais — garde donc une session sans cookie, et ses demandes partaient
 * avec la clé d'API seule : Jellyseerr les signait du nom de son propriétaire. Constaté le
 * 23/09/2026 sur une série demandée depuis un compte connecté deux jours avant son import.
 *
 * L'ordre :
 *
 *  1. le cookie de la session, s'il est encore accepté — Jellyseerr applique alors les droits de
 *     la personne elle-même, comme dans sa propre interface ;
 *  2. sinon, le compte Jellyseerr lié à cet utilisateur Jellyfin, trouvé avec la clé d'API — et
 *     la demande part **à son nom** (`userId`), ce que Jellyseerr accepte de la clé ;
 *  3. sinon, ce compte est importé depuis Jellyfin (le même import que le bouton de Jellyseerr,
 *     pour ce seul utilisateur), puis retrouvé ;
 *  4. sinon, rien : la demande part avec la clé seule, au nom de son propriétaire. Choix
 *     délibéré — l'attribution sert au suivi, et une demande mal signée vaut mieux qu'une demande
 *     refusée. L'échec est journalisé pour qu'on sache pourquoi.
 *
 * Les comptes sont reconnus par leur identifiant Jellyfin, pas par leur nom : un nom se renomme,
 * l'identifiant non. Le nom ne sert qu'aux sessions qui n'ont pas d'identifiant.
 */

export interface JellyseerrIdentity {
  /** Le cookie de la session, seulement s'il vient d'être accepté par Jellyseerr. */
  cookie?: string;
  /** Le compte Jellyseerr de la personne, ou `null` quand il reste introuvable. */
  userId: number | null;
}

/** La liste des comptes change à chaque import, rarement autrement. */
const USERS_TTL_MS = 5 * 60_000;
/** Un import qui a échoué n'est pas retenté à chaque geste : Jellyseerr ne va pas changer d'avis. */
const IMPORT_RETRY_MS = 5 * 60_000;

let usersCache: { at: number; users: JellyseerrUser[] } | null = null;
const failedImports = new Map<string, number>();

/** Pour les tests : chaque cas repart d'une instance neuve. */
export function resetJellyseerrIdentityCache(): void {
  usersCache = null;
  failedImports.clear();
}

/** Jellyfin écrit ses identifiants avec ou sans tirets selon l'endroit ; Jellyseerr aussi. */
const guid = (id: string | null | undefined) => (id ?? "").replace(/-/g, "").toLowerCase();

export function findJellyseerrUser(
  users: JellyseerrUser[],
  jfId: string | undefined,
  jfUser: string | undefined,
): JellyseerrUser | undefined {
  if (jfId) {
    const byId = users.find((u) => u.jellyfinUserId && guid(u.jellyfinUserId) === guid(jfId));
    if (byId) return byId;
  }
  if (jfUser) {
    const name = jfUser.toLowerCase();
    return users.find((u) => u.jellyfinUsername?.toLowerCase() === name);
  }
  return undefined;
}

async function listUsers(fresh: boolean): Promise<JellyseerrUser[] | null> {
  if (!fresh && usersCache && Date.now() - usersCache.at < USERS_TTL_MS) return usersCache.users;
  try {
    const data = await jellyseerr.getUsers();
    usersCache = { at: Date.now(), users: data.results };
    return data.results;
  } catch (err) {
    logError("jellyseerr-identity", err, { step: "users" });
    return null;
  }
}

/**
 * Le compte Jellyseerr de cet utilisateur Jellyfin, importé s'il n'existe pas encore.
 *
 * Une liste en cache qui ne le connaît pas est relue une fois avant d'importer : il a pu être
 * importé à la main entre-temps, et importer un compte déjà présent ne crée rien mais coûte un
 * aller-retour vers Jellyfin.
 */
export async function ensureJellyseerrUserId(jfId: string | undefined, jfUser: string | undefined): Promise<number | null> {
  if (!jfId && !jfUser) return null;

  const cached = await listUsers(false);
  const known = cached && findJellyseerrUser(cached, jfId, jfUser);
  if (known) return known.id;

  const fresh = await listUsers(true);
  const found = fresh && findJellyseerrUser(fresh, jfId, jfUser);
  if (found) return found.id;
  // Sans liste, on ne sait pas s'il existe : importer à l'aveugle ne dirait rien de plus.
  if (!fresh || !jfId) return null;

  const failedAt = failedImports.get(guid(jfId));
  if (failedAt !== undefined && Date.now() - failedAt < IMPORT_RETRY_MS) return null;

  try {
    await jellyseerr.importFromJellyfin([jfId]);
  } catch (err) {
    failedImports.set(guid(jfId), Date.now());
    logError("jellyseerr-identity", err, { step: "import", jfUser });
    return null;
  }
  const after = await listUsers(true);
  const imported = after && findJellyseerrUser(after, jfId, jfUser);
  if (imported) return imported.id;
  failedImports.set(guid(jfId), Date.now());
  logError("jellyseerr-identity", new Error("compte absent après l'import"), { step: "import", jfUser });
  return null;
}

export async function resolveJellyseerrIdentity(session: SessionPayload): Promise<JellyseerrIdentity> {
  if (session.jsCookie) {
    // Refusé, expiré, ou Jellyseerr qui ne répond pas : on passe au compte nommé à la clé, et le
    // cookie n'est plus présenté à personne pour cette requête.
    let me: JellyseerrUser | null = null;
    try {
      me = await jellyseerr.getMe(session.jsCookie);
    } catch {
      me = null;
    }
    if (me?.id) return { cookie: session.jsCookie, userId: me.id };
  }
  return { userId: await ensureJellyseerrUserId(session.jfId, session.jfUser) };
}

/**
 * Se connecter à Jellyseerr au nom de la personne qui ouvre sa session cine-app.
 *
 * La connexion échoue pour un compte Jellyfin que Jellyseerr ne connaît pas encore : sa création
 * à la volée se cogne à l'index unique sur l'adresse, qu'aucun compte Jellyfin n'a ici. On
 * l'importe donc, puis on réessaie une fois — c'est ce qui dispense d'importer chaque nouveau
 * compte à la main *avant* sa première connexion.
 */
export async function loginToJellyseerr(
  username: string,
  password: string,
  jfId: string | undefined,
  jfUser: string | undefined,
): Promise<string | null> {
  const cookie = await jellyseerr.login(username, password).catch(() => null);
  if (cookie) return cookie;
  const userId = await ensureJellyseerrUserId(jfId, jfUser);
  if (userId == null) return null;
  return jellyseerr.login(username, password).catch(() => null);
}
