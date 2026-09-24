// Les signalements : qui voit quoi, ce qu'on peut en faire, et qui en est prévenu.
//
// Une personne voit les siens, brouillons compris ; l'administrateur voit tous ceux qui sont
// partis — jamais un brouillon, qui n'appartient qu'à son auteur tant qu'il ne l'envoie pas. Les
// routes sont minces : tout ce qui décide est ici.

import type { SessionPayload } from "@/lib/auth";
import { reportsDb, userPrefsDb, type ReportFields, type ReportImage, type ReportMessage, type ReportRow, type ReportStatus } from "@/lib/db";
import { checkReportPath, isSuggestion, reportPathParts, zoneOf } from "@/lib/reportTaxonomy";
import { createT, loadLocaleDict, LOCALES, type Locale } from "@/lib/i18n";
import { sendPushToAdmins, sendPushToUser } from "@/lib/push";
import { config } from "@/lib/config";
import { logError } from "@/lib/logger";

export interface Who {
  userId: string;
  userName: string;
  admin: boolean;
}

export function whoIs(session: SessionPayload): Who {
  return { userId: session.jfId ?? session.u, userName: session.jfUser ?? session.u, admin: session.role === "admin" };
}

export function isOwner(report: ReportRow, who: Who): boolean {
  return report.userId === who.userId;
}

/**
 * Marquer lu pour qui regarde — de chacun des côtés qu'il occupe. L'administrateur qui ouvre son
 * propre signalement en est à la fois l'auteur et le destinataire : ne marquer que le côté auteur
 * laissait sa pastille d'administrateur allumée pour toujours, sur un ticket qu'il venait de lire
 * (24/09/2026). Appelé aussi après chacun de ses gestes : on ne se notifie pas soi-même.
 */
export function markSeenBy(report: ReportRow, who: Who): void {
  if (report.status === "draft") return;
  if (isOwner(report, who)) reportsDb.markSeen(report.id, "user");
  if (who.admin) reportsDb.markSeen(report.id, "admin");
}

/** Le sien, ou — pour l'administrateur — n'importe quel signalement parti. */
export function canSee(report: ReportRow, who: Who): boolean {
  return isOwner(report, who) || (who.admin && report.status !== "draft");
}

const MAX_DESCRIPTION = 5000;
const MAX_MESSAGE = 5000;

/** Les champs d'un signalement, lus et bornés. `draft` tolère un chemin incomplet ; l'envoi, non. */
export function readFields(raw: unknown, draft: boolean): ReportFields | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const opt = (v: unknown, max: number) => text(v, max) || null;
  const fields: ReportFields = {
    zone: text(r.zone, 40),
    element: opt(r.element, 40),
    elementOther: opt(r.elementOther, 200),
    issue: opt(r.issue, 40),
    issueOther: opt(r.issueOther, 200),
    itemId: opt(r.itemId, 64),
    itemTitle: opt(r.itemTitle, 200),
    itemKind: r.itemKind === "movie" || r.itemKind === "series" ? r.itemKind : null,
    description: text(r.description, MAX_DESCRIPTION),
  };
  if (!zoneOf(fields.zone)) return "zone inconnue";
  if (draft) return fields;
  const problem = checkReportPath(fields);
  if (problem) return problem;
  if (zoneOf(fields.zone)?.title && !fields.itemTitle) return "titre manquant";
  if (!fields.description) return "description manquante";
  return fields;
}

/** Le contexte envoyé par le navigateur : ce qui aide à comprendre, borné, jamais cru pour l'identité. */
export function readContext(raw: unknown, userAgent: string | null): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    agent: userAgent?.slice(0, 400) ?? null,
    lang: s(r.lang, 8),
    url: s(r.url, 300),
    screen: s(r.screen, 40),
    standalone: r.standalone === true,
    build: s(r.build, 60),
    online: r.online === false ? false : true,
    width: n(r.width),
    height: n(r.height),
  };
}

// ─── Changements d'état ──────────────────────────────────────────────────────────

const ADMIN_STATUSES: ReportStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * Ce qui est permis : l'administrateur passe un signalement envoyé dans n'importe quel état ; son
 * auteur peut le fermer, et le rouvrir s'il est résolu ou fermé — le souci est revenu.
 */
export function canSetStatus(report: ReportRow, who: Who, next: ReportStatus): boolean {
  if (report.status === "draft" || next === "draft" || report.status === next) return false;
  if (who.admin && ADMIN_STATUSES.includes(next)) return true;
  if (!isOwner(report, who)) return false;
  if (next === "closed") return true;
  return next === "open" && (report.status === "resolved" || report.status === "closed");
}

// ─── Ce qu'on renvoie ────────────────────────────────────────────────────────────

export interface ReportSummary {
  id: number;
  status: ReportStatus;
  suggestion: boolean;
  zone: string;
  element: string | null;
  elementOther: string | null;
  issue: string | null;
  issueOther: string | null;
  itemTitle: string | null;
  excerpt: string;
  userName: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  /** Du nouveau pour celui qui demande : une réponse de l'administrateur, ou l'inverse. */
  unread: boolean;
}

/**
 * `side` dit de quel côté on regarde : l'auteur (des réponses non lues) ou l'administrateur (des
 * signalements et commentaires non lus). Par défaut, l'auteur pour le sien, l'administrateur sinon —
 * sa propre liste d'administration passe « admin », y compris pour ses propres signalements.
 */
export function summarize(report: ReportRow, who: Who, side?: "user" | "admin"): ReportSummary {
  const forAdmin = side ? side === "admin" : who.admin && !isOwner(report, who);
  return {
    id: report.id,
    status: report.status,
    suggestion: isSuggestion(report),
    zone: report.zone,
    element: report.element,
    elementOther: report.elementOther,
    issue: report.issue,
    issueOther: report.issueOther,
    itemTitle: report.itemTitle,
    excerpt: report.description.slice(0, 160),
    userName: report.userName,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    sentAt: report.sentAt,
    unread: report.status !== "draft" && (forAdmin ? report.lastUserAt > report.adminSeenAt : report.lastAdminAt > report.userSeenAt),
  };
}

export interface ImageView {
  id: number;
  messageId: number | null;
  url: string | null;
  originalUrl: string;
  name: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

function imageView(reportId: number, image: ReportImage): ImageView {
  return {
    id: image.id,
    messageId: image.messageId,
    url: image.file ? `/api/reports/${reportId}/images/${image.id}` : null,
    originalUrl: `/api/reports/${reportId}/images/${image.id}?original=1`,
    name: image.originalName,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
  };
}

export function detail(report: ReportRow, who: Who) {
  const images = reportsDb.images(report.id).map((image) => imageView(report.id, image));
  return {
    ...summarize(report, who),
    description: report.description,
    itemId: report.itemId,
    itemKind: report.itemKind,
    mine: isOwner(report, who),
    messages: reportsDb.messages(report.id) as ReportMessage[],
    images,
    // Le contexte et les journaux sont pour l'administrateur : ils nomment des appareils, des
    // adresses et des séances que la personne n'a pas besoin de relire.
    ...(who.admin ? { context: report.context, logs: report.logs, userId: report.userId } : {}),
  };
}

// ─── Qui est prévenu ─────────────────────────────────────────────────────────────

async function translator(locale: string) {
  const lang = (LOCALES as string[]).includes(locale) ? (locale as Locale) : "fr";
  const [dict, fallback] = await Promise.all([loadLocaleDict(lang), loadLocaleDict("fr")]);
  return createT(dict, fallback, lang);
}

/** Le chemin en mots, dans la langue de qui reçoit la notification. */
export async function pathLabel(report: ReportRow, locale: string): Promise<string> {
  return reportPathParts(report, await translator(locale)).join(" › ");
}

/**
 * Les notifications en cours. Les routes ne les attendent pas — une réponse ne doit pas dépendre
 * d'un serveur de notifications lent —, mais les tests, eux, doivent pouvoir attendre qu'elles
 * soient parties.
 */
const inFlight = new Set<Promise<void>>();
function track(p: Promise<void>): Promise<void> {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/** Prévenir l'administrateur : un signalement arrive, ou son auteur y ajoute quelque chose. Ne lève jamais. */
export function notifyAdmin(report: ReportRow, what: "new" | "comment" | "status"): Promise<void> {
  return track(sendToAdmin(report, what));
}

async function sendToAdmin(report: ReportRow, what: "new" | "comment" | "status"): Promise<void> {
  try {
    const t = await translator(config.app.language);
    const label = await pathLabel(report, config.app.language);
    await sendPushToAdmins({
      title: t(`report.push.admin.${what}`, { user: report.userName }),
      body: label,
      tag: `report-${report.id}`,
      url: `/#activite=signalement%3A${report.id}`,
      category: "report-new",
    });
  } catch (error) {
    logError("reports", error, { where: "notification à l'administrateur", reportId: report.id });
  }
}

/** Prévenir l'auteur : l'administrateur a répondu, ou a changé l'état. Ne lève jamais. */
export function notifyAuthor(report: ReportRow, what: "reply" | "status"): Promise<void> {
  return track(sendToAuthor(report, what));
}

async function sendToAuthor(report: ReportRow, what: "reply" | "status"): Promise<void> {
  try {
    const locale = userPrefsDb.getLang(report.userId, config.app.language);
    const t = await translator(locale);
    await sendPushToUser(report.userName, {
      title: t(`report.push.user.${what}`),
      body: what === "status" ? t(`report.status.${report.status}`) : await pathLabel(report, locale),
      tag: `report-${report.id}`,
      url: `/#signalement=${report.id}`,
      category: "report-reply",
    });
  } catch (error) {
    logError("reports", error, { where: "notification à l'auteur", reportId: report.id });
  }
}

export const LIMITS = { MAX_DESCRIPTION, MAX_MESSAGE };

/** Ce que l'écran reçoit pour un signalement. */
export type ReportDetail = ReturnType<typeof detail>;

export const __testing = { drain: () => Promise.all([...inFlight]) };
