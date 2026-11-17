import { parseAudience } from "@/lib/featureAudience";
import type { AiFeatureId } from "@/lib/aiFeatureTable";
import type { SettingGroup, SettingView } from "@/lib/settings/schema";

/**
 * Où chaque réglage se montre dans la Configuration de la gestion (DECISIONS.md §142, 10/11/2026).
 *
 * **Une place par fonction.** La page « Sous-titres » tenait toutes les fonctions d'IA, « Lecture »
 * mêlait le lecteur, le hors-ligne, les livres, le Chromecast et le recadrage, et les acteurs à
 * l'écran étaient coupés en deux (leur interrupteur dans Connexions, leur analyse ailleurs). Les
 * pages lisent maintenant leurs cartes ici, et `config-layout.test.ts` vérifie que chaque réglage
 * réglable dans l'application apparaît **une fois et une seule**.
 *
 * Rien ne change au schéma (`schema.ts`) : les clés gardent leur nom, leur groupe, leur défaut. Une
 * carte prend un groupe et, au besoin, quelques-unes de ses clés — l'enregistrement par carte
 * n'envoie que ce qu'elle montre (`ConfigurationSection`). Les installations existantes ne voient
 * que la place et l'intitulé changer.
 *
 * **Une carte de fonction dit ce dont elle a besoin** (`needs`) : toujours écrit, et quand l'un
 * manque, la carte s'estompe et un lien mène à ce qui manque. Son état d'une ligne (`feature`) vient
 * du serveur quand il est connu à peu de frais (`featureStatuses`, §140).
 */

/** Ce dont une fonction a besoin pour marcher, vérifiable d'après les réglages enregistrés. */
export type ConfigNeed = "aiKey" | "xrayService" | "xrayOn" | "booksOn" | "playerOn";

/** Où se règle ce qui manque. */
export const NEED_HREF: Record<ConfigNeed, string> = {
  aiKey: "/parametres/ia#fournisseur",
  xrayService: "/parametres#xray",
  xrayOn: "/parametres/acteurs",
  booksOn: "/parametres/livres",
  playerOn: "/parametres/lecture",
};

export interface ConfigCard {
  group: SettingGroup;
  /** Seulement ces clés du groupe ; absent, toutes celles réglables dans l'application. */
  keys?: readonly string[];
  /** L'intitulé de la carte, quand elle ne montre qu'une partie de son groupe. */
  titleKey?: string;
  /** Le texte d'explication, idem. */
  whyKey?: string;
  /** Un ancre (`id`) pour qu'un lien d'une autre carte y mène. */
  anchor?: string;
  /** Ce qu'il faut pour que la fonction marche. */
  needs?: readonly ConfigNeed[];
  /**
   * Une fonction de laboratoire : réglable, mais pas encore assez fiable pour être allumée ; la carte
   * porte l'étiquette « Lab bêta » et rien d'autre ne s'appuie dessus (« Revenir au début de la scène »,
   * 10/11/2026 : la passe à l'aveugle a trouvé des renvois trop tôt et ~1,5 % de reprises couvertes).
   */
  lab?: boolean;
  /** La fonction dont la carte montre l'état (`/api/subtitle-gen/admin` → `features`). */
  feature?: AiFeatureId;
  /** Une carte au contenu propre : le fournisseur d'IA (modèle prérempli, dépense, tableau). */
  special?: "aiProvider";
  /** Ce qui suit la carte : les tâches des sous-titres générés. */
  after?: "subtitleJobs";
}

const AI_PROVIDER_KEYS = [
  "SUBTITLE_GEN_PROVIDER",
  "SUBTITLE_GEN_API_KEY",
  "SUBTITLE_GEN_MODEL",
  "SUBTITLE_GEN_BUDGET_USD",
  "SUBTITLE_GEN_PRICE_INPUT",
  "SUBTITLE_GEN_PRICE_OUTPUT",
] as const;

const aiFeature = (feature: AiFeatureId, setting: string, needs: readonly ConfigNeed[]): ConfigCard => ({
  group: "subtitles",
  keys: [setting],
  titleKey: `aiFeatures.names.${feature}`,
  whyKey: `aiFeatures.what.${feature}`,
  anchor: feature,
  needs,
  feature,
});

/** Les cartes de chaque page, dans l'ordre de la page. */
export const CONFIG_LAYOUT = {
  /** Connexions : les services seulement — adresse et clé —, et ce que l'application publie. */
  connections: [
    { group: "jellyfin" },
    { group: "tmdb" },
    { group: "radarr" },
    { group: "sonarr" },
    { group: "jellyseerr" },
    { group: "qbittorrent" },
    { group: "bazarr" },
    { group: "jackett" },
    { group: "ratings" },
    // Le service des acteurs à l'écran (§138) : son adresse et sa clé. La fonction elle-même — à qui
    // elle est ouverte — se règle dans Fonctions intelligentes → Acteurs à l'écran.
    { group: "xray", keys: ["XRAY_URL", "XRAY_API_KEY"], anchor: "xray" },
    // Les salons du chalet (§146) : le service, son adresse et sa clé, et à qui le jeu à plusieurs est ouvert —
    // une seule carte : sans service, l'interrupteur n'a rien à allumer.
    { group: "salons", keys: ["SALONS_ENABLED", "SALONS_URL", "SALONS_KEY"], anchor: "salons" },
    { group: "app", keys: ["POSTER_PREWARM", "VAPID_SUBJECT"] },
  ],
  /** Lecture : le lecteur intégré et son relais vers Jellyfin, rien d'autre. */
  playback: [{ group: "playback", keys: ["PLAYER_ENABLED", "PLAYER_SERVER_FALLBACK"] }],
  /** Diffusion et hors-ligne : le Chromecast, puis les téléchargements. */
  diffusion: [
    { group: "playback", keys: ["CHROMECAST_FOR_EVERYONE", "CAST_RECEIVER_APP_ID"], titleKey: "config.cast.title", whyKey: "config.cast.why" },
    {
      group: "playback",
      keys: ["OFFLINE_DOWNLOADS", "OFFLINE_DOWNLOADS_FOR_EVERYONE", "OFFLINE_SERVER_QUOTA_GB"],
      titleKey: "config.offline.title",
      whyKey: "config.offline.why",
    },
  ],
  /** Livres (§127) : l'option, puis ce qui ne marche qu'avec elle. */
  books: [
    { group: "playback", keys: ["BOOKS_ENABLED"], titleKey: "config.books.title", whyKey: "config.books.why", anchor: "livres" },
    { group: "playback", keys: ["BOOKS_REQUESTS_ENABLED"], titleKey: "config.bookRequests.title", whyKey: "config.bookRequests.why", needs: ["booksOn"] },
    {
      group: "playback",
      keys: ["BOOKS_GOOGLE_ENRICH", "GOOGLE_BOOKS_API_KEY"],
      titleKey: "config.googleBooks.title",
      whyKey: "config.googleBooks.why",
      needs: ["booksOn"],
    },
  ],
  /**
   * Intelligence artificielle : le fournisseur commun (§140 — les clés `SUBTITLE_GEN_*` gardent le
   * nom qu'elles avaient quand les sous-titres étaient seuls à s'en servir), puis chaque fonction qui
   * s'en sert.
   */
  aiProvider: [{ group: "subtitles", keys: AI_PROVIDER_KEYS, titleKey: "config.ai.providerTitle", anchor: "fournisseur", special: "aiProvider" }],
  aiFeatures: [
    { ...aiFeature("subtitles", "SUBTITLE_GEN_ENABLED", ["aiKey"]), after: "subtitleJobs" },
    aiFeature("describe", "DESCRIBE_SEARCH_ENABLED", ["aiKey"]),
    aiFeature("recap", "RECAP_ENABLED", ["aiKey"]),
    aiFeature("askTitle", "ASK_ENABLED", ["aiKey"]),
    aiFeature("askPerson", "ASK_PERSON_ENABLED", ["aiKey", "xrayService", "xrayOn"]),
    aiFeature("sofar", "SOFAR_ENABLED", ["aiKey", "xrayService", "xrayOn"]),
  ],
  /** Acteurs à l'écran : à qui la fonction est ouverte ; l'analyse et la qualité suivent (cartes propres). */
  xray: [
    {
      group: "xray",
      keys: ["XRAY_ENABLED"],
      titleKey: "config.xray.featureTitle",
      whyKey: "config.xray.featureWhy",
      anchor: "acteurs",
      needs: ["xrayService"],
      feature: "xray",
    },
    // « Revenir au début de la scène » (§143) : coupé et marqué « Lab bêta » — les débuts de scène ne sont
    // pas encore assez sûrs (passe à l'aveugle du 10/11/2026) ; à rallumer seulement après une validation.
    {
      group: "xray",
      keys: ["SCENE_RESTART_ENABLED"],
      titleKey: "config.sceneRestart.title",
      whyKey: "config.sceneRestart.why",
      needs: ["xrayService", "xrayOn"],
      lab: true,
    },
  ],
  /** Recadrage automatique : agrandir l'image au-dessus des bandes noires (lecteur intégré). */
  autoFrame: [{ group: "playback", keys: ["PLAYER_AUTO_FRAME"], titleKey: "config.autoFrame.title", whyKey: "config.autoFrame.why", needs: ["playerOn"] }],
  /** Nouveaux comptes : ce que reçoit un compte qui n'a rien choisi. */
  accounts: [{ group: "defaults" }],
} as const satisfies Record<string, readonly ConfigCard[]>;

/**
 * Les groupes que montre une carte propre plutôt que `ConfigurationSection` : la recherche de
 * répliques (`DialogueSearchCard`, qui enregistre ses clés elle-même — §88).
 */
export const CUSTOM_CARD_GROUPS: readonly SettingGroup[] = ["dialogue"];

/** Une clé de réglage est-elle renseignée, d'après la vue enregistrée ? */
function filled(views: ReadonlyMap<string, SettingView>, key: string): boolean {
  const v = views.get(key);
  if (!v) return false;
  return v.set || (v.value ?? "").trim() !== "";
}

/**
 * Ce qui manque à une carte, d'après les réglages **enregistrés** (un brouillon non enregistré ne
 * rend rien prêt). Mêmes règles que le serveur : `xrayConfigured` (adresse + clé + allumé),
 * `featureSettings().hasKey`, `config.player.enabled`, `config.books.enabled`.
 */
export function missingNeeds(needs: readonly ConfigNeed[] | undefined, views: ReadonlyMap<string, SettingView>): ConfigNeed[] {
  if (!needs || views.size === 0) return [];
  return needs.filter((need) => {
    switch (need) {
      case "aiKey":
        return !filled(views, "SUBTITLE_GEN_API_KEY");
      case "xrayService":
        return !filled(views, "XRAY_URL") || !filled(views, "XRAY_API_KEY");
      case "xrayOn":
        return parseAudience(views.get("XRAY_ENABLED")?.value) === "off";
      case "booksOn":
        return views.get("BOOKS_ENABLED")?.value !== "true";
      case "playerOn":
        return views.get("PLAYER_ENABLED")?.value !== "true";
    }
  });
}
