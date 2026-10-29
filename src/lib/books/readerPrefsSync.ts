"use client";

import { useEffect, useRef } from "react";
import { normalizeReaderPrefs, type ReaderPrefs } from "@/lib/books/readerPrefs";
import { currentReaderDeviceType, isReaderDeviceType, type ReaderDeviceType } from "@/lib/books/deviceType";

/**
 * Les réglages du lecteur, entre l'appareil et le serveur (DECISIONS.md §129).
 *
 * Le lecteur s'ouvre **aussitôt** sur la copie de l'appareil (`laterna:books:reader`) — jamais une attente
 * de réseau avant la première page, et c'est la seule source hors ligne. Puis :
 * - à l'ouverture, il demande ceux du compte pour ce type d'appareil (`/api/books/reader-prefs`) et les
 *   prend s'ils diffèrent — sauf si l'on a déjà touché un réglage depuis l'ouverture : le geste l'emporte ;
 * - à chaque changement, il les envoie une seconde après le dernier (un curseur en produit des dizaines),
 *   et tout de suite si le lecteur se referme entre-temps (`keepalive`).
 *
 * Un envoi qui n'aboutit pas (pas de réseau, serveur en panne, session expirée) laisse une marque sur
 * l'appareil (`laterna:books:reader-pending`, avec l'heure du changement) : à la prochaine ouverture en
 * ligne, la copie de l'appareil part d'abord, et n'est pas remplacée par celle, plus ancienne, du
 * serveur. Le serveur ne la garde pas si un autre appareil du même type a changé les siens depuis
 * (`saveReaderPrefs`). La marque est sous `laterna:books:` : la déconnexion l'efface — elle ne vaut que
 * pour le compte qui l'a posée.
 */

const PREFS_URL = "/api/books/reader-prefs";
const PENDING_KEY = "laterna:books:reader-pending";
export const PREFS_PUSH_DELAY_MS = 1000;

interface Pending {
  device: ReaderDeviceType;
  at: number;
}

function readPending(): Pending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Pending>) : null;
    return p && isReaderDeviceType(p.device) && typeof p.at === "number" ? { device: p.device, at: p.at } : null;
  } catch {
    return null;
  }
}
function writePending(p: Pending | null): void {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* stockage refusé : le réglage part maintenant ou pas du tout */
  }
}

/** Envoie les réglages ; la marque n'est retirée que si rien de plus récent n'a été posé entre-temps. */
async function push(device: ReaderDeviceType, prefs: ReaderPrefs, at: number): Promise<void> {
  try {
    const res = await fetch(PREFS_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, prefs, ageMs: Math.max(0, Date.now() - at) }),
      keepalive: true,
    });
    // Un refus (400, 404 option coupée) n'est pas retenté ; une panne, une session expirée, si.
    if (res.status >= 500 || res.status === 401 || res.status === 429) return;
  } catch {
    return;
  }
  if (readPending()?.at === at) writePending(null);
}

/**
 * `prefs` : les réglages montrés ; `adopt` : les remplacer par ceux du serveur (le `setState` du lecteur).
 * `offline` : la page hors ligne des livres — l'appareil seul, la marque posée pour plus tard.
 */
export function useReaderPrefsSync(prefs: ReaderPrefs, adopt: (prefs: ReaderPrefs) => void, offline: boolean): void {
  // Ce qui est montré et déjà su du serveur (ou venu de lui) : un changement de `prefs` qui y revient
  // n'est pas un geste. Posé au premier rendu — la copie de l'appareil.
  const baseline = useRef<string | null>(null);
  const latest = useRef(prefs);
  const touched = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const due = useRef<(() => void) | null>(null);

  // À l'ouverture : la copie de l'appareil part d'abord si elle attendait ; sinon, ceux du compte.
  useEffect(() => {
    if (offline) return;
    const device = currentReaderDeviceType();
    const pending = readPending();
    if (pending) {
      void push(pending.device, latest.current, pending.at);
      if (pending.device === device) return;
    }
    let alive = true;
    void fetch(`${PREFS_URL}?device=${device}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ prefs: unknown }>) : null))
      .then((data) => {
        if (!alive || touched.current || !data?.prefs) return;
        const next = normalizeReaderPrefs(data.prefs);
        const signature = JSON.stringify(next);
        if (signature === JSON.stringify(latest.current)) return;
        baseline.current = signature;
        adopt(next);
      })
      .catch(() => {
        /* sans réseau : la copie de l'appareil */
      });
    return () => {
      alive = false;
    };
  }, [offline, adopt]);

  // Un réglage changé : retenu sur l'appareil, envoyé une seconde après le dernier changement.
  useEffect(() => {
    latest.current = prefs;
    const signature = JSON.stringify(prefs);
    if (baseline.current === null || signature === baseline.current) {
      baseline.current = signature;
      return;
    }
    baseline.current = signature;
    touched.current = true;
    const device = currentReaderDeviceType();
    const at = Date.now();
    writePending({ device, at });
    if (offline) return;
    if (timer.current) clearTimeout(timer.current);
    const send = () => {
      timer.current = null;
      due.current = null;
      void push(device, latest.current, at);
    };
    due.current = send;
    timer.current = setTimeout(send, PREFS_PUSH_DELAY_MS);
  }, [prefs, offline]);

  // Refermé avant la seconde : l'envoi part tout de suite (`keepalive` le laisse finir sans la page).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      due.current?.();
    },
    []
  );
}
