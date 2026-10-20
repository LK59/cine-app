import { readRecords } from "@/lib/activity/logReader";
import { buildSeances } from "@/lib/activity/seances";
import { playingSessionsOf, presenceOf } from "@/lib/activity/presence";
import { shareIsActive, sharesDb, type Share } from "@/lib/share/store";

/**
 * Les liens de partage vus de l'Activité (DECISIONS.md §112) : leur état, et ce qu'ils ont consommé
 * — lu dans le journal du lecteur, où les séances d'un lien portent le nom de son compte technique.
 *
 * Le volume est celui que les lecteurs natifs ont mesuré (`diag.netMB` et `diag.reserveNetMB` de
 * leurs bilans) : le lecteur serveur ne compte pas ses octets, ses séances n'y ajoutent rien.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Plus loin, le journal se relirait trop cher pour un panneau relu toutes les vingt secondes. */
const HISTORY_DAYS = 90;

export type ShareState = "active" | "expired" | "revoked";

export interface ShareSummary {
  id: string;
  code: string;
  path: string;
  kind: Share["kind"];
  itemId: string;
  title: string;
  label: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  state: ShareState;
  /** Le compte Jellyfin a été effacé : le lien ne peut plus être prolongé. */
  accountDeleted: boolean;
  maxStreams: number;
  /** Entrées réussies (un appareil, un mot de passe). */
  redeemed: number;
  lastUsedAt: number | null;
  lastIp: string | null;
  lastDevice: string | null;
  /** Lectures en cours, en ce moment. */
  playingNow: number;
  /** Ce qui joue, s'il y a quelque chose. */
  nowPlaying: { itemId: string; title: string } | null;
  usage: {
    seances: number;
    watchedSeconds: number;
    dataMB: number;
    lastSeance: { at: number; title: string; positionSeconds: number | null; device: string | null } | null;
  };
}

export function shareStateOf(share: Share, now = Date.now()): ShareState {
  if (share.revokedAt !== null) return "revoked";
  return shareIsActive(share, now) ? "active" : "expired";
}

export function sharesOverview(now = Date.now()): { now: number; shares: ShareSummary[] } {
  const shares = sharesDb.list();
  if (shares.length === 0) return { now, shares: [] };
  const since = Math.max(Math.min(...shares.map((s) => s.createdAt)), now - HISTORY_DAYS * DAY);
  const records = readRecords("player", since).filter((r) => r._t >= since);
  const names = new Set(shares.map((s) => s.jfUserName?.toLowerCase()).filter(Boolean));
  const mine = records.filter((r) => typeof r.user === "string" && names.has(r.user.toLowerCase()));
  const seances = buildSeances(mine);

  return {
    now,
    shares: shares.map((share): ShareSummary => {
      const name = (share.jfUserName ?? "").toLowerCase();
      const own = seances.filter((s) => s.user.toLowerCase() === name);
      const dataMB = mine
        .filter((r) => r.kind === "stop" && String(r.user).toLowerCase() === name)
        .reduce((n, r) => n + (Number(r["diag.netMB"]) || 0) + (Number(r["diag.reserveNetMB"]) || 0), 0);
      const last = own.reduce<(typeof own)[number] | null>((a, s) => (!a || s.start > a.start ? s : a), null);
      const presence = share.jfUserName ? presenceOf(share.jfUserName, now) : null;
      return {
        id: share.id,
        code: share.code,
        path: `/partage/${share.code}`,
        kind: share.kind,
        itemId: share.itemId,
        title: share.title,
        label: share.label,
        createdBy: share.createdBy,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        revokedAt: share.revokedAt,
        state: shareStateOf(share, now),
        accountDeleted: share.jfDeletedAt !== null,
        maxStreams: share.maxStreams,
        redeemed: share.redeemed,
        lastUsedAt: share.lastUsedAt,
        lastIp: share.lastIp,
        lastDevice: share.lastDevice,
        playingNow: share.jfUserName ? playingSessionsOf(share.jfUserName, now).length : 0,
        nowPlaying: presence?.playing ?? null,
        usage: {
          seances: own.length,
          watchedSeconds: own.reduce((n, s) => n + (s.watched ?? 0), 0),
          dataMB: Math.round(dataMB),
          lastSeance: last ? { at: last.end || last.start, title: last.title, positionSeconds: last.stop?.at ?? null, device: last.device } : null,
        },
      };
    }),
  };
}
