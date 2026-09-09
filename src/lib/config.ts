function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  app: {
    adminUser: optional("APP_ADMIN_USER", "admin"),
    adminPassword: optional("APP_ADMIN_PASSWORD", ""),
    sessionSecret: optional("SESSION_SECRET", "change-me-in-production"),
    cookieSecure: optional("COOKIE_SECURE", "false") === "true",
    language: optional("APP_LANGUAGE", "en"),
  },
  radarr: {
    url: optional("RADARR_URL", "http://radarr:7878"),
    apiKey: optional("RADARR_API_KEY"),
  },
  sonarr: {
    url: optional("SONARR_URL", "http://sonarr:8989"),
    apiKey: optional("SONARR_API_KEY"),
  },
  bazarr: {
    url: optional("BAZARR_URL", "http://bazarr:6767"),
    apiKey: optional("BAZARR_API_KEY"),
  },
  jackett: {
    url: optional("JACKETT_URL", "http://jackett:9117"),
    apiKey: optional("JACKETT_API_KEY"),
  },
  jellyfin: {
    url: optional("JELLYFIN_URL", "http://jellyfin:8096"),
    publicUrl: optional("JELLYFIN_PUBLIC_URL"),
    apiKey: optional("JELLYFIN_API_KEY"),
  },
  player: {
    // In-app playback. On by default since the native player landed: it reads the file over byte
    // ranges and repackages it in the browser, so the ordinary playback costs the server nothing
    // beyond serving bytes. The flag was opt-in while every play meant a Jellyfin transcode, and
    // that is no longer what happens — see DOC-TECH.md.
    enabled: optional("PLAYER_ENABLED", "true") === "true",
    // Whether the server-side player exists at all on this install.
    //
    // True (default): a file the browser cannot handle is handed to Jellyfin, which negotiates
    // and, if it must, transcodes — the historical behaviour, and the safety net that makes any
    // file playable. The per-account "legacy player" option is part of this: it is the same
    // server-side player, chosen deliberately.
    //
    // False: nothing is ever handed to Jellyfin. A file neither the native path nor WebCodecs
    // can carry ends on a plain playback error naming the reason, and the per-account option is
    // neither offered nor honoured. For an operator who wants a hard guarantee that no playback
    // can ever start a transcode.
    serverFallback: optional("PLAYER_SERVER_FALLBACK", "true") === "true",
  },
  jellyseerr: {
    url: optional("JELLYSEERR_URL", "http://jellyseerr:5055"),
    apiKey: optional("JELLYSEERR_API_KEY"),
  },
  qbittorrent: {
    url: optional("QBITTORRENT_URL", "http://gluetun:8080"),
    username: optional("QBITTORRENT_USERNAME", "admin"),
    password: optional("QBITTORRENT_PASSWORD"),
  },
  tmdb: {
    apiKey: optional("TMDB_API_KEY"),
  },
  omdb: {
    apiKey: optional("OMDB_API_KEY"),
  },
};

export { required };
