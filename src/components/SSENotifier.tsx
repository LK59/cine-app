"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

interface PendingTitle {
  title: string;
}

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true if the media title plausibly matches the torrent name
function matchesTorrent(title: string, torrentName: string): boolean {
  const tNorm = normTitle(title);
  const rNorm = normTitle(torrentName);
  const words = tNorm.split(" ").slice(0, 4).join(" ");
  return words.length >= 3 && rNorm.includes(words);
}

async function requestNotifPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function showNotif(title: string, body: string) {
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, icon: "/icon-192.png", silent: false });
}

export function SSENotifier() {
  const toast = useToast();
  const t = useT();
  // Kept in sync below so the long-lived SSE effect always reads the current
  // translation function instead of closing over the one from mount time.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  // Titles of the current user's pending Jellyseerr requests, updated periodically
  const pendingTitles = useRef<PendingTitle[]>([]);

  // Fetch user's pending request titles so we can match against torrent names
  useEffect(() => {
    let cancelled = false;

    async function loadTitles() {
      try {
        const res = await fetch("/api/jellyseerr/my-requests");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        pendingTitles.current = (data.results ?? [])
          .map((r: { media?: { title?: string } }) => ({ title: r.media?.title ?? "" }))
          .filter((t: PendingTitle) => t.title.length > 0);
      } catch {}
    }

    loadTitles();
    // Pas pendant que l'onglet est caché (08/10/2026) : la liste ne sert qu'à nommer un
    // téléchargement, elle est relue au retour.
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void loadTitles();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadTitles();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    requestNotifPermission();
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let failures = 0;

    function matchedTitle(torrentName: string): string | null {
      for (const { title } of pendingTitles.current) {
        if (matchesTorrent(title, torrentName)) return title;
      }
      return null;
    }

    function connect() {
      if (stopped) return;
      es = new EventSource("/api/sse");

      es.addEventListener("torrent-started", (e) => {
        try {
          const { name } = JSON.parse(e.data) as { name: string };
          const title = matchedTitle(name);
          if (title) {
            showNotif(tRef.current('sse.downloadStartedTitle'), title);
            toast.info(tRef.current('sse.downloadStartedToast', { title }));
          }
        } catch {}
      });

      es.addEventListener("torrent-complete", (e) => {
        try {
          const { name } = JSON.parse(e.data) as { name: string };
          const title = matchedTitle(name) ?? name;
          showNotif(tRef.current('sse.downloadCompleteTitle'), title);
          toast.success(tRef.current('sse.downloadCompleteToast', { title }));
        } catch {}
      });

      // Une connexion qui tient remet l'attente à zéro.
      es.onopen = () => {
        failures = 0;
      };
      // La connexion reste ouverte onglet caché — c'est là que la notification du système sert.
      // Mais une route qui refuse ne se redemande plus toutes les quinze secondes pour toujours :
      // 15 s, puis le double à chaque échec, jusqu'à cinq minutes (08/10/2026).
      es.onerror = () => {
        es?.close();
        failures += 1;
        if (!stopped) retryTimer = setTimeout(connect, Math.min(15_000 * 2 ** (failures - 1), 300_000));
      };
    }

    connect();

    return () => {
      stopped = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast.* callbacks are useCallback-stable; t is read via tRef, never stale
  }, []);

  return null;
}
