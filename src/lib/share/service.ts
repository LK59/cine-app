import crypto from "node:crypto";
import { taskLog } from "@/lib/taskLog";
import { createShareSessionToken, decryptSecret, encryptSecret } from "@/lib/auth";
import { knownAccountsDb, sessionDb } from "@/lib/db";
import { logAuthEvent } from "@/lib/eventLogs";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import {
  createShareAccount,
  deleteShareAccount,
  describeItem,
  setShareAccountDisabled,
  signInShareAccount,
} from "@/lib/share/jellyfinAccount";
import {
  SHARE_LABEL_MAX,
  SHARE_MAX_DAYS,
  SHARE_MAX_STREAMS,
  hashSharePassword,
  newShareCode,
  newSharePassword,
  shareIsActive,
  sharesDb,
  verifySharePassword,
  type Share,
  type ShareKind,
} from "@/lib/share/store";

/**
 * La vie d'un lien de partage (DECISIONS.md §112) : création, entrée, prolongation, révocation,
 * expiration. Les routes d'administration et d'entrée n'appellent que ceci.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Un compte Jellyfin de lien survit un mois à la fin du lien : on peut encore le prolonger, reprise comprise. */
const DELETE_AFTER_MS = 30 * DAY;

export interface CreatedShare {
  share: Share;
  /** Montré une fois, à l'administrateur, jamais gardé en clair. */
  password: string;
}

export interface CreateShareInput {
  kind: ShareKind;
  itemId: string;
  radarrId: number | null;
  sonarrId: number | null;
  label: string;
  days: number;
  createdBy: string;
  creatorJfId: string | null;
}

export class ShareError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

function cleanLabel(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, SHARE_LABEL_MAX);
}

export async function createShare(input: CreateShareInput, now = Date.now()): Promise<CreatedShare> {
  if (input.kind !== "movie" && input.kind !== "series") throw new ShareError("kind", "Type inconnu");
  if (!isJellyfinId(input.itemId)) throw new ShareError("item", "Titre inconnu");
  const label = cleanLabel(input.label);
  if (!label) throw new ShareError("label", "Un nom est requis");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > SHARE_MAX_DAYS) throw new ShareError("days", "Durée invalide");
  const item = await describeItem(input.itemId);
  const expected = input.kind === "movie" ? "Movie" : "Series";
  if (!item || item.type !== expected) throw new ShareError("item", "Titre introuvable chez Jellyfin", 404);

  const account = await createShareAccount(input.kind, input.creatorJfId);
  // Connu tout de suite : le blocage des tags des nouveaux comptes (toutes les cinq minutes) ne doit
  // jamais le prendre pour un compte du foyer, même entre sa création et la ligne en base.
  try {
    knownAccountsDb.addAll([account.id]);
  } catch {
    /* le nom suffit à l'écarter */
  }
  const password = newSharePassword();
  const share: Share = {
    id: crypto.randomBytes(8).toString("hex"),
    code: newShareCode(),
    kind: input.kind,
    itemId: input.itemId,
    radarrId: input.kind === "movie" && Number.isInteger(input.radarrId) ? input.radarrId : null,
    sonarrId: input.kind === "series" && Number.isInteger(input.sonarrId) ? input.sonarrId : null,
    title: item.name,
    label,
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: now + input.days * DAY,
    revokedAt: null,
    maxStreams: SHARE_MAX_STREAMS,
    jfUserId: account.id,
    jfUserName: account.name,
    jfDisabledAt: null,
    jfDeletedAt: null,
    redeemed: 0,
    lastUsedAt: null,
    lastIp: null,
    lastDevice: null,
  };
  try {
    sharesDb.insert(share, hashSharePassword(password), await encryptSecret(account.password));
  } catch (err) {
    await deleteShareAccount(account.id).catch(() => undefined);
    throw err;
  }
  logAuthEvent("share-created", { user: input.createdBy, share: share.id, label, title: share.title, days: input.days });
  return { share, password };
}

export interface RedeemResult {
  token: string;
  share: Share;
}

/**
 * L'entrée : le code et le mot de passe contre une session de partage. Une seule réponse pour tout
 * refus — code inconnu, mot de passe faux, lien fini — : qui essaie n'apprend pas lequel.
 */
export async function redeemShare(
  code: string,
  password: string,
  context: { ip: string | null; device: string | null; forwarded?: Record<string, string> },
  now = Date.now()
): Promise<RedeemResult | null> {
  const found = sharesDb.byCode(code);
  const ok = !!found && verifySharePassword(password, found.passwordHash);
  if (!found || !ok || !shareIsActive(found.share, now)) {
    logAuthEvent("share-refused", { user: found?.share.jfUserName ?? "?", share: found?.share.id ?? null, ip: context.ip, device: context.device, reason: !found ? "code inconnu" : !ok ? "mot de passe refusé" : "lien terminé" });
    return null;
  }
  const { share } = found;
  const jfPassword = await decryptSecret(found.jfPassword);
  if (!jfPassword || !share.jfUserName || !share.jfUserId) throw new ShareError("account", "Compte du lien illisible", 500);
  const signedIn = await signInShareAccount(share.jfUserName, jfPassword, context.device ?? "Partage", context.forwarded);
  const { token, jti } = await createShareSessionToken(share.id, share.jfUserName, signedIn.userId, signedIn.token, share.expiresAt);
  sessionDb.create(jti, signedIn.userId, context.device, signedIn.deviceId);
  sharesDb.noteRedeemed(share.id, context.ip, context.device, now);
  logAuthEvent("share-redeemed", { user: share.jfUserName, share: share.id, label: share.label, ip: context.ip, device: context.device });
  return { token, share };
}

/** Ferme les sessions du lien et ses appareils chez Jellyfin. */
function closeSessions(share: Share): void {
  if (!share.jfUserId) return;
  const closed = sessionDb.deleteForUser(share.jfUserId);
  void revokeJellyfinDevices(
    closed.map((c) => c.jfDevice),
    "lien de partage fermé"
  );
}

export async function revokeShare(id: string, by: string, now = Date.now()): Promise<Share | null> {
  const share = sharesDb.get(id);
  if (!share) return null;
  sharesDb.revoke(id, now);
  closeSessions(share);
  if (share.jfUserId && share.jfDeletedAt === null && share.jfDisabledAt === null) {
    await setShareAccountDisabled(share.jfUserId, true)
      .then(() => sharesDb.setDisabled(id, now))
      .catch((err) => logError("share.disable", err, { share: id }));
  }
  logAuthEvent("share-revoked", { user: by, share: id, label: share.label });
  return sharesDb.get(id);
}

/** Prolonge de `days` jours à partir de maintenant, ou de la fin si elle est à venir. Rouvre un lien fini. */
export async function extendShare(id: string, days: number, by: string, now = Date.now()): Promise<Share> {
  const share = sharesDb.get(id);
  if (!share) throw new ShareError("missing", "Lien inconnu", 404);
  if (!Number.isInteger(days) || days < 1 || days > SHARE_MAX_DAYS) throw new ShareError("days", "Durée invalide");
  if (share.revokedAt !== null) throw new ShareError("revoked", "Ce lien a été révoqué", 409);
  if (share.jfDeletedAt !== null || !share.jfUserId) throw new ShareError("deleted", "Ce lien est terminé depuis trop longtemps", 409);
  const expiresAt = Math.max(now, share.expiresAt) + days * DAY;
  if (share.jfDisabledAt !== null) {
    await setShareAccountDisabled(share.jfUserId, false);
    sharesDb.setDisabled(id, null);
  }
  sharesDb.setExpiry(id, expiresAt);
  logAuthEvent("share-extended", { user: by, share: id, label: share.label, days });
  return sharesDb.get(id) as Share;
}

/** Efface le lien, son compte Jellyfin et ses sessions. */
export async function deleteShare(id: string, by: string): Promise<boolean> {
  const share = sharesDb.get(id);
  if (!share) return false;
  closeSessions(share);
  if (share.jfUserId && share.jfDeletedAt === null) await deleteShareAccount(share.jfUserId);
  sharesDb.remove(id);
  logAuthEvent("share-deleted", { user: by, share: id, label: share.label });
  return true;
}

/**
 * Le passage régulier : un lien fini a son compte Jellyfin désactivé et ses sessions fermées ; un
 * mois plus tard, le compte est effacé. Chaque lien dans sa garde : un échec est réessayé au passage
 * suivant, sans bloquer les autres.
 */
export async function sweepShares(now = Date.now()): Promise<void> {
  for (const share of sharesDb.list()) {
    if (!share.jfUserId || share.jfDeletedAt !== null) continue;
    const endedAt = share.revokedAt ?? (share.expiresAt <= now ? share.expiresAt : null);
    if (endedAt === null) continue;
    try {
      if (share.jfDisabledAt === null) {
        closeSessions(share);
        await setShareAccountDisabled(share.jfUserId, true);
        sharesDb.setDisabled(share.id, now);
        taskLog("partages", share.revokedAt === null ? "lien expiré, compte désactivé" : "lien révoqué, compte désactivé", { lien: share.label });
        if (share.revokedAt === null) logAuthEvent("share-expired", { user: share.jfUserName ?? "?", share: share.id, label: share.label });
      } else if (now - endedAt > DELETE_AFTER_MS) {
        await deleteShareAccount(share.jfUserId);
        sharesDb.setDeleted(share.id, now);
        taskLog("partages", "compte d'un lien fini effacé", { lien: share.label });
      }
    } catch (err) {
      logError("share.sweep", err, { share: share.id });
    }
  }
}

/**
 * Chaque minute : une liste lue par clé, rien chez Jellyfin tant qu'aucun lien ne finit. Toutes les
 * dix minutes laissaient une adresse de diffusion d'un lien expiré servir encore jusqu'à dix minutes
 * (revue de sécurité du 20/10/2026) — elle ne vérifie que l'existence de la session.
 */
const SWEEP_EVERY_MS = 60_000;

export function startShareSweep(): void {
  const run = () => void sweepShares().catch((err) => logError("share.sweep", err));
  const startup = setTimeout(run, 60_000);
  startup.unref?.();
  const interval = setInterval(run, SWEEP_EVERY_MS);
  interval.unref?.();
}
