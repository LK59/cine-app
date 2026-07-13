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
    const id = setInterval(loadTitles, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    requestNotifPermission();
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

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
            showNotif(t('sse.downloadStartedTitle'), title);
            toast.info(t('sse.downloadStartedToast', { title }));
          }
        } catch {}
      });

      es.addEventListener("torrent-complete", (e) => {
        try {
          const { name } = JSON.parse(e.data) as { name: string };
          const title = matchedTitle(name) ?? name;
          showNotif(t('sse.downloadCompleteTitle'), title);
          toast.success(t('sse.downloadCompleteToast', { title }));
        } catch {}
      });

      es.onerror = () => {
        es?.close();
        if (!stopped) retryTimer = setTimeout(connect, 15000);
      };
    }

    connect();

    return () => {
      stopped = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []); // toast ref is stable

  return null;
}
