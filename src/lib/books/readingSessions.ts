"use client";

import { useCallback, useEffect, useRef } from "react";
import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { currentReaderDeviceType } from "@/lib/books/deviceType";

/**
 * Les séances de lecture, vues du lecteur (DECISIONS.md §129) — ce qui devient une ligne de `lectures.log`.
 *
 * Une séance est un temps **page visible** : elle commence quand le livre est prêt (ou que la page
 * redevient visible) et finit quand le lecteur se referme ou que la page passe en arrière-plan — un
 * téléphone mis en veille, un autre onglet. Le temps caché n'y est jamais : une page oubliée ouverte toute
 * la nuit ne compte pas pour huit heures de lecture. Elle part par `sendBeacon`, qui part même d'une page
 * qu'iOS est en train de tuer ; sans réseau (ou `sendBeacon` refusé), elle attend dans une file de
 * l'appareil (`laterna:books:sessions`, bornée) et repart à la prochaine ouverture d'un livre ou au retour
 * du réseau, avec son âge — le serveur la place à l'heure où elle a eu lieu (`lateByMs`).
 *
 * Moins de dix secondes sans page tournée : rien n'est envoyé (le serveur l'ignorerait aussi).
 */

const QUEUE_KEY = "laterna:books:sessions";
const MAX_QUEUE = 50;
const MIN_SESSION_MS = 10_000;

interface SessionBody {
  durationMs: number;
  fromFraction: number;
  toFraction: number;
  pages: number;
  offline: boolean;
  deviceType: string;
  id: string;
  build: string;
  version: string;
}
interface Queued {
  book: string;
  body: SessionBody;
  /** La fin de la séance, dans l'horloge de l'appareil : l'âge est mesuré au moment d'envoyer. */
  endedAt: number;
}

function readQueue(): Queued[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(list) ? (list as Queued[]) : [];
  } catch {
    return [];
  }
}
function writeQueue(list: Queued[]): void {
  try {
    if (list.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-MAX_QUEUE)));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* stockage refusé : la séance est perdue, la lecture ne l'est pas */
  }
}

const url = (book: string) => `/api/books/${book}/session`;
const wire = (q: Queued) => JSON.stringify({ ...q.body, ageMs: Math.max(0, Date.now() - q.endedAt) });

function send(q: Queued): void {
  if (typeof navigator === "undefined" || navigator.onLine === false || typeof navigator.sendBeacon !== "function") {
    writeQueue([...readQueue(), q]);
    return;
  }
  if (!navigator.sendBeacon(url(q.book), new Blob([wire(q)], { type: "application/json" }))) writeQueue([...readQueue(), q]);
}

let flushing: Promise<void> | null = null;
/** Renvoie les séances qui attendent ; s'arrête à la première panne (la suite attendra encore). */
export function flushReadingSessions(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (const q of readQueue()) {
        try {
          const res = await fetch(url(q.book), { method: "POST", body: wire(q), headers: { "Content-Type": "application/json" }, keepalive: true });
          // Une panne ou une session expirée : à retenter. Un refus, une limite atteinte : laissée.
          if (res.status >= 500 || res.status === 401) return;
        } catch {
          return;
        }
        writeQueue(readQueue().filter((o) => o.body.id !== q.body.id));
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

const newId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

interface Running {
  id: string;
  visibleSince: number;
  from: number;
  to: number;
  pages: number;
}

/**
 * `ready` : le livre est affiché. Rend `notePage`, à appeler à chaque changement de position (le
 * `relocate` de foliate-js, l'ouverture comprise) — stable, il peut vivre dans un effet.
 */
export function useReadingSession(book: string, ready: boolean, offline: boolean): (fraction: number) => void {
  const running = useRef<Running | null>(null);
  const current = useRef(0);
  const offlineRef = useRef(offline);
  useEffect(() => {
    offlineRef.current = offline;
  });

  const notePage = useCallback((fraction: number) => {
    const s = running.current;
    // Une repagination (un réglage changé) relocalise sans bouger : ce n'est pas une page tournée.
    if (s && Math.abs(fraction - current.current) > 1e-6) {
      s.pages += 1;
      s.to = fraction;
    }
    current.current = fraction;
  }, []);

  useEffect(() => {
    if (!ready) return;
    const start = () => {
      if (running.current || document.visibilityState === "hidden") return;
      running.current = { id: newId(), visibleSince: Date.now(), from: current.current, to: current.current, pages: 0 };
    };
    const end = () => {
      const s = running.current;
      running.current = null;
      if (!s) return;
      const durationMs = Date.now() - s.visibleSince;
      if (durationMs < MIN_SESSION_MS && s.pages === 0) return;
      send({
        book,
        endedAt: Date.now(),
        body: {
          durationMs,
          fromFraction: s.from,
          toFraction: s.to,
          pages: s.pages,
          offline: offlineRef.current || navigator.onLine === false,
          deviceType: currentReaderDeviceType(),
          id: s.id,
          build: APP_BUILD,
          version: APP_VERSION,
        },
      });
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? end() : start());
    const onOnline = () => void flushReadingSessions().catch(() => {});
    start();
    if (!offlineRef.current) onOnline();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", end);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", end);
      window.removeEventListener("online", onOnline);
      end();
    };
  }, [book, ready]);

  return notePage;
}
