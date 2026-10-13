import { readOverride } from "@/lib/settings/store";
import { receiverAppIdOf } from "@/lib/chromecast/receiverAppId";

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
    // Jamais réglable dans l'application (13/10/2026, DECISIONS.md §81) : il dit comment le
    // conteneur est servi — derrière un relais HTTPS ou non —, ce que seul le déploiement sait, et
    // une valeur fausse posée d'ici empêchait toute connexion (cookie refusé en HTTP), page de
    // réglage comprise. Une valeur restée en base n'est plus lue.
    get cookieSecure() {
      return envOnly("COOKIE_SECURE", "false") === "true";
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
    // L'application que le Chromecast ouvre (DECISIONS.md §64) : le récepteur de Google par défaut,
    // ou celui qu'une installation a enregistré elle-même. Une valeur mal formée retombe sur le
    // défaut — voir `receiverAppIdOf`.
    get castReceiverAppId() {
      return receiverAppIdOf(optional("CAST_RECEIVER_APP_ID"));
    },
    // Le bouton Chromecast pour tous les comptes (défaut depuis le 11/10/2026), ou pour les seuls
    // administrateurs quand l'installation le referme.
    get chromecastForEveryone() {
      return optional("CHROMECAST_FOR_EVERYONE", "true") === "true";
    },
  },
  home: {
    // La bannière du haut montre d'abord Reprendre / À suivre, complétée par « À la une » s'il y en a
    // peu ; « À la une » descend à la place de la rangée Reprendre.
    get continueHero() {
      return optional("HOME_CONTINUE_HERO", "false") === "true";
    },
  },
  network: {
    // Les relais dont on croit `X-Forwarded-For` : adresses, réseaux ou noms de conteneur, séparés
    // par des virgules. Vide : le dernier maillon de l'en-tête, comme avant — voir `trustedProxy.ts`.
    // Déploiement seulement (§81) : il décide de qui l'on croit l'adresse, donc des limites de
    // connexion. Il passait par `optional` sans être réglable nulle part — une ligne en base aurait
    // suffi à le changer.
    get trustedProxies() {
      return envOnly("TRUSTED_PROXIES", "");
    },
  },
  accounts: {
    // Les tags bloqués d'office sur un compte Jellyfin que l'installation découvre (`newAccountTags.ts`),
    // séparés par des virgules. Vide : rien n'est posé.
    get newBlockedTags() {
      return optional("NEW_ACCOUNT_BLOCKED_TAGS", "");
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
    // Sans adresse par défaut (13/10/2026) : `http://gluetun:8080` était celle d'une installation
    // particulière, et toute autre l'interrogeait sans l'avoir demandé. Vide = non configuré.
    get url() {
      return optional("QBITTORRENT_URL", "");
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
  // Les sous-titres générés par traduction (DECISIONS.md §69). Lus à chaque appel comme le reste :
  // une clé retirée dans la gestion met les tâches en pause au lot suivant, sans redémarrage.
  subtitleGen: {
    get enabled() {
      return optional("SUBTITLE_GEN_ENABLED", "true") === "true";
    },
    get provider() {
      return optional("SUBTITLE_GEN_PROVIDER", "anthropic");
    },
    get apiKey() {
      return optional("SUBTITLE_GEN_API_KEY");
    },
    /** Vide : le modèle par défaut du fournisseur. */
    get model() {
      return optional("SUBTITLE_GEN_MODEL");
    },
    get budgetUsd() {
      return optional("SUBTITLE_GEN_BUDGET_USD", "5");
    },
    get priceInput() {
      return optional("SUBTITLE_GEN_PRICE_INPUT");
    },
    get priceOutput() {
      return optional("SUBTITLE_GEN_PRICE_OUTPUT");
    },
  },
  push: {
    get subject() {
      return optional("VAPID_SUBJECT", "mailto:admin@example.com");
    },
  },
};

export { required };
