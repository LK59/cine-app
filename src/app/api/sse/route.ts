import { NextRequest } from "next/server";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { sendPushToAll } from "@/lib/push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIVE = new Set(["downloading", "stalledDL", "metaDL", "forcedDL", "checkingDL", "allocating"]);
const DONE = new Set(["uploading", "stalledUP", "forcedUP", "pausedUP", "completed"]);

const encoder = new TextEncoder();
// All open SSE connections
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
// Hashes known to be actively downloading
const downloading = new Map<string, string>(); // hash → name
let bootstrapped = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
// Track hashes seen as ACTIVE on the previous tick to detect truly new downloads
const seenActive = new Set<string>();

function broadcast(event: string, data: unknown) {
  const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of clients) {
    try { ctrl.enqueue(chunk); } catch { clients.delete(ctrl); }
  }
}

function startSharedPolling() {
  if (intervalId !== null) return;
  intervalId = setInterval(async () => {
    try {
      const torrents = await qbittorrent.getTorrents();
      const currentHashes = new Set(torrents.map((t) => t.hash));
      const completed: string[] = [];

      const started: string[] = [];

      for (const t of torrents) {
        if (ACTIVE.has(t.state)) {
          if (bootstrapped && !seenActive.has(t.hash)) started.push(t.name);
          seenActive.add(t.hash);
          downloading.set(t.hash, t.name);
        } else if (DONE.has(t.state) && downloading.has(t.hash)) {
          if (bootstrapped) completed.push(t.name);
          seenActive.delete(t.hash);
          downloading.delete(t.hash);
        }
      }
      // Clean up stale entries
      for (const hash of downloading.keys()) {
        if (!currentHashes.has(hash)) { downloading.delete(hash); seenActive.delete(hash); }
      }
      bootstrapped = true;

      for (const name of started) {
        broadcast("torrent-started", { name });
        sendPushToAll({ title: "Téléchargement démarré", body: name, tag: "torrent-started", url: "/qbittorrent", category: "torrent-started" }).catch(() => {});
      }
      for (const name of completed) {
        broadcast("torrent-complete", { name });
        sendPushToAll({ title: "Téléchargement terminé ✓", body: name, tag: "torrent-complete", url: "/qbittorrent", category: "torrent-complete" }).catch(() => {});
      }
    } catch {}
  }, 6000);
}

export async function GET(req: NextRequest) {
  startSharedPolling();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.add(controller);
      controller.enqueue(encoder.encode(`event: connected\ndata: {}\n\n`));

      req.signal.addEventListener("abort", () => {
        clients.delete(controller);
        try { controller.close(); } catch {}
        // Stop polling when no clients remain — reset state for next connect
        if (clients.size === 0 && intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
          bootstrapped = false;
          downloading.clear();
          seenActive.clear();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
