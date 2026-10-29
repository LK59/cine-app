import { isReaderDeviceType, type ReaderDeviceType } from "@/lib/books/deviceType";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";

/**
 * Ce que le serveur accepte d'une séance de lecture (DECISIONS.md §129) avant d'en écrire la ligne dans
 * `lectures.log` (`logReadingEvent`). Le compte vient de la session, le livre de l'adresse, son titre et
 * son auteur de l'index du serveur ; le corps ne dit que ce que seul le lecteur sait — combien de temps la
 * page a été lue, où elle en était au début et à la fin, combien de pages ont tourné, et si c'était hors
 * ligne. Chaque nombre est borné ; un champ inconnu est ignoré, un champ requis faux refuse la séance.
 */

/** Une séance plus longue n'est pas une séance : une page restée ouverte toute une nuit, page visible. */
export const MAX_SESSION_MS = 12 * 3_600_000;
/** Une séance renvoyée plus tard (lue hors ligne) l'est dans le mois ; au-delà, elle est perdue. */
export const MAX_SESSION_AGE_MS = 30 * 24 * 3_600_000;
/** Sous dix secondes sans page tournée, ce n'est pas une lecture : un livre ouvert pour voir. */
export const MIN_SESSION_MS = 10_000;
const MAX_PAGES = 100_000;

export interface ReadingSessionInput {
  /** Le temps page visible, en ms — le temps caché (autre onglet, téléphone en veille) n'y est pas. */
  durationMs: number;
  /** L'avancement dans le livre au début et à la fin de la séance (0 à 1). */
  fromFraction: number;
  toFraction: number;
  /** Les pages tournées (ou les déplacements du défilement continu). */
  pages: number;
  /** Lu sans réseau : la ligne arrive au retour du réseau. */
  offline: boolean;
  deviceType: ReaderDeviceType | null;
  /** Depuis la fin de la séance, mesuré par l'appareil au moment d'envoyer : 0 pour une séance qui vient de finir. */
  ageMs: number;
  /** Un identifiant tiré par l'appareil : une séance renvoyée deux fois n'est écrite qu'une fois. */
  id: string | null;
  build: string | null;
  version: string | null;
}

const fraction = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 10_000) / 10_000 : null);
const short = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max && /^[\w.+:-]+$/.test(v) ? v : null);

export function validReadingSession(body: unknown): ReadingSessionInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const { durationMs, pages, ageMs } = o;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_SESSION_MS) return null;
  const from = fraction(o.fromFraction);
  const to = fraction(o.toFraction);
  if (from === null || to === null) return null;
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 0 || pages > MAX_PAGES) return null;
  const age = ageMs === undefined ? 0 : ageMs;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0 || age > MAX_SESSION_AGE_MS) return null;
  return {
    durationMs: Math.round(durationMs),
    fromFraction: from,
    toFraction: to,
    pages,
    offline: o.offline === true,
    deviceType: isReaderDeviceType(o.deviceType) ? o.deviceType : null,
    ageMs: Math.round(age),
    id: short(o.id, 40),
    build: short(o.build, 40),
    version: short(o.version, 20),
  };
}

/** Ce qui vaut une ligne : dix secondes de lecture, ou une page tournée. */
export function meaningfulSession(s: Pick<ReadingSessionInput, "durationMs" | "pages">): boolean {
  return s.durationMs >= MIN_SESSION_MS || s.pages > 0;
}

/**
 * Les séances déjà écrites, par leur identifiant : `sendBeacon` peut partir et la file de l'appareil
 * garder la même séance quand la réponse ne revient pas. Bornée, sur `globalThis` comme les autres
 * mémoires partagées entre routes.
 */
const SEEN_KEY = Symbol.for("laterna.books.readingSessionsSeen");
const SEEN_MAX = 2000;
export function alreadyLogged(account: string, id: string | null): boolean {
  if (!id) return false;
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  const seen = (g[SEEN_KEY] ??= new Set<string>());
  const key = `${account}\u0000${id}`;
  if (seen.has(key)) return true;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  return false;
}

/** Le livre tel que le journal le nomme : titre affiché, premier auteur — lus par le serveur. */
export function bookFields(book: Pick<BookSummary, "name" | "seriesName" | "index" | "authors"> | null): { title: string | null; author: string | null } {
  if (!book) return { title: null, author: null };
  return { title: displayTitle(book), author: book.authors[0] ?? null };
}

/**
 * La ligne d'une séance : l'heure de fin et de début dans l'horloge du serveur (la fin moins ce que
 * l'appareil a mesuré depuis, le début moins la durée), et `lateByMs` pour une séance renvoyée plus tard,
 * comme les lignes du lecteur vidéo (§42).
 */
export function sessionLine(input: ReadingSessionInput, now = Date.now()): Record<string, unknown> {
  const endedAt = now - input.ageMs;
  return {
    deviceType: input.deviceType,
    startedAt: new Date(endedAt - input.durationMs).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: input.durationMs,
    fromFraction: input.fromFraction,
    toFraction: input.toFraction,
    pages: input.pages,
    offline: input.offline,
    ...(input.ageMs >= 60_000 ? { resent: true, lateByMs: input.ageMs } : {}),
    ...(input.id ? { sessionId: input.id } : {}),
    build: input.build,
    version: input.version,
  };
}
