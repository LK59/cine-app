import crypto from "node:crypto";
import { config } from "@/lib/config";
import { upstreamSignal, UPSTREAM_TIMEOUT_MS } from "@/lib/http";
import { jellyfinAuthHeaders, jellyfinIdentityAuth } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { jellyfinDeviceName } from "@/lib/deviceLabel";
import { APP_VERSION } from "@/lib/appBuild";
import type { ShareKind } from "@/lib/share/store";

/**
 * Le compte Jellyfin technique d'un lien de partage (DECISIONS.md §112).
 *
 * Pourquoi un vrai compte : tout ce qui joue dans l'application parle à Jellyfin au nom d'un
 * compte — la négociation du lecteur serveur, la position, les « vu », la langue — et une
 * quinzaine de routes en dépendent. Un compte par lien les garde toutes telles quelles, et c'est
 * Jellyfin lui-même qui garde la reprise du lien.
 *
 * Verrouillé au plus serré que Jellyfin permette, en défense : caché, une seule bibliothèque (celle
 * du genre du titre), sans téléchargement, sans gestion des sous-titres, ni télévision en direct, ni
 * contrôle des autres, ni partage public. La vraie limite au titre partagé est celle de
 * l'application (`share/gate.ts`, `share/scope.ts`) — Jellyfin ne sait pas restreindre un compte à
 * un seul élément sans écrire des tags dans la bibliothèque, ce que ce dépôt ne fait pas.
 *
 * Le nom commence par `partage-` ; la base dit lesquels sont à nous (`sharesDb.jellyfinUserIds`),
 * et ce qui parcourt les comptes Jellyfin les écarte (`share/accounts.ts`).
 */

const ACCOUNT_PREFIX = "partage-";
/** Plus large que les 5 s ordinaires : Jellyfin y dérive un mot de passe (PBKDF2). */
const AUTH_TIMEOUT_MS = 10_000;

function base(): string {
  return config.jellyfin.url;
}
function adminHeaders(json = false): Record<string, string> {
  return { ...jellyfinAuthHeaders(config.jellyfin.apiKey), ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function call(path: string, init: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Response> {
  const res = await jellyfinFetch(`${base()}${path}`, { ...init, signal: upstreamSignal(timeoutMs) });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.replace(/[0-9a-f]{32}/g, "{id}")} : HTTP ${res.status}`);
  return res;
}

type Policy = Record<string, unknown>;

/**
 * La politique d'un compte de lien, posée sur celle que Jellyfin donne à un compte neuf. Le
 * transcodage reste permis comme pour tout compte du foyer : même lecteur, mêmes chemins, même
 * version plus légère sur un réseau faible.
 */
export function sharePolicy(current: Policy, libraryIds: readonly string[]): Policy {
  return {
    ...current,
    IsAdministrator: false,
    IsHidden: true,
    IsDisabled: false,
    EnableAllFolders: false,
    EnabledFolders: [...libraryIds],
    BlockedTags: [],
    EnableContentDownloading: false,
    EnableSubtitleManagement: false,
    EnableLyricManagement: false,
    EnableCollectionManagement: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableLiveTvAccess: false,
    EnableLiveTvManagement: false,
    EnablePublicSharing: false,
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableUserPreferenceAccess: false,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: true,
    EnableVideoPlaybackTranscoding: true,
    EnablePlaybackRemuxing: true,
    EnableRemoteAccess: true,
    SyncPlayAccess: "None",
    // La limite de trois lectures est celle de l'application, qui sait ce qu'est une lecture ;
    // celle de Jellyfin compte des appareils connectés.
    MaxActiveSessions: 0,
  };
}

/** Les bibliothèques du genre du titre — films ou séries. */
async function librariesFor(kind: ShareKind): Promise<string[]> {
  const res = await call("/Library/VirtualFolders", { headers: adminHeaders() });
  const folders = (await res.json()) as { ItemId?: string; CollectionType?: string }[];
  const wanted = kind === "movie" ? "movies" : "tvshows";
  const ids = folders.filter((f) => f.CollectionType === wanted && typeof f.ItemId === "string").map((f) => f.ItemId as string);
  if (ids.length === 0) throw new Error(`aucune bibliothèque « ${wanted} »`);
  return ids;
}

/**
 * Les langues de l'administrateur qui partage, recopiées sur le compte du lien : un invité de la
 * maison a toutes les chances de parler la même langue, et un compte neuf n'en a aucune (le
 * lecteur ouvrirait la piste par défaut du fichier).
 */
async function copyLanguages(fromJfId: string, toJfId: string, toConfiguration: Policy): Promise<void> {
  const res = await call(`/Users/${jellyfinIdSegment(fromJfId)}`, { headers: adminHeaders() });
  const from = ((await res.json()) as { Configuration?: Policy }).Configuration ?? {};
  const next: Policy = { ...toConfiguration };
  for (const key of ["AudioLanguagePreference", "SubtitleLanguagePreference", "SubtitleMode", "PlayDefaultAudioTrack"]) {
    if (from[key] !== undefined) next[key] = from[key];
  }
  await call(`/Users/${jellyfinIdSegment(toJfId)}/Configuration`, { method: "POST", headers: adminHeaders(true), body: JSON.stringify(next) });
}

export interface ShareAccount {
  id: string;
  name: string;
  password: string;
}

/**
 * Crée et verrouille le compte. Un échec après la création efface ce qui a été créé : pas de
 * compte à moitié ouvert qui traînerait chez Jellyfin.
 */
export async function createShareAccount(kind: ShareKind, creatorJfId: string | null): Promise<ShareAccount> {
  const name = `${ACCOUNT_PREFIX}${crypto.randomBytes(4).toString("hex")}`;
  const password = crypto.randomBytes(24).toString("base64url");
  const libraries = await librariesFor(kind);
  const res = await call("/Users/New", { method: "POST", headers: adminHeaders(true), body: JSON.stringify({ Name: name, Password: password }) });
  const user = (await res.json()) as { Id?: string; Policy?: Policy; Configuration?: Policy };
  if (!user.Id) throw new Error("POST /Users/New : pas d'identifiant");
  try {
    await call(`/Users/${jellyfinIdSegment(user.Id)}/Policy`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify(sharePolicy(user.Policy ?? {}, libraries)),
    });
    if (creatorJfId) {
      // Les langues sont un confort : leur échec ne fait pas échouer le lien.
      await copyLanguages(creatorJfId, user.Id, user.Configuration ?? {}).catch(() => undefined);
    }
  } catch (err) {
    await deleteShareAccount(user.Id).catch(() => undefined);
    throw err;
  }
  return { id: user.Id, name, password };
}

/** Une session Jellyfin pour un appareil : un appareil à part, comme chaque connexion du foyer. */
export async function signInShareAccount(
  name: string,
  password: string,
  deviceLabel: string,
  forwarded: Record<string, string> = {}
): Promise<{ userId: string; token: string; deviceId: string }> {
  const deviceId = `cine-app-${crypto.randomUUID()}`;
  const res = await jellyfinFetch(`${base()}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      Authorization: jellyfinIdentityAuth({ client: "CineApp", device: jellyfinDeviceName(deviceLabel), deviceId, version: APP_VERSION }),
    },
    body: JSON.stringify({ Username: name, Pw: password }),
    signal: upstreamSignal(AUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AuthenticateByName (lien) : HTTP ${res.status}`);
  const body = (await res.json()) as { AccessToken?: string; User?: { Id?: string } };
  if (!body.AccessToken || !body.User?.Id) throw new Error("AuthenticateByName (lien) : réponse incomplète");
  return { userId: body.User.Id, token: body.AccessToken, deviceId };
}

/**
 * Désactivé, Jellyfin refuse le compte partout et ferme ses jetons au prochain contrôle
 * (`jellyfinToken.ts`) ; réactivé quand un lien est prolongé.
 */
export async function setShareAccountDisabled(jfId: string, disabled: boolean): Promise<void> {
  const res = await call(`/Users/${jellyfinIdSegment(jfId)}`, { headers: adminHeaders() });
  const policy = ((await res.json()) as { Policy?: Policy }).Policy ?? {};
  await call(`/Users/${jellyfinIdSegment(jfId)}/Policy`, { method: "POST", headers: adminHeaders(true), body: JSON.stringify({ ...policy, IsDisabled: disabled }) });
}

/** Le compte et ses appareils disparaissent de Jellyfin ; un compte déjà absent n'est pas une erreur. */
export async function deleteShareAccount(jfId: string): Promise<void> {
  const res = await jellyfinFetch(`${base()}/Users/${jellyfinIdSegment(jfId)}`, { method: "DELETE", headers: adminHeaders(), signal: upstreamSignal(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE /Users/{id} : HTTP ${res.status}`);
}

/** Le type et le nom d'un élément, lus avec la clé d'administration — pour créer un lien sur un vrai titre. */
export async function describeItem(itemId: string): Promise<{ type: string; name: string } | null> {
  const res = await call(`/Items?ids=${jellyfinIdSegment(itemId)}`, { headers: adminHeaders() });
  const body = (await res.json()) as { Items?: { Type?: string; Name?: string }[] };
  const item = body.Items?.[0];
  return item?.Type ? { type: item.Type, name: item.Name ?? "" } : null;
}
