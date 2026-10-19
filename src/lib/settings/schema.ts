/**
 * Les réglages de l'installation — la seule liste (DECISIONS.md §48).
 *
 * Lue par le serveur (qui résout chaque valeur : réglée dans l'application, sinon `.env`, sinon
 * défaut) et par l'interface (l'assistant de premier lancement, la page « Connexions » de la
 * gestion). Rien de secret ici : des noms, des groupes, des règles. Les libellés et les « pourquoi »
 * vivent dans les dictionnaires, sous `setup.fields.<CLÉ>`.
 *
 * - `inApp` : réglable dans l'application. Sinon, c'est une option de déploiement (un chemin monté,
 *   le fuseau) : l'interface donne la ligne à ajouter au `docker-compose.yml` ou au `.env`.
 * - `secret` : jamais renvoyée au navigateur, seulement « renseignée » et ses quatre derniers caractères.
 * - `profile` : un profil de qualité de Radarr ou Sonarr, choisi dans la liste lue chez le service
 *   (son identifiant ; vide = le premier de la liste).
 * - `need` : `required` (le cinéma ne fonctionne pas sans) ou `optional` (enrichit l'interface).
 *   Radarr et Sonarr sont facultatifs depuis le 14/10/2026 (DECISIONS.md §89) : sans eux, le cinéma
 *   montre ce que Jellyfin a ; ils apportent la gestion — téléchargements, demandes, épisodes manquants.
 *   (Il existait un troisième niveau, « au moins Radarr ou Sonarr », qui bloquait l'assistant.)
 */

export type SettingKind = "url" | "secret" | "text" | "boolean" | "select" | "profile" | "number";
export type SettingNeed = "required" | "optional";
export type SettingGroup = "jellyfin" | "tmdb" | "radarr" | "sonarr" | "jellyseerr" | "qbittorrent" | "bazarr" | "jackett" | "ratings" | "playback" | "subtitles" | "dialogue" | "app" | "defaults" | "deployment";

export interface SettingDef {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  need: SettingNeed;
  /** La valeur quand ni l'application ni `.env` n'en donnent. */
  fallback: string;
  inApp: boolean;
  /** Les choix d'un `select`. */
  options?: readonly string[];
  /** Exemple montré dans le champ. */
  placeholder?: string;
  /**
   * Lu au démarrage seulement : la carte dit « au prochain démarrage » sous le champ. Tout le reste
   * est relu à chaque accès (`config.ts`) et s'applique sans redémarrer.
   */
  restart?: true;
}

/** Les heures d'une plage horaire, « 0 » à « 23 ». */
const HOURS: readonly string[] = Array.from({ length: 24 }, (_, h) => String(h));

export const SETTINGS: readonly SettingDef[] = [
  // ── L'indispensable ──
  { key: "JELLYFIN_URL", group: "jellyfin", kind: "url", need: "required", fallback: "http://jellyfin:8096", inApp: true, placeholder: "http://jellyfin:8096" },
  { key: "JELLYFIN_API_KEY", group: "jellyfin", kind: "secret", need: "required", fallback: "", inApp: true },
  { key: "JELLYFIN_PUBLIC_URL", group: "jellyfin", kind: "url", need: "optional", fallback: "", inApp: true, placeholder: "https://jellyfin.example.com" },
  { key: "TMDB_API_KEY", group: "tmdb", kind: "secret", need: "required", fallback: "", inApp: true },
  { key: "RADARR_URL", group: "radarr", kind: "url", need: "optional", fallback: "http://radarr:7878", inApp: true, placeholder: "http://radarr:7878" },
  { key: "RADARR_API_KEY", group: "radarr", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "RADARR_QUALITY_PROFILE", group: "radarr", kind: "profile", need: "optional", fallback: "", inApp: true },
  { key: "SONARR_URL", group: "sonarr", kind: "url", need: "optional", fallback: "http://sonarr:8989", inApp: true, placeholder: "http://sonarr:8989" },
  { key: "SONARR_API_KEY", group: "sonarr", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "SONARR_QUALITY_PROFILE", group: "sonarr", kind: "profile", need: "optional", fallback: "", inApp: true },
  // ── Ce qui enrichit ──
  { key: "JELLYSEERR_URL", group: "jellyseerr", kind: "url", need: "optional", fallback: "http://jellyseerr:5055", inApp: true, placeholder: "http://jellyseerr:5055" },
  { key: "JELLYSEERR_API_KEY", group: "jellyseerr", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "QBITTORRENT_URL", group: "qbittorrent", kind: "url", need: "optional", fallback: "", inApp: true, placeholder: "http://qbittorrent:8080" },
  { key: "QBITTORRENT_USERNAME", group: "qbittorrent", kind: "text", need: "optional", fallback: "admin", inApp: true },
  { key: "QBITTORRENT_PASSWORD", group: "qbittorrent", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "BAZARR_URL", group: "bazarr", kind: "url", need: "optional", fallback: "http://bazarr:6767", inApp: true, placeholder: "http://bazarr:6767" },
  { key: "BAZARR_API_KEY", group: "bazarr", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "JACKETT_URL", group: "jackett", kind: "url", need: "optional", fallback: "http://jackett:9117", inApp: true, placeholder: "http://jackett:9117" },
  { key: "JACKETT_API_KEY", group: "jackett", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "OMDB_API_KEY", group: "ratings", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "MDBLIST_API_KEY", group: "ratings", kind: "secret", need: "optional", fallback: "", inApp: true },
  // ── Les sous-titres générés (DECISIONS.md §69) ──
  // Traduits par une IA en ligne à partir d'un sous-titre complet du titre. Sans clé, la fonction
  // n'existe pas : aucune route ne l'annonce. La clé ne quitte jamais le serveur (`secret`).
  // Le modèle vide vaut celui du fournisseur (`DEFAULT_MODELS`, subtitleGen/pricing.ts) ; les prix
  // vides valent la table officielle — remplis, ils la remplacent (un modèle qu'elle ne connaît pas).
  { key: "SUBTITLE_GEN_ENABLED", group: "subtitles", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "SUBTITLE_GEN_PROVIDER", group: "subtitles", kind: "select", need: "optional", fallback: "anthropic", inApp: true, options: ["anthropic", "openai", "google"] },
  { key: "SUBTITLE_GEN_API_KEY", group: "subtitles", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "SUBTITLE_GEN_MODEL", group: "subtitles", kind: "text", need: "optional", fallback: "", inApp: true },
  { key: "SUBTITLE_GEN_BUDGET_USD", group: "subtitles", kind: "number", need: "optional", fallback: "5", inApp: true, placeholder: "5" },
  { key: "SUBTITLE_GEN_PRICE_INPUT", group: "subtitles", kind: "number", need: "optional", fallback: "", inApp: true },
  { key: "SUBTITLE_GEN_PRICE_OUTPUT", group: "subtitles", kind: "number", need: "optional", fallback: "", inApp: true },
  // ── La recherche de répliques (DECISIONS.md §88) ──
  // Coupée par défaut : elle lit les films sur le disque, ce qu'une installation doit avoir monté et
  // décidé. La page refuse de l'allumer tant que le dossier des films n'est pas lisible (`checkMoviesMount`).
  // La plage de nuit est en heures locales du conteneur (`TZ`) ; les langues, des codes séparés par des
  // virgules, `original` valant la langue de tournage de chaque film.
  { key: "REPLIQUES_ENABLED", group: "dialogue", kind: "boolean", need: "optional", fallback: "false", inApp: true },
  { key: "REPLIQUES_NIGHTLY", group: "dialogue", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "REPLIQUES_NIGHT_START", group: "dialogue", kind: "select", need: "optional", fallback: "2", inApp: true, options: HOURS },
  { key: "REPLIQUES_NIGHT_END", group: "dialogue", kind: "select", need: "optional", fallback: "6", inApp: true, options: HOURS },
  { key: "REPLIQUES_LANGUAGES", group: "dialogue", kind: "text", need: "optional", fallback: "fr,original", inApp: true, placeholder: "fr,original" },
  // ── L'application ──
  { key: "PLAYER_ENABLED", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "PLAYER_SERVER_FALLBACK", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // Le téléchargement hors ligne dans l'application (bêta, 19/10/2026) : Jellyfin prépare une version
  // légère, l'appareil la garde. Ouvert à tous les comptes ; coupé ici pour toute l'installation.
  { key: "OFFLINE_DOWNLOADS", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // Ouvert à tous les comptes par défaut depuis le 20/10/2026 (administrateurs seulement pendant les
  // premiers essais, du 19 au 20/10) ; refermé aux administrateurs d'un geste ici, comme le Chromecast.
  { key: "OFFLINE_DOWNLOADS_FOR_EVERYONE", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // La place que les versions préparées peuvent prendre sur le serveur, en Go (20/10/2026) : au-delà,
  // les plus anciennes que tous les appareils ont entièrement récupérées s'effacent (`jobs.ts`).
  { key: "OFFLINE_SERVER_QUOTA_GB", group: "playback", kind: "number", need: "optional", fallback: "50", inApp: true, placeholder: "50" },
  { key: "PLAYER_AUTO_FRAME", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // L'application que le Chromecast ouvre (DECISIONS.md §64) : vide, le récepteur public de Google.
  // Pas un secret — l'identifiant d'un récepteur qu'une installation a enregistré elle-même.
  { key: "CAST_RECEIVER_APP_ID", group: "playback", kind: "text", need: "optional", fallback: "", inApp: true, placeholder: "CC1AD845" },
  // Le bouton Chromecast : administrateurs seulement par défaut, le temps d'un premier essai sur un
  // vrai récepteur ; ouvert à tous les comptes d'un geste ici.
  { key: "CHROMECAST_FOR_EVERYONE", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // La disposition de l'accueil (07/10/2026, DECISIONS.md §52) — une variante d'une installation à
  // l'autre, sans fourche du code : une bannière qui montre ce qu'on regarde plutôt que ce qui vient
  // d'arriver. « Réglages par défaut » : ce que voit un compte qui n'a rien choisi — chacun peut le
  // changer dans Compte → Interface. Coupée par défaut depuis le 08/10/2026 : la bannière fait
  // découvrir, la première rangée sert à reprendre. `HOME_BROWSE_BUTTON` a disparu le 13/10/2026 :
  // le bouton « Tous les films / séries » est toujours affiché ; une valeur restée en base ou dans
  // `.env` n'est plus lue.
  // La langue d'un compte qui n'en a choisi aucune (et de l'écran de connexion) : un réglage par
  // défaut des comptes, rangé avec eux dans Configuration → Nouveaux comptes (§81).
  { key: "APP_LANGUAGE", group: "defaults", kind: "select", need: "optional", fallback: "en", inApp: true, options: ["fr", "en", "es", "de"] },
  { key: "HOME_CONTINUE_HERO", group: "defaults", kind: "boolean", need: "optional", fallback: "false", inApp: true },
  { key: "NEW_ACCOUNT_BLOCKED_TAGS", group: "defaults", kind: "text", need: "optional", fallback: "", inApp: true, placeholder: "prive" },
  // Lu au démarrage seulement (`instrumentation.ts` lance la tâche) : `restart` le fait dire.
  { key: "POSTER_PREWARM", group: "app", kind: "boolean", need: "optional", fallback: "true", inApp: true, restart: true },
  { key: "VAPID_SUBJECT", group: "app", kind: "text", need: "optional", fallback: "mailto:admin@example.com", inApp: true, placeholder: "mailto:admin@example.com" },
  // ── Le déploiement : guidé, pas réglable ici ──
  { key: "TRUSTED_PROXIES", group: "deployment", kind: "text", need: "optional", fallback: "", inApp: false, placeholder: "nginx-proxy-manager" },
  // Jamais dans l'application (§81) : comment le conteneur est servi, ce que seul le déploiement sait.
  { key: "COOKIE_SECURE", group: "deployment", kind: "boolean", need: "optional", fallback: "false", inApp: false },
  { key: "TZ", group: "deployment", kind: "text", need: "optional", fallback: "", inApp: false, placeholder: "Europe/Paris" },
  { key: "MEDIA_ROOT", group: "deployment", kind: "text", need: "optional", fallback: "/mnt/media/video", inApp: false, placeholder: "/mnt/media/video" },
  { key: "APP_ADMIN_USER", group: "deployment", kind: "text", need: "optional", fallback: "admin", inApp: false },
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** Les groupes réglables, dans l'ordre de l'assistant et de la page. */
export const SETTING_GROUPS: readonly SettingGroup[] = ["jellyfin", "tmdb", "radarr", "sonarr", "jellyseerr", "qbittorrent", "bazarr", "jackett", "ratings", "playback", "subtitles", "dialogue", "app", "defaults", "deployment"];

/**
 * Le guide de déploiement : ce qui ne se règle pas dans l'application — un dossier à monter, le
 * fuseau, un compte fixé par le `.env` — avec la ligne à ajouter. Chaque entrée couvre les
 * variables de `.env.example` qu'elle explique ; `settings-couverture.test.ts` vérifie qu'aucune
 * variable n'est ni réglable, ni guidée, ni générée.
 */
export interface DeploymentGuideEntry {
  /** Libellé `setup.fields.<id>`, explication `setup.deployHint.<id>`. */
  id: string;
  keys: readonly string[];
  snippet: string;
}
export const DEPLOYMENT_GUIDE: readonly DeploymentGuideEntry[] = [
  { id: "TZ", keys: ["TZ"], snippet: "    environment:\n      - TZ=Europe/Paris" },
  {
    id: "MEDIA_ROOT",
    keys: ["MEDIA_ROOT"],
    snippet: "    volumes:\n      - /path/to/media:/mnt/media/video:ro\n    environment:\n      - MEDIA_ROOT=/mnt/media/video",
  },
  {
    id: "MEDIA_PATHS",
    keys: ["MOVIES_PATH", "TV_PATH", "SEEDS_PATH", "SEED_MOVIES_PATH", "SEED_TV_PATH", "CROSS_SEED_PATH"],
    snippet:
      "    environment:\n      - MOVIES_PATH=/mnt/media/video/movies\n      - TV_PATH=/mnt/media/video/tv\n      - SEEDS_PATH=/mnt/media/video/downloads/seeds\n      - SEED_MOVIES_PATH=/mnt/media/video/downloads/seeds/movies\n      - SEED_TV_PATH=/mnt/media/video/downloads/seeds/tv\n      - CROSS_SEED_PATH=/mnt/media/video/downloads/seeds/cross-seed-links",
  },
  {
    id: "POSTER_PREWARM_TUNING",
    keys: ["POSTER_PREWARM_WIDTHS", "POSTER_PREWARM_LOCALES"],
    snippet: "    environment:\n      - POSTER_PREWARM_WIDTHS=384,750\n      - POSTER_PREWARM_LOCALES=fr,en",
  },
  { id: "APP_ADMIN_USER", keys: ["APP_ADMIN_USER", "APP_ADMIN_PASSWORD"], snippet: "APP_ADMIN_USER=admin\nAPP_ADMIN_PASSWORD=…" },
  { id: "TRUSTED_PROXIES", keys: ["TRUSTED_PROXIES"], snippet: "    environment:\n      - TRUSTED_PROXIES=nginx-proxy-manager" },
  { id: "COOKIE_SECURE", keys: ["COOKIE_SECURE"], snippet: "    environment:\n      - COOKIE_SECURE=true" },
];

/** Générés au premier lancement (`server-boot/firstRunSecrets.mjs`) : ni affichés, ni à fournir. */
export const GENERATED_SECRETS = ["SESSION_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

/** Les services qu'on peut tester, et les réglages que le test lit. */
export const TESTABLE_GROUPS = ["jellyfin", "tmdb", "radarr", "sonarr", "jellyseerr", "qbittorrent", "bazarr", "jackett"] as const;
export type TestableGroup = (typeof TESTABLE_GROUPS)[number];

/** D'où vient une valeur. */
export type SettingSource = "app" | "env" | "default";

/** Ce que le navigateur reçoit d'un réglage — jamais un secret en clair. */
export interface SettingView {
  key: string;
  source: SettingSource;
  /** La valeur, sauf pour un secret. */
  value: string | null;
  /** Un secret : est-il renseigné, et ses quatre derniers caractères. */
  set: boolean;
  hint: string | null;
  /** `.env` en donne une : le bouton « revenir à la valeur du .env » a un sens. */
  envPresent: boolean;
}

/**
 * Ce qui manque pour terminer l'assistant : chaque réglage `required` vide — Jellyfin et TMDB. Ni
 * Radarr ni Sonarr depuis le 14/10/2026 : une installation « Jellyfin seulement » a un cinéma (§89).
 */
export function missingRequired(valueOf: (key: string) => string): string[] {
  return SETTINGS.filter((s) => s.need === "required" && !valueOf(s.key).trim()).map((s) => s.key);
}

/**
 * Ce que l'installation offrira, selon les services branchés — l'écran de fin de l'assistant le
 * résume, pour qu'un service laissé de côté se lise comme un choix et pas comme un oubli.
 */
export const SERVICE_FEATURES = [
  { id: "cinema", needs: ["JELLYFIN_API_KEY", "TMDB_API_KEY"] },
  { id: "movies", needs: ["RADARR_API_KEY"] },
  { id: "series", needs: ["SONARR_API_KEY"] },
  { id: "requests", needs: ["JELLYSEERR_API_KEY"] },
  { id: "downloads", needs: ["QBITTORRENT_URL", "QBITTORRENT_PASSWORD"] },
  { id: "subtitles", needs: ["BAZARR_API_KEY"] },
] as const;

export function availableFeatures(isSet: (key: string) => boolean): { id: (typeof SERVICE_FEATURES)[number]["id"]; available: boolean }[] {
  return SERVICE_FEATURES.map((f) => ({ id: f.id, available: f.needs.every(isSet) }));
}

/**
 * Une adresse de service est-elle utilisable ? `null` si oui, `"invalid-url"` sinon — vide comprise.
 * La même règle pour l'enregistrement (`settingProblem`) et pour « Tester la connexion » : le test
 * disait « Injoignable » d'une adresse sans `http://` que l'enregistrement refusait déjà comme
 * « Adresse invalide » (13/10/2026).
 */
export function urlProblem(value: string): "invalid-url" | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? null : "invalid-url";
  } catch {
    return "invalid-url";
  }
}
