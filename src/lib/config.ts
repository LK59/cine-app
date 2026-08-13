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
    // In-app playback always forces Jellyfin to transcode (see jellyfin.ts) —
    // real CPU/GPU cost on the server for every play, unlike the plain
    // redirect-to-Jellyfin-web fallback. Opt-in, off by default.
    enabled: optional("PLAYER_ENABLED", "false") === "true",
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
