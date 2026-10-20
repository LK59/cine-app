import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { hashAdminPassword, verifyAdminPassword } from "../../../server-boot/adminAccount.mjs";

/**
 * Les liens de partage, tels que la base les garde (DECISIONS.md §112).
 *
 * Un lien ouvre un seul titre — un film, ou une série entière, épisodes à venir compris — à qui
 * connaît son code (dans l'adresse) et son mot de passe (donné à part), jusqu'à sa fin. Derrière
 * lui, un compte Jellyfin technique et caché (`jellyfinAccount.ts`) : c'est lui qui garde la
 * reprise et les « vu » du lien, et qui fait que les deux lecteurs marchent exactement comme pour
 * un compte du foyer.
 *
 * Le mot de passe du lien n'est gardé que haché (scrypt, le module du compte administrateur) ;
 * celui du compte Jellyfin, aléatoire et jamais montré, est chiffré (`encryptSecret`) : il faut le
 * relire pour ouvrir une session Jellyfin à chaque nouvel appareil.
 */

export type ShareKind = "movie" | "series";

export interface Share {
  id: string;
  code: string;
  kind: ShareKind;
  /** Le film, ou la série, chez Jellyfin. */
  itemId: string;
  radarrId: number | null;
  sonarrId: number | null;
  title: string;
  /** Le nom donné par l'administrateur — « Paul ». */
  label: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  maxStreams: number;
  jfUserId: string | null;
  jfUserName: string | null;
  jfDisabledAt: number | null;
  jfDeletedAt: number | null;
  redeemed: number;
  lastUsedAt: number | null;
  lastIp: string | null;
  lastDevice: string | null;
}

interface Row {
  id: string;
  code: string;
  password_hash: string;
  kind: string;
  item_id: string;
  radarr_id: number | null;
  sonarr_id: number | null;
  title: string;
  label: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  max_streams: number;
  jf_user_id: string | null;
  jf_user_name: string | null;
  jf_password: string | null;
  jf_disabled_at: number | null;
  jf_deleted_at: number | null;
  redeemed: number;
  last_used_at: number | null;
  last_ip: string | null;
  last_device: string | null;
}

function fromRow(r: Row): Share {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind === "series" ? "series" : "movie",
    itemId: r.item_id,
    radarrId: r.radarr_id,
    sonarrId: r.sonarr_id,
    title: r.title,
    label: r.label,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    maxStreams: r.max_streams,
    jfUserId: r.jf_user_id,
    jfUserName: r.jf_user_name,
    jfDisabledAt: r.jf_disabled_at,
    jfDeletedAt: r.jf_deleted_at,
    redeemed: r.redeemed,
    lastUsedAt: r.last_used_at,
    lastIp: r.last_ip,
    lastDevice: r.last_device,
  };
}

/** Trois lectures en même temps par lien (décision de Louis, 20/10/2026). */
export const SHARE_MAX_STREAMS = 3;
/** Les durées proposées à la création, en jours. */
export const SHARE_DURATIONS_DAYS = [1, 3, 7, 14, 30] as const;
export const SHARE_MAX_DAYS = 90;
export const SHARE_LABEL_MAX = 40;

/**
 * L'alphabet des codes et des mots de passe : sans 0/o, 1/l/i — ils se dictent et se recopient.
 * 31 signes : le code (10) en porte ~50 bits, le mot de passe (12) ~59, derrière un freinage par
 * adresse et par lien (`redeem`).
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomWord(length: number): string {
  const bytes = crypto.randomBytes(length * 2);
  let out = "";
  // Rejet des valeurs hors du dernier multiple de 31 : pas de biais vers les premiers signes.
  for (let i = 0; i < bytes.length && out.length < length; i += 2) {
    const v = bytes.readUInt16BE(i);
    if (v >= 65_536 - (65_536 % ALPHABET.length)) continue;
    out += ALPHABET[v % ALPHABET.length];
  }
  return out.length === length ? out : randomWord(length);
}

export function newShareCode(): string {
  return randomWord(10);
}

/** « k7fm-2qxp-9tre » : trois groupes, à lire au téléphone. Les tirets ne comptent pas. */
export function newSharePassword(): string {
  const w = randomWord(12);
  return `${w.slice(0, 4)}-${w.slice(4, 8)}-${w.slice(8)}`;
}

/** Ce qu'on compare : sans tirets ni espaces, en minuscules — comme il a été tapé ou collé. */
export function normalizeSharePassword(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]/g, "");
}

const CODE = /^[a-z2-9]{10}$/;
export function isShareCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}

export function hashSharePassword(password: string): string {
  return hashAdminPassword(normalizeSharePassword(password));
}

export function verifySharePassword(password: string, stored: string): boolean {
  return verifyAdminPassword(normalizeSharePassword(password), stored);
}

/** Le lien vit-il encore : ni révoqué, ni passé, et son compte Jellyfin existe. */
export function shareIsActive(share: Share | null, now = Date.now()): share is Share {
  return !!share && share.revokedAt === null && share.expiresAt > now && !!share.jfUserId && share.jfDeletedAt === null;
}

export const sharesDb = {
  insert(s: Omit<Share, "revokedAt" | "jfDisabledAt" | "jfDeletedAt" | "redeemed" | "lastUsedAt" | "lastIp" | "lastDevice">, passwordHash: string, jfPassword: string): void {
    getDb()
      .prepare(
        `INSERT INTO shares (id, code, password_hash, kind, item_id, radarr_id, sonarr_id, title, label, created_by, created_at,
           expires_at, max_streams, jf_user_id, jf_user_name, jf_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.id, s.code, passwordHash, s.kind, s.itemId, s.radarrId, s.sonarrId, s.title, s.label, s.createdBy, s.createdAt, s.expiresAt, s.maxStreams, s.jfUserId, s.jfUserName, jfPassword);
  },
  get(id: string): Share | null {
    const row = getDb().prepare("SELECT * FROM shares WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  },
  /** Le lien et ce qu'il faut pour l'ouvrir — réservé à la route d'entrée. */
  byCode(code: string): { share: Share; passwordHash: string; jfPassword: string | null } | null {
    const row = getDb().prepare("SELECT * FROM shares WHERE code = ?").get(code) as Row | undefined;
    return row ? { share: fromRow(row), passwordHash: row.password_hash, jfPassword: row.jf_password } : null;
  },
  list(): Share[] {
    return (getDb().prepare("SELECT * FROM shares ORDER BY created_at DESC").all() as Row[]).map(fromRow);
  },
  /** Les comptes Jellyfin des liens, vivants ou non tant qu'ils existent chez Jellyfin. */
  jellyfinUserIds(): Set<string> {
    const rows = getDb().prepare("SELECT jf_user_id FROM shares WHERE jf_user_id IS NOT NULL").all() as { jf_user_id: string }[];
    return new Set(rows.map((r) => r.jf_user_id));
  },
  noteRedeemed(id: string, ip: string | null, device: string | null, now = Date.now()): void {
    getDb().prepare("UPDATE shares SET redeemed = redeemed + 1, last_used_at = ?, last_ip = ?, last_device = ? WHERE id = ?").run(now, ip, device, id);
  },
  revoke(id: string, now = Date.now()): void {
    getDb().prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, id);
  },
  setExpiry(id: string, expiresAt: number): void {
    getDb().prepare("UPDATE shares SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  },
  setDisabled(id: string, at: number | null): void {
    getDb().prepare("UPDATE shares SET jf_disabled_at = ? WHERE id = ?").run(at, id);
  },
  setDeleted(id: string, at: number): void {
    getDb().prepare("UPDATE shares SET jf_deleted_at = ?, jf_password = NULL WHERE id = ?").run(at, id);
  },
  remove(id: string): void {
    getDb().prepare("DELETE FROM shares WHERE id = ?").run(id);
  },
};
