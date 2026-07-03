import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { bazarr } from "@/lib/clients/bazarr";
import { jackett } from "@/lib/clients/jackett";
import { jellyfin } from "@/lib/clients/jellyfin";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { tmdb } from "@/lib/clients/tmdb";
import { omdb } from "@/lib/clients/omdb";

interface ServiceStatus {
  name: string;
  up: boolean;
  detail?: string;
  stats?: Record<string, number | string>;
}

async function probe(name: string, fn: () => Promise<{ detail?: string; stats?: Record<string, number | string> }>): Promise<ServiceStatus> {
  try {
    const { detail, stats } = await fn();
    return { name, up: true, detail, stats };
  } catch (err) {
    return { name, up: false, detail: err instanceof Error ? err.message : "Erreur inconnue" };
  }
}

export async function GET() {
  const results = await Promise.all([
    probe("radarr", async () => {
      const [status, movies, missing, queue] = await Promise.all([
        radarr.getSystemStatus(),
        radarr.getMovies(),
        radarr.getMissingCount().catch(() => 0),
        radarr.getQueueCount().catch(() => 0),
      ]);
      return {
        detail: `v${status.version}`,
        stats: { Films: movies.length, Manquants: missing, "En téléchargement": queue },
      };
    }),
    probe("sonarr", async () => {
      const [status, series, missing, queue] = await Promise.all([
        sonarr.getSystemStatus(),
        sonarr.getSeries(),
        sonarr.getMissingCount().catch(() => 0),
        sonarr.getQueueCount().catch(() => 0),
      ]);
      return {
        detail: `v${status.version}`,
        stats: { Séries: series.length, "Épisodes manquants": missing, "En téléchargement": queue },
      };
    }),
    probe("bazarr", async () => {
      const [movies, episodes] = await Promise.all([bazarr.getWantedMovies(), bazarr.getWantedEpisodes()]);
      return {
        stats: { "Films sans sous-titres": movies.total, "Épisodes sans sous-titres": episodes.total },
      };
    }),
    probe("jackett", async () => {
      const indexers = await jackett.getIndexers();
      return { detail: `${indexers.length} indexeurs`, stats: { Indexeurs: indexers.length } };
    }),
    probe("jellyfin", async () => {
      const [info, counts, sessions] = await Promise.all([
        jellyfin.getSystemInfo(),
        jellyfin.getLibraryCounts(),
        jellyfin.getSessions(),
      ]);
      const active = sessions.filter((s) => s.NowPlayingItem).length;
      return {
        detail: `v${info.Version}`,
        stats: { Films: counts.MovieCount, Séries: counts.SeriesCount, "Lectures actives": active },
      };
    }),
    probe("jellyseerr", async () => {
      const [status, pending] = await Promise.all([
        jellyseerr.getStatus(),
        jellyseerr.getRequests("pending"),
      ]);
      return {
        detail: `v${status.version}`,
        stats: { "Demandes en attente": pending.pageInfo?.results ?? pending.results.length },
      };
    }),
    probe("qbittorrent", async () => {
      const [transfer, torrents] = await Promise.all([
        qbittorrent.getTransferInfo(),
        qbittorrent.getTorrents(),
      ]);
      const downloading = torrents.filter((t) => /downloading|dl$/i.test(t.state)).length;
      const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB/s`;
      return {
        stats: {
          Torrents: torrents.length,
          "En téléchargement": downloading,
          "↓": fmt(transfer.dl_info_speed),
          "↑": fmt(transfer.up_info_speed),
        },
      };
    }),
    probe("tmdb", async () => {
      if (!tmdb.isEnabled()) throw new Error("Clé API non configurée (TMDB_API_KEY)");
      const auth = await tmdb.checkAuth();
      if (!auth.success) throw new Error("Clé API invalide");
      return { detail: "Clé API valide" };
    }),
    probe("omdb", async () => {
      if (!omdb.isEnabled()) throw new Error("Clé API non configurée (OMDB_API_KEY)");
      const res = await omdb.checkKey();
      if (res.Response !== "True") throw new Error("Clé API invalide");
      return { detail: "Clé API valide" };
    }),
  ]);

  return NextResponse.json(results);
}
