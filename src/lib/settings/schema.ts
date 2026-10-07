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
 * - `need` : `required` (le cinéma ne fonctionne pas sans), `library` (au moins Radarr ou Sonarr),
 *   ou `optional` (enrichit l'interface).
 */

export type SettingKind = "url" | "secret" | "text" | "boolean" | "select" | "profile";
export type SettingNeed = "required" | "library" | "optional";
export type SettingGroup = "jellyfin" | "tmdb" | "radarr" | "sonarr" | "jellyseerr" | "qbittorrent" | "bazarr" | "jackett" | "ratings" | "playback" | "app" | "defaults" | "deployment";

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
}

export const SETTINGS: readonly SettingDef[] = [
  // ── L'indispensable ──
  { key: "JELLYFIN_URL", group: "jellyfin", kind: "url", need: "required", fallback: "http://jellyfin:8096", inApp: true, placeholder: "http://jellyfin:8096" },
  { key: "JELLYFIN_API_KEY", group: "jellyfin", kind: "secret", need: "required", fallback: "", inApp: true },
  { key: "JELLYFIN_PUBLIC_URL", group: "jellyfin", kind: "url", need: "optional", fallback: "", inApp: true, placeholder: "https://jellyfin.example.com" },
  { key: "TMDB_API_KEY", group: "tmdb", kind: "secret", need: "required", fallback: "", inApp: true },
  { key: "RADARR_URL", group: "radarr", kind: "url", need: "library", fallback: "http://radarr:7878", inApp: true, placeholder: "http://radarr:7878" },
  { key: "RADARR_API_KEY", group: "radarr", kind: "secret", need: "library", fallback: "", inApp: true },
  { key: "RADARR_QUALITY_PROFILE", group: "radarr", kind: "profile", need: "optional", fallback: "", inApp: true },
  { key: "SONARR_URL", group: "sonarr", kind: "url", need: "library", fallback: "http://sonarr:8989", inApp: true, placeholder: "http://sonarr:8989" },
  { key: "SONARR_API_KEY", group: "sonarr", kind: "secret", need: "library", fallback: "", inApp: true },
  { key: "SONARR_QUALITY_PROFILE", group: "sonarr", kind: "profile", need: "optional", fallback: "", inApp: true },
  // ── Ce qui enrichit ──
  { key: "JELLYSEERR_URL", group: "jellyseerr", kind: "url", need: "optional", fallback: "http://jellyseerr:5055", inApp: true, placeholder: "http://jellyseerr:5055" },
  { key: "JELLYSEERR_API_KEY", group: "jellyseerr", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "QBITTORRENT_URL", group: "qbittorrent", kind: "url", need: "optional", fallback: "http://gluetun:8080", inApp: true, placeholder: "http://qbittorrent:8080" },
  { key: "QBITTORRENT_USERNAME", group: "qbittorrent", kind: "text", need: "optional", fallback: "admin", inApp: true },
  { key: "QBITTORRENT_PASSWORD", group: "qbittorrent", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "BAZARR_URL", group: "bazarr", kind: "url", need: "optional", fallback: "http://bazarr:6767", inApp: true, placeholder: "http://bazarr:6767" },
  { key: "BAZARR_API_KEY", group: "bazarr", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "JACKETT_URL", group: "jackett", kind: "url", need: "optional", fallback: "http://jackett:9117", inApp: true, placeholder: "http://jackett:9117" },
  { key: "JACKETT_API_KEY", group: "jackett", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "OMDB_API_KEY", group: "ratings", kind: "secret", need: "optional", fallback: "", inApp: true },
  { key: "MDBLIST_API_KEY", group: "ratings", kind: "secret", need: "optional", fallback: "", inApp: true },
  // ── L'application ──
  { key: "APP_LANGUAGE", group: "app", kind: "select", need: "optional", fallback: "en", inApp: true, options: ["fr", "en", "es", "de"] },
  { key: "COOKIE_SECURE", group: "app", kind: "boolean", need: "optional", fallback: "false", inApp: true },
  { key: "PLAYER_ENABLED", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "PLAYER_SERVER_FALLBACK", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "PLAYER_AUTO_FRAME", group: "playback", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // La disposition de l'accueil (07/10/2026, DECISIONS.md §52) — deux variantes d'une installation à
  // l'autre, sans fourche du code : un accès direct à tout le catalogue en tête, et une bannière
  // qui montre ce qu'on regarde plutôt que ce qui vient d'arriver. « Réglages par défaut » : ce que
  // voit un compte qui n'a rien choisi — chacun peut le changer dans Compte → Interface. Les deux
  // sont activés par défaut depuis le 07/10/2026 : le bouton, discret en haut à droite sur
  // téléphone ; les reprises en tête de la bannière, que « À la une » complète quand elles sont peu.
  { key: "HOME_BROWSE_BUTTON", group: "defaults", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "HOME_CONTINUE_HERO", group: "defaults", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  // Lu au démarrage seulement : son libellé le dit (« au prochain démarrage »).
  { key: "POSTER_PREWARM", group: "app", kind: "boolean", need: "optional", fallback: "true", inApp: true },
  { key: "VAPID_SUBJECT", group: "app", kind: "text", need: "optional", fallback: "mailto:admin@example.com", inApp: true, placeholder: "mailto:admin@example.com" },
  // ── Le déploiement : guidé, pas réglable ici ──
  { key: "TZ", group: "deployment", kind: "text", need: "optional", fallback: "", inApp: false, placeholder: "Europe/Paris" },
  { key: "MEDIA_ROOT", group: "deployment", kind: "text", need: "optional", fallback: "/mnt/media/video", inApp: false, placeholder: "/mnt/media/video" },
  { key: "APP_ADMIN_USER", group: "deployment", kind: "text", need: "optional", fallback: "admin", inApp: false },
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** Les groupes réglables, dans l'ordre de l'assistant et de la page. */
export const SETTING_GROUPS: readonly SettingGroup[] = ["jellyfin", "tmdb", "radarr", "sonarr", "jellyseerr", "qbittorrent", "bazarr", "jackett", "ratings", "playback", "app", "defaults", "deployment"];

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
    id: "CLARA_GALLERY",
    keys: ["CLARA_GALLERY_ENABLED"],
    snippet: "    volumes:\n      - /path/to/photos:/app/gallery/clara:ro\n    environment:\n      - CLARA_GALLERY_ENABLED=true",
  },
  {
    id: "POSTER_PREWARM_TUNING",
    keys: ["POSTER_PREWARM_WIDTHS", "POSTER_PREWARM_LOCALES"],
    snippet: "    environment:\n      - POSTER_PREWARM_WIDTHS=384,750\n      - POSTER_PREWARM_LOCALES=fr,en",
  },
  { id: "APP_ADMIN_USER", keys: ["APP_ADMIN_USER", "APP_ADMIN_PASSWORD"], snippet: "APP_ADMIN_USER=admin\nAPP_ADMIN_PASSWORD=…" },
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
 * Ce qui manque pour terminer l'assistant : chaque réglage `required` vide, et — si ni Radarr ni
 * Sonarr n'a de clé — la paire `library`.
 */
export function missingRequired(valueOf: (key: string) => string): string[] {
  const missing = SETTINGS.filter((s) => s.need === "required" && !valueOf(s.key).trim()).map((s) => s.key);
  if (!valueOf("RADARR_API_KEY").trim() && !valueOf("SONARR_API_KEY").trim()) missing.push("RADARR_API_KEY|SONARR_API_KEY");
  return missing;
}
