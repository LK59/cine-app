import { getDb } from "@/lib/db";
import { config } from "@/lib/config";
import { createT, loadLocaleDict, LOCALES, type Locale } from "@/lib/i18n";
import { sendPushToAdmins, sendPushToUser } from "@/lib/push";
import { logError } from "@/lib/logger";

/**
 * Les demandes de livres (option, DECISIONS.md §127) : un ticket, traité à la main par
 * l'administrateur, qui ajoute le livre lui-même — aucune base de livres consultée, aucun service de
 * demandes branché (Jellyseerr ne connaît pas les livres, et ne doit rien en savoir).
 *
 * Les notifications passent par le chemin des signalements : `report-new` pour l'administrateur,
 * `report-reply` pour qui a demandé — les mêmes cases à cocher dans Compte, sans en ajouter qui
 * existeraient aussi sur une installation sans livres.
 */

export type BookRequestStatus = "pending" | "added" | "refused";

export interface BookRequest {
  id: number;
  account: string;
  title: string;
  author: string;
  note: string;
  status: BookRequestStatus;
  reply: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  account: string;
  user_id: string;
  title: string;
  author: string;
  note: string;
  status: BookRequestStatus;
  reply: string;
  created_at: number;
  updated_at: number;
}

export const REQUEST_LIMITS = { title: 200, author: 200, note: 1000, reply: 500, perDay: 20 } as const;

const toRequest = (r: Row): BookRequest => ({
  id: r.id,
  account: r.account,
  title: r.title,
  author: r.author,
  note: r.note,
  status: r.status,
  reply: r.reply,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Une ligne de texte saisi : blancs repliés, caractères de contrôle retirés, bornée. */
function cleanLine(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim();
  return clean.length > max ? null : clean;
}

/** Ce que le formulaire envoie, validé ; `null` : refusé (titre manquant, texte trop long, type faux). */
export function validRequestInput(body: unknown): { title: string; author: string; note: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const title = cleanLine(b.title, REQUEST_LIMITS.title);
  const author = cleanLine(b.author, REQUEST_LIMITS.author);
  const note = cleanLine(b.note, REQUEST_LIMITS.note);
  if (title === null || author === null || note === null || title === "") return null;
  return { title, author, note };
}

export function requestsOf(account: string): BookRequest[] {
  const rows = getDb().prepare("SELECT * FROM book_requests WHERE account = ? ORDER BY created_at DESC LIMIT 200").all(account) as Row[];
  return rows.map(toRequest);
}

/** Toutes les demandes, pour l'administrateur : celles en attente d'abord, puis les plus récentes. */
export function allRequests(): BookRequest[] {
  const rows = getDb()
    .prepare("SELECT * FROM book_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 500")
    .all() as Row[];
  return rows.map(toRequest);
}

export function requestsToday(account: string, now = Date.now()): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM book_requests WHERE account = ? AND created_at > ?").get(account, now - 24 * 3600_000) as { n: number };
  return row.n;
}

export function createRequest(account: string, userId: string, input: { title: string; author: string; note: string }, now = Date.now()): BookRequest {
  const info = getDb()
    .prepare(
      `INSERT INTO book_requests (account, user_id, title, author, note, status, reply, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?)`
    )
    .run(account, userId, input.title, input.author, input.note, now, now);
  return toRequest(getDb().prepare("SELECT * FROM book_requests WHERE id = ?").get(info.lastInsertRowid) as Row);
}

/** L'administrateur tranche : ajouté ou refusé, avec un mot. Rend la demande à jour, ou `null` si elle n'existe pas. */
export function answerRequest(id: number, status: BookRequestStatus, reply: string, now = Date.now()): (BookRequest & { userId: string }) | null {
  const db = getDb();
  const changed = db.prepare("UPDATE book_requests SET status = ?, reply = ?, updated_at = ? WHERE id = ?").run(status, reply, now, id);
  if (changed.changes === 0) return null;
  const row = db.prepare("SELECT * FROM book_requests WHERE id = ?").get(id) as Row;
  return { ...toRequest(row), userId: row.user_id };
}

async function translator(locale: string) {
  const lang = (LOCALES as string[]).includes(locale) ? (locale as Locale) : "fr";
  const [dict, fallback] = await Promise.all([loadLocaleDict(lang), loadLocaleDict("fr")]);
  return createT(dict, fallback, lang);
}

/** Les notifications en cours : les routes ne les attendent pas, les tests si. */
const inFlight = new Set<Promise<void>>();
function track(p: Promise<void>): Promise<void> {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/** Prévenir les administrateurs qu'une demande arrive. Ne lève jamais. */
export function notifyNewRequest(request: BookRequest): Promise<void> {
  return track(
    (async () => {
      try {
        const t = await translator(config.app.language);
        await sendPushToAdmins({
          title: t("books.requests.push.adminTitle", { user: request.account }),
          body: request.author ? `${request.title} — ${request.author}` : request.title,
          tag: `book-request-${request.id}`,
          url: "/livres?demandes=1",
          category: "report-new",
        });
      } catch (error) {
        logError("books/requests", error, { where: "notification aux administrateurs", requestId: request.id });
      }
    })()
  );
}

/** Prévenir qui a demandé : ajouté ou refusé, dans la langue de chacun de ses appareils. Ne lève jamais. */
export function notifyRequester(request: BookRequest): Promise<void> {
  return track(
    (async () => {
      try {
        const dicts = new Map<Locale, Awaited<ReturnType<typeof translator>>>();
        for (const lang of LOCALES) dicts.set(lang, await translator(lang));
        await sendPushToUser(request.account, (lang) => {
          const t = dicts.get(lang) ?? dicts.get("fr")!;
          return {
            title: t(request.status === "added" ? "books.requests.push.addedTitle" : "books.requests.push.refusedTitle"),
            body: request.reply ? `${request.title} — ${request.reply}` : request.title,
            tag: `book-request-${request.id}`,
            url: "/livres?demandes=1",
            category: "report-reply",
          };
        });
      } catch (error) {
        logError("books/requests", error, { where: "notification du demandeur", requestId: request.id });
      }
    })()
  );
}

export const __testing = { drain: () => Promise.all([...inFlight]) };
