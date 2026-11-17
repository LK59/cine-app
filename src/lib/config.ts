import { readOverride } from "@/lib/settings/store";
import { parseAudience } from "@/lib/featureAudience";
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

/** Un entier borné ; une valeur mal formée prend le défaut, une valeur hors bornes la borne. */
function clampInt(value: string, fallback: number, min: number, max: number): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || value.trim() === "") return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Une heure de 0 à 23 ; une valeur mal formée prend le défaut. */
function hourOf(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
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
    // Le téléchargement hors ligne (bêta) : chaque compte peut demander une version légère d'un film,
    // préparée par Jellyfin (`src/lib/offline/`). Coupé, ni bouton ni préparation — la route refuse.
    get offlineDownloads() {
      return optional("OFFLINE_DOWNLOADS", "true") === "true";
    },
    // Ouvert à tous les comptes (le défaut depuis le 20/10/2026), ou aux administrateurs seulement.
    get offlineDownloadsForEveryone() {
      return optional("OFFLINE_DOWNLOADS_FOR_EVERYONE", "true") === "true";
    },
    // La place maximale des versions préparées sur le serveur, en octets (réglage en Go, 50 par défaut).
    get offlineServerQuotaBytes() {
      const gb = Number(optional("OFFLINE_SERVER_QUOTA_GB", "50"));
      return (Number.isFinite(gb) && gb > 0 ? gb : 50) * 1024 ** 3;
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
    /** Le plafond mensuel de **toutes** les fonctions payantes depuis le 09/11/2026 (§140), nom gardé. */
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
  // La recherche par description (07/11/2026) : une phrase qui décrit un film ou une série, reconnue
  // par le fournisseur des sous-titres générés (même clé ; les trois depuis le 09/11/2026). Coupée par défaut.
  describeSearch: {
    get enabled() {
      return optional("DESCRIBE_SEARCH_ENABLED", "false") === "true";
    },
  },
  // « Précédemment » (DECISIONS.md §137) : même fournisseur et même clé que la recherche par
  // description (les trois fournisseurs depuis le 09/11/2026, §140). Coupé par défaut — chaque texte
  // préparé est un appel payant, compté dans le plafond mensuel commun.
  recap: {
    get enabled() {
      return optional("RECAP_ENABLED", "false") === "true";
    },
  },
  // « Poser une question » (DECISIONS.md §139) : même fournisseur et même clé (les trois depuis le
  // 09/11/2026, §140). Coupé par défaut — chaque question est un appel payant.
  ask: {
    /** À qui (`featureAudience.ts`) : `off` (défaut), `admins`, `tous`. */
    get audience() {
      return parseAudience(optional("ASK_ENABLED", "off"));
    },
    get enabled() {
      return this.audience !== "off";
    },
    /**
     * Les questions sur une personne d'« À l'écran » (09/11/2026, §139) — à part des questions sur un
     * titre. Vide : suit `ASK_ENABLED`, d'où elles ont été détachées — une installation réglée avant
     * garde exactement ce qu'elle avait. Elles demandent en plus les acteurs à l'écran.
     */
    get personAudience() {
      const raw = optional("ASK_PERSON_ENABLED", "").trim();
      return raw ? parseAudience(raw) : this.audience;
    },
    /** « Jusqu'ici » (§139) : même règle — vide, suit `ASK_ENABLED` ; demande aussi les acteurs à l'écran. */
    get sofarAudience() {
      const raw = optional("SOFAR_ENABLED", "").trim();
      return raw ? parseAudience(raw) : this.audience;
    },
  },
  // La recherche de répliques (DECISIONS.md §88) : relue à chaque accès, comme le reste — couper
  // l'option arrête l'indexation à sa prochaine lecture de fichier, sans redémarrage.
  repliques: {
    get enabled() {
      return optional("REPLIQUES_ENABLED", "false") === "true";
    },
    get nightly() {
      return optional("REPLIQUES_NIGHTLY", "true") === "true";
    },
    get nightStart() {
      return hourOf(optional("REPLIQUES_NIGHT_START", "2"), 2);
    },
    get nightEnd() {
      return hourOf(optional("REPLIQUES_NIGHT_END", "6"), 6);
    },
    get languages() {
      return optional("REPLIQUES_LANGUAGES", "fr,original");
    },
  },
  // Les livres (option, DECISIONS.md §127) : coupée par défaut. Relue à chaque accès, comme le reste —
  // la couper ferme la page et les routes à la requête suivante, sans redémarrage.
  books: {
    get enabled() {
      return optional("BOOKS_ENABLED", "false") === "true";
    },
    // « Demander un livre » : un ticket que l'administrateur traite à la main. Coupée par défaut, et
    // sans effet tant que les livres eux-mêmes sont coupés.
    get requests() {
      return optional("BOOKS_ENABLED", "false") === "true" && optional("BOOKS_REQUESTS_ENABLED", "false") === "true";
    },
    // Google Books (§127) : l'option, les livres et la clé, les trois — sans quoi rien ne part.
    get googleEnrich() {
      return optional("BOOKS_ENABLED", "false") === "true" && optional("BOOKS_GOOGLE_ENRICH", "false") === "true" && optional("GOOGLE_BOOKS_API_KEY", "") !== "";
    },
    // Jamais copiée ailleurs ni écrite dans un journal : relue à chaque appel (§48).
    get googleKey() {
      return optional("GOOGLE_BOOKS_API_KEY", "");
    },
  },
  // Les salons du chalet (DECISIONS.md §146) : un service à part, `laterna-salons`, le temps réel du mode
  // Immersion à plusieurs. Coupé par défaut ; relu à chaque appel — le couper ferme l'entrée à la demande de
  // laissez-passer suivante, sans redémarrage. Ni l'adresse ni la clé ne sont recopiées ailleurs.
  salons: {
    /** À qui (`featureAudience.ts`) : `off` (défaut), `admins`, `tous`. */
    get audience() {
      return parseAudience(optional("SALONS_ENABLED", "off"));
    },
    get url() {
      return optional("SALONS_URL", "http://laterna-salons:8090");
    },
    /** Partagée avec le service : elle signe les laissez-passer. Jamais renvoyée au navigateur. */
    get key() {
      return optional("SALONS_KEY", "");
    },
  },
  // L'analyse des acteurs à l'écran (DECISIONS.md §138) : un service à part, `laterna-xray`, qui
  // reconnaît les visages scène par scène. Coupée par défaut ; relue à chaque appel comme le reste —
  // la couper arrête les commandes à la séance suivante, sans redémarrage. Ni l'adresse ni la clé ne
  // sont recopiées ailleurs (`clients/xray.ts` les relit à chaque requête).
  xray: {
    /** À qui (`featureAudience.ts`) : `off` (défaut), `admins`, `tous` ; `true`/`false` d'avant valent `tous`/`off`. */
    get audience() {
      return parseAudience(optional("XRAY_ENABLED", "off"));
    },
    /** Le service est-il branché pour quelqu'un — les commandes et la lecture regardent ensuite à qui. */
    get enabled() {
      return this.audience !== "off";
    },
    get url() {
      return optional("XRAY_URL", "http://laterna-xray:8000");
    },
    get apiKey() {
      return optional("XRAY_API_KEY");
    },
    /**
     * « Revenir au début de la scène » (DECISIONS.md §143) : à qui le bouton est montré — `off` (défaut),
     * `admins`, `tous`. Coupé, la décision tourne quand même là où les scènes sont lues, et la ligne `stop`
     * dit ce qu'elle aurait proposé (`sceneRestart`) : de quoi mesurer avant d'allumer.
     */
    get sceneRestart() {
      return parseAudience(optional("SCENE_RESTART_ENABLED", "off"));
    },
  },
  push: {
    get subject() {
      return optional("VAPID_SUBJECT", "mailto:admin@example.com");
    },
  },
  // Le masquage des demandes pour un compte (01/11/2026) : propre à une installation — déploiement
  // seulement (`envOnly`), hors du schéma des réglages et de `.env.example`. Sans compte nommé, rien ne
  // tourne et l'écran n'existe pas.
  requestHide: {
    /** Le compte Jellyfin à qui l'on cache les titres — vide : fonction coupée. */
    get account() {
      return envOnly("REQUEST_HIDE_ACCOUNT", "").trim();
    },
    get enabled() {
      return envOnly("REQUEST_HIDE_ACCOUNT", "").trim() !== "";
    },
    /** Les comptes dont les demandes restent visibles, séparés par des virgules. */
    get keep() {
      return envOnly("REQUEST_HIDE_KEEP", "");
    },
    /** Le tag posé dans Jellyfin et bloqué sur ce compte seul. */
    get tag() {
      return envOnly("REQUEST_HIDE_TAG", "masque-demandes").trim() || "masque-demandes";
    },
  },
  lumen: {
    // Lumen serveur (docs/remux-serveur/, DECISIONS.md §155) : comment un chemin de fichier vu par
    // Jellyfin se lit dans ce conteneur — `racineJellyfin=racineConteneur`, plusieurs paires séparées
    // par `;` (ici `/media=/mnt/media/video`). Vide, coupé : les routes `/api/lumen/…` répondent que le
    // fichier n'est pas lisible ici (`lecture-impossible`) — le relais Jellyfin en repli n'est pas encore
    // écrit. Déploiement seulement (§81) : il dit où sont montés les médias, ce que seul le compose sait.
    // Relu à chaque appel (`lumenServer/paths.ts`), lu par `lumenFileOf` (§156).
    get pathMap() {
      return envOnly("LUMEN_PATH_MAP", "");
    },
    // La conversion du son au serveur (phase 2, DECISIONS.md §161) : à qui elle est ouverte (`off` par défaut,
    // `admins`, `tous`, `featureAudience.ts`). Coupée, ou sans ffmpeg, Lumen serveur refuse une piste DTS,
    // TrueHD, Opus ou MP2/MP3 comme avant (`son-codec`) et le lecteur actuel la convertit dans la page.
    get audioConvert() {
      return parseAudience(optional("LUMEN_AUDIO_CONVERT", "off"));
    },
    // Combien de processus ffmpeg à la fois, et combien de lectures admises à la conversion : les défauts
    // viennent de la mesure de mise à l'échelle du 17/11/2026 (DECISIONS §163) — deux conversions gardent un segment
    // à ~0,4 s, quatre le portent à 0,56 s (p95 1,6 s), huit à 1,3 s (p95 2,4 s) pour à peine plus de débit ; six
    // lectures en continu en prennent ~30 %. Bornés ici : une valeur aberrante ne lance pas cinquante processus.
    get audioMaxJobs() {
      return clampInt(optional("LUMEN_AUDIO_MAX_JOBS", "2"), 2, 1, 8);
    },
    get audioMaxSessions() {
      return clampInt(optional("LUMEN_AUDIO_MAX_SESSIONS", "6"), 6, 1, 32);
    },
    // Le cache des segments convertis : en mémoire (Mo) pour la fenêtre des séances actives, sur le disque (Go,
    // le moins récemment lu évincé). Relus à chaque appel ; une baisse s'applique au balayage suivant.
    get audioRamMb() {
      return clampInt(optional("LUMEN_AUDIO_RAM_MB", "512"), 512, 32, 4096);
    },
    get audioCacheGb() {
      return clampInt(optional("LUMEN_AUDIO_CACHE_GB", "10"), 10, 0, 1000);
    },
    // Déploiement seulement (§81) : où est ffmpeg (vide = pas de conversion) et où va le cache disque (un volume
    // que le compose doit monter s'il n'est pas sous `data/`).
    get ffmpegPath() {
      return envOnly("LUMEN_FFMPEG_PATH", "/usr/local/bin/ffmpeg");
    },
    get audioCacheDir() {
      return envOnly("LUMEN_AUDIO_CACHE_DIR", "");
    },
    // La version allégée de Lumen serveur (`lumenServer/light/`) : à qui elle est ouverte (`off` par défaut, `admins`,
    // `tous`). Coupée, ou sans encodeur VAAPI, la liste maître est celle d'avant à l'octet près.
    get light() {
      return parseAudience(optional("LUMEN_LIGHT", "off"));
    },
    // Combien d'encodages vidéo à la fois : le iGPU sert aussi Jellyfin et X-Ray. Un encodage tient ~2,5 fois le temps
    // réel (mesure du 17/11/2026) : deux rattrapent une lecture en retard.
    get lightMaxJobs() {
      return clampInt(optional("LUMEN_LIGHT_MAX_JOBS", "2"), 2, 1, 4);
    },
    get lightRamMb() {
      return clampInt(optional("LUMEN_LIGHT_RAM_MB", "256"), 256, 32, 4096);
    },
    get lightCacheGb() {
      return clampInt(optional("LUMEN_LIGHT_CACHE_GB", "10"), 10, 0, 1000);
    },
    // Déploiement seulement (§81) : le ffmpeg vidéo (paquet Alpine, VAAPI ; vide = pas de version allégée) et le cache
    // disque des segments allégés.
    get videoFfmpegPath() {
      return envOnly("LUMEN_VIDEO_FFMPEG_PATH", "/usr/bin/ffmpeg");
    },
    get lightCacheDir() {
      return envOnly("LUMEN_LIGHT_CACHE_DIR", "");
    },
  },
  news: {
    // La nouvelle adresse publique annoncée par la page Nouveautés du renommage (`news/pageLaterna.ts`,
    // DECISIONS.md §118). Déploiement seulement, hors du schéma des réglages et de `.env.example` : elle
    // ne vaut que pour l'installation de référence ; vide — toute autre installation —, la page n'est
    // pas semée. Lue au démarrage, par la migration qui sème les pages.
    get laternaAddress() {
      return envOnly("NEWS_LATERNA_ADDRESS", "");
    },
  },
};

export { required };
