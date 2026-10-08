import { readOverride } from "@/lib/settings/store";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Une valeur de configuration : réglée dans l'application d'abord, `.env` ensuite, le défaut enfin
 * (DECISIONS.md §48). Relue à chaque accès — les champs ci-dessous sont des accesseurs —, si bien
 * qu'un réglage changé dans la gestion s'applique sans redémarrer, et que le code qui lit
 * `config.radarr.url` n'a rien à savoir de tout ça.
 */
function optional(name: string, fallback = ""): string {
  return readOverride(name) ?? process.env[name] ?? fallback;
}

/**
 * Le secret de session ne se règle jamais dans l'application : il signe les sessions, et le changer
 * en cours de route les invaliderait toutes. Il vient de `.env`, ou du fichier que le démarrage
 * génère au premier lancement (`server-boot/firstRunSecrets.mjs`), qui l'a posé dans l'environnement.
 */
function envOnly(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  app: {
    get adminUser() {
      return envOnly("APP_ADMIN_USER", "admin");
    },
    get adminPassword() {
      return envOnly("APP_ADMIN_PASSWORD", "");
    },
    get sessionSecret() {
      return envOnly("SESSION_SECRET", "change-me-in-production");
    },
    get cookieSecure() {
      return optional("COOKIE_SECURE", "false") === "true";
    },
    get language() {
      return optional("APP_LANGUAGE", "en");
    },
  },
  radarr: {
    get url() {
      return optional("RADARR_URL", "http://radarr:7878");
    },
    get apiKey() {
      return optional("RADARR_API_KEY");
    },
  },
  sonarr: {
    get url() {
      return optional("SONARR_URL", "http://sonarr:8989");
    },
    get apiKey() {
      return optional("SONARR_API_KEY");
    },
  },
  bazarr: {
    get url() {
      return optional("BAZARR_URL", "http://bazarr:6767");
    },
    get apiKey() {
      return optional("BAZARR_API_KEY");
    },
  },
  jackett: {
    get url() {
      return optional("JACKETT_URL", "http://jackett:9117");
    },
    get apiKey() {
      return optional("JACKETT_API_KEY");
    },
  },
  jellyfin: {
    get url() {
      return optional("JELLYFIN_URL", "http://jellyfin:8096");
    },
    get publicUrl() {
      return optional("JELLYFIN_PUBLIC_URL");
    },
    get apiKey() {
      return optional("JELLYFIN_API_KEY");
    },
  },
  player: {
    // In-app playback. On by default since the native player landed: it reads the file over byte
    // ranges and repackages it in the browser, so the ordinary playback costs the server nothing
    // beyond serving bytes. The flag was opt-in while every play meant a Jellyfin transcode, and
    // that is no longer what happens — see DOC-TECH.md.
    get enabled() {
      return optional("PLAYER_ENABLED", "true") === "true";
    },
    // Whether the server-side player exists at all on this install.
    //
    // True (default): a file the browser cannot handle is handed to Jellyfin, which negotiates
    // and, if it must, transcodes — the historical behaviour, and the safety net that makes any
    // file playable. The per-account "legacy player" option is part of this: it is the same
    // server-side player, chosen deliberately.
    //
    // False: nothing is ever handed to Jellyfin. A file the native path cannot carry ends on a
    // plain playback error naming the reason, and the per-account option is neither offered nor
    // honoured. For an operator who wants a hard guarantee that no playback can ever start a
    // transcode.
    get serverFallback() {
      return optional("PLAYER_SERVER_FALLBACK", "true") === "true";
    },
    // Whether the picture is enlarged to hide black bars baked into the file (see pictureFrame.ts).
    // Measured on the server from Jellyfin's trickplay thumbnails — no video is decoded — so it
    // needs trickplay images to exist; without them the picture is simply shown as it is.
    get autoFrame() {
      return optional("PLAYER_AUTO_FRAME", "true") === "true";
    },
  },
  home: {
    // « Tous les films » / « Toutes les séries » en tête de l'accueil, à côté de la bascule.
    get browseButton() {
      return optional("HOME_BROWSE_BUTTON", "true") === "true";
    },
    // La bannière du haut montre d'abord Reprendre / À suivre, complétée par « À la une » s'il y en a
    // peu ; « À la une » descend à la place de la rangée Reprendre.
    get continueHero() {
      return optional("HOME_CONTINUE_HERO", "false") === "true";
    },
  },
  accounts: {
    // Les tags bloqués d'office sur un compte Jellyfin que l'installation découvre (`newAccountTags.ts`),
    // séparés par des virgules. Vide : rien n'est posé.
    get newBlockedTags() {
      return optional("NEW_ACCOUNT_BLOCKED_TAGS", "");
    },
  },
  gallery: {
    // La galerie Clara Galle, option personnelle de l'installation de référence. Lue au
    // démarrage, fermée par défaut : elle était figée dans l'image au moment du build, par défaut
    // ouverte, si bien que l'image publiée l'avait activée quoi que dise le `.env` (22/09/2026).
    get clara() {
      return envOnly("CLARA_GALLERY_ENABLED", "false") === "true";
    },
  },
  jellyseerr: {
    get url() {
      return optional("JELLYSEERR_URL", "http://jellyseerr:5055");
    },
    get apiKey() {
      return optional("JELLYSEERR_API_KEY");
    },
  },
  qbittorrent: {
    get url() {
      return optional("QBITTORRENT_URL", "http://gluetun:8080");
    },
    get username() {
      return optional("QBITTORRENT_USERNAME", "admin");
    },
    get password() {
      return optional("QBITTORRENT_PASSWORD");
    },
  },
  tmdb: {
    get apiKey() {
      return optional("TMDB_API_KEY");
    },
  },
  omdb: {
    get apiKey() {
      return optional("OMDB_API_KEY");
    },
  },
  mdblist: {
    get apiKey() {
      return optional("MDBLIST_API_KEY");
    },
  },
  push: {
    get subject() {
      return optional("VAPID_SUBJECT", "mailto:admin@example.com");
    },
  },
};

export { required };
