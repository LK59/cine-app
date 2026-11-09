// Deux journaux de plus, pour la page d'activité : les connexions et les notifications.
//
// Ni l'un ni l'autre n'existait. Un compte dont on avait réinitialisé le mot de passe plusieurs
// fois ne laissait aucune trace de ses tentatives, et une notification partie — ou refusée par un
// abonnement expiré — ne se lisait nulle part (24/09/2026). Même forme que les autres journaux :
// une ligne JSON par événement, tournée à 5 Mo (`logFile.ts`), vingt archives chacun.

import path from "node:path";
import { LOG_DIR, appendJsonLine } from "@/lib/logFile";

export const AUTH_LOG = () => path.join(LOG_DIR, "auth.log");
export const NOTIFICATIONS_LOG = () => path.join(LOG_DIR, "notifications.log");
export const EVENT_LOG_KEEP = 20;

/**
 * Chaque ouverture du cinéma : depuis le cache de l'appareil ou depuis le réseau, et en combien de
 * temps (25/09/2026). Le cache du catalogue promettait des affiches dès l'ouverture plutôt qu'après
 * une à deux secondes d'itinérance : ce journal dit ce qu'il fait gagner, au lieu de le supposer.
 */
export const STARTUP_LOG = () => path.join(LOG_DIR, "startup.log");

/** Ne lève jamais : une mesure perdue ne coûte rien à personne. */
export function logStartupTiming(fields: {
  user: string;
  device: string | null;
  build: string | null;
  /** La version de package.json que le navigateur exécutait, à côté du build. */
  version: string | null;
  cacheUsed: boolean;
  cacheAgeMs: number | null;
  cacheMs: number | null;
  networkMs: number | null;
  /** Le démarrage du code : quand la lecture du cache commence (depuis la navigation). */
  bootMs?: number | null;
  /** La lecture d'IndexedDB elle-même, du début à la fin. */
  idbMs?: number | null;
  /** L'arrivée de « Reprendre » par le réseau (depuis la navigation). */
  resumeNetworkMs?: number | null;
  /** Quand la page est passée en arrière-plan avant la fin de l'ouverture — mesures d'après omises. */
  hiddenAtMs?: number;
  /** « Reprendre » dessiné depuis l'appareil, puis corrigé par le réseau — voir `noteContinueReconciled`. */
  resumeFromCache?: boolean;
  resumeAdded?: number;
  resumeRemoved?: number;
  resumeMoved?: number;
  resumeProgressed?: number;
  standalone: boolean;
  /**
   * L'application installée, hors de la vue intégrée qu'ouvre un lien de passage (`isInstalledApp`,
   * 25/10/2026) — `standalone` s'y dit vrai sur iPhone. Absent des lignes d'avant.
   */
  installedApp?: boolean;
  /**
   * Le nom d'hôte par lequel l'application a été ouverte (23/10/2026, DECISIONS.md §119), lu par le
   * serveur (`requestHost`), jamais envoyé par le navigateur : l'ancienne ou la nouvelle adresse.
   * Absent des lignes d'avant, et d'une requête dont l'hôte n'est pas un nom valide.
   */
  host?: string;
  /** Le stockage de l'appareil — voir `storageFacts` (persistentCache.ts). */
  persist?: string;
  persisted?: boolean;
  quotaMB?: number;
  usageMB?: number;
  idbMB?: number;
  cacheMB?: number;
  opfsMB?: number;
  resumeTitles?: number;
  resumeMB?: number;
  storageTimedOut?: boolean;
  storageMode?: string;
  /** Les requêtes de l'ouverture vues par le navigateur — voir `routeTimingsOf` (persistentCache.ts). */
  routes?: Record<string, Record<string, number>>;
}): void {
  try {
    appendJsonLine(STARTUP_LOG(), { timestamp: new Date().toISOString(), kind: "ouverture", ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

/**
 * Ce qu'une télécommande de Fire TV envoie vraiment (10/10/2026) — voir `installRemoteDiag`
 * (fireTv.ts). Une ligne par mode de Silk (trois par onglet au plus), dans le journal des
 * ouvertures : les premières touches et le curseur, pour savoir si Silk navigue au curseur ou aux flèches au lieu de le supposer.
 */
export function logRemoteDiag(fields: { user: string; device: string | null } & Record<string, unknown>): void {
  try {
    appendJsonLine(STARTUP_LOG(), { timestamp: new Date().toISOString(), kind: "télécommande", ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

/** Le relevé de hauteur de l'application installée sur iOS (`viewportWatch.ts`), dans le journal des ouvertures. */
export function logViewportDiag(fields: { user: string; device: string | null } & Record<string, unknown>, kind: "hauteur" | "retour" | "clavier" = "hauteur"): void {
  try {
    appendJsonLine(STARTUP_LOG(), { timestamp: new Date().toISOString(), kind, ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

/**
 * La recherche par description (DECISIONS.md §135, 07/11/2026) : une ligne par phrase envoyée — compte,
 * appareil, nombre de mots, délai, cache ou appel au modèle (le seul qui coûte), titres reconnus et
 * gardés. **Jamais la phrase elle-même** : ce que chacun cherche ne regarde que lui.
 */
export const SEARCH_LOG = () => path.join(LOG_DIR, "recherche.log");

export function logDescribeSearch(fields: {
  user: string;
  device: string | null;
  words: number;
  status: "ok" | "erreur" | "limite";
  ms: number;
  /** Absent : la réponse venait du cache. */
  modelMs?: number;
  titles?: number;
  results?: number;
  inLibrary?: number;
}): void {
  try {
    appendJsonLine(SEARCH_LOG(), { timestamp: new Date().toISOString(), kind: "description", source: fields.modelMs === undefined ? "cache" : "modèle", ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

/**
 * Un « Précédemment » préparé (DECISIONS.md §137) — dans le même journal que la recherche par
 * description : ce sont les deux appels payants au modèle. Le compte pour qui il a été préparé, la
 * série et l'endroit, ce que le modèle a lu (`dialogues` ou les seuls résumés), et le verdict ;
 * jamais le texte lui-même, qui est en base.
 */
export function logRecap(fields: {
  user: string;
  series: string;
  episode: string;
  minute: number;
  /** `gardé` : le modèle a jugé que rien d'important n'était arrivé depuis le texte précédent ; `officiel` : le résumé Jellyfin tel quel, sans modèle. */
  status: "ok" | "gardé" | "officiel" | "rejeté" | "vide" | "erreur" | "limite";
  source?: "dialogues" | "résumés";
  ms: number;
  inTokens?: number;
  outTokens?: number;
  /** Les noms que les sources ne contiennent pas — la raison d'un rejet. */
  names?: string[];
}): void {
  try {
    appendJsonLine(SEARCH_LOG(), { timestamp: new Date().toISOString(), kind: "précédemment", ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

/**
 * « Poser une question » (DECISIONS.md §139) : une ligne par question, dans le journal des appels payants
 * au modèle — compte, appareil, élément, d'où (fiche ou lecteur), la tranche de dix minutes de la position,
 * le délai et les jetons, le verdict. **Jamais la question ni la réponse** : ce que chacun demande ne
 * regarde que lui.
 */
export function logAskQuestion(fields: {
  user: string;
  device: string | null;
  itemId: string;
  where: "fiche" | "lecteur";
  /** La tranche de dix minutes (0, 10, 20…), `null` sans position. */
  bucket: number | null;
  status: "ok" | "rejeté" | "limite" | "erreur" | "indisponible";
  ms: number;
  /** Jusqu'au premier morceau de réponse rendu à l'écran. */
  firstMs?: number;
  inTokens?: number;
  outTokens?: number;
  /** Des dialogues sont partis ; `attente` : ils n'étaient pas prêts à temps. */
  dialogue?: boolean | "attente";
  /** Combien de résumés d'épisodes vus sont partis. */
  episodes?: number;
  /** Le rang de la question dans l'ouverture du panneau (1 à 5). */
  turn?: number;
}): void {
  try {
    appendJsonLine(SEARCH_LOG(), { timestamp: new Date().toISOString(), kind: "question", ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

/**
 * L'usage de « Précédemment » (DECISIONS.md §137), au journal des ouvertures : `affiché` à chaque
 * ouverture d'une fiche qui le montre — avec depuis quand la série n'a pas été regardée —, `synopsis`
 * quand on lui préfère le synopsis. De quoi dire, après quelques semaines, s'il sert ; jamais le texte.
 */
export function logRecapView(event: "affiché" | "synopsis", fields: { user: string; device: string | null } & Record<string, unknown>): void {
  try {
    appendJsonLine(STARTUP_LOG(), { timestamp: new Date().toISOString(), kind: "précédemment", event, ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* une mesure perdue ne coûte rien à personne */
  }
}

/**
 * Les Nouveautés (DECISIONS.md §73) : la fenêtre (combien de temps elle est restée à l'écran, page
 * visible seulement, et comment elle s'est fermée), « Voir plus », et la page Compte → Nouveautés.
 * Dans le journal des ouvertures, parce que c'en est un moment : la fenêtre ne s'ouvre qu'au lancement.
 */
export type NewsLogEvent = "fenêtre" | "voir-plus" | "page";

export function logNewsEvent(event: NewsLogEvent, fields: { user: string; device: string | null; build: string | null; version: string | null } & Record<string, unknown>): void {
  try {
    appendJsonLine(STARTUP_LOG(), { timestamp: new Date().toISOString(), kind: "nouveautés", event, ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* une mesure perdue ne coûte rien à personne */
  }
}

export type AuthEvent =
  /** Connexion réussie. */
  | "login"
  /** Mot de passe refusé, compte inconnu, serveur injoignable. */
  | "login-failed"
  /** « Se déconnecter ». */
  | "logout"
  /** « Déconnecter tous les autres ». */
  | "others-closed"
  /** Fermée par l'administrateur depuis l'activité. */
  | "closed-by-admin"
  /** Fermée parce que Jellyfin refusait son jeton (mot de passe changé). */
  | "token-refused"
  /** Sessions expirées effacées au passage d'une connexion. */
  | "expired"
  /** Appareils « CineApp » inactifs depuis trente jours supprimés chez Jellyfin (`jellyfinDevicePrune.ts`). */
  | "devices-pruned"
  /** Mot de passe du compte administrateur de l'assistant changé (les autres sessions fermées). */
  | "password-changed"
  /** Tags bloqués posés d'office sur un compte Jellyfin découvert (`newAccountTags.ts`). */
  | "new-account-tags"
  // Les liens de partage (DECISIONS.md §112).
  | "share-created"
  | "share-redeemed"
  | "share-refused"
  | "share-revoked"
  | "share-extended"
  | "share-expired"
  | "share-deleted"
  // Le passage d'une adresse à l'autre (DECISIONS.md §119) : demandé sur l'ancienne, reçu sur la
  // nouvelle, refusé (secret inconnu, expiré ou déjà servi — sans dire lequel), freiné (trop d'essais).
  | "passage-requested"
  | "passage-received"
  | "passage-refused"
  | "passage-blocked";

/** Ne lève jamais : un journal qui échoue ne doit pas empêcher quelqu'un de se connecter. */
export function logAuthEvent(kind: AuthEvent, fields: { user: string; device?: string | null; ip?: string | null } & Record<string, unknown>): void {
  try {
    // `kind` écrit en dernier aussi : un champ du même nom (le passage écrivait `kind: "code"`, §119)
    // remplaçait l'événement, et la ligne devenait illisible pour l'activité.
    appendJsonLine(AUTH_LOG(), Object.assign({ timestamp: new Date().toISOString(), kind }, fields, { kind }), { keep: EVENT_LOG_KEEP });
  } catch {
    /* le disque plein ne doit pas bloquer une connexion */
  }
}

/**
 * Les lectures de livres (option, DECISIONS.md §129) : une ligne par séance de lecture — le lecteur
 * l'envoie en se refermant ou quand la page passe en arrière-plan — et une ligne quand un livre est
 * terminé pour la première fois ou retiré de « Continuer la lecture ». Rien ne disait qui lisait quoi,
 * combien de temps ni sur quel appareil : la position seule (`book_progress`) ne garde que la dernière
 * page. Même forme que les autres journaux, vingt archives ; lu par l'activité (« Lectures »).
 */
export const READINGS_LOG = () => path.join(LOG_DIR, "lectures.log");

export type ReadingEvent =
  /** Une séance de lecture, page visible : durée, avancement, pages tournées. */
  | "séance"
  /** Le livre terminé la première fois (noté « lu » chez Jellyfin au même moment). */
  | "terminé"
  /** « Retirer de Continuer la lecture », depuis la fiche. */
  | "retiré"
  /** « Marquer comme lu » / « Marquer comme non lu », depuis la fiche (29/10/2026). */
  | "marqué lu"
  | "marqué non lu";

/** Ne lève jamais : une lecture se poursuit, journal ou pas. */
export function logReadingEvent(kind: ReadingEvent, fields: { user: string; account: string; book: string } & Record<string, unknown>): void {
  try {
    // `kind` posé en dernier aussi, comme `logAuthEvent` : aucun champ ne le remplace.
    appendJsonLine(READINGS_LOG(), Object.assign({ timestamp: new Date().toISOString(), kind }, fields, { kind }), { keep: EVENT_LOG_KEEP });
  } catch {
    /* un disque qui refuse une note n'interrompt pas une lecture */
  }
}

/** Une notification envoyée : à qui, et ce qu'il en est advenu, appareil par appareil. */
export function logNotificationSent(fields: {
  category: string | null;
  title: string;
  body: string;
  /** Par compte : envoyées, refusées (abonnement expiré, retiré), écartées par ses réglages. */
  recipients: { user: string; sent: number; failed: number; removed: number; muted: boolean }[];
}): void {
  try {
    appendJsonLine(
      NOTIFICATIONS_LOG(),
      { timestamp: new Date().toISOString(), kind: fields.category ?? "sans catégorie", ...fields },
      { keep: EVENT_LOG_KEEP }
    );
  } catch {
    /* une notification partie reste partie, journal ou pas */
  }
}
