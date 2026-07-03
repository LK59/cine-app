export const INTERVALS = {
  TORRENTS: 5_000,   // qBittorrent page — live torrent list
  LIVE: 8_000,       // Dashboard qBittorrent widget
  SESSIONS: 10_000,  // Jellyfin sessions
  FAST: 15_000,      // Jellyseerr pending requests
  MEDIUM: 30_000,    // Activity feed, user requests
  RESUME: 60_000,    // Continue watching
  SLOW: 120_000,     // Library counts, recently added, disk stats
} as const;
