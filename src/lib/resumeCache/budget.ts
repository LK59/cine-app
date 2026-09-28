/**
 * Ce que l'appareil garde, en octets — pas en secondes.
 *
 * Décidé le 28/09/2026, mesures en main : les deux appareils mesurés annonçaient 41 Go (iPhone,
 * application de l'écran d'accueil) et 10,8 Go (Chrome Windows) de quota, tous deux en stockage
 * persistant. Une durée ne dit rien de la place : 250 Mio font 5 min d'un film au débit médian de
 * la bibliothèque (6,4 Mb/s) et 73 s d'un 4K à 27 Mb/s. On vise donc des octets, et c'est le fichier
 * qui décide combien de temps ils couvrent.
 *
 * **La règle fondamentale : au repos, rien n'est téléchargé d'avance.** L'accueil ne prend que ce
 * qu'il faut pour *démarrer* instantanément :
 *  - un titre d'« À suivre » : l'en-tête, l'index et `OPENING_TITLE_CHUNKS` ;
 *  - un titre de « Reprendre » : l'en-tête, l'index, et de l'image clé qui précède la position
 *    jusqu'à un groupe après elle (`RESUME_MINIMAL_MAX_CHUNKS` au plus).
 * L'**avance** ne se construit que pendant une lecture (`DiskReserve`) ; à l'arrêt, elle est gardée
 * pour la reprise suivante. Au repos, elle ne peut que diminuer.
 *
 * L'avance est une **réserve commune** (`poolChunks`), partagée entre les titres *actifs* — lus sur
 * cet appareil dans les `ACTIVE_DAYS` derniers jours, les `ACTIVE_TITLES` plus récents. Au repos,
 * chacun garde au plus sa part (la réserve divisée par leur nombre). Pendant une lecture, le titre en
 * cours emprunte aux autres, jusqu'à ce qu'ils ne gardent plus que `floorChunks` chacun. Un titre qui
 * n'est plus actif redescend au minimum de démarrage.
 *
 * Un appareil à court de place (moins de `LOW_SPACE_BYTES` entre ce qu'il annonce et ce qu'il
 * occupe) passe en mode réduit. Un navigateur ne dit pas l'espace libre du disque ; le quota moins
 * l'occupation est la seule mesure qu'il donne, et c'est aussi celle qui borne réellement nos
 * écritures.
 *
 * Rien de ce qui est gardé n'est indispensable : un morceau absent, effacé par le système ou par
 * « Vider le cache », est lu au réseau (`HttpByteSource.fromDiskOrNetwork`).
 */

/** Un morceau = 1 Mio, aligné sur ceux de `HttpByteSource`. */
const MIB = 1 << 20;

/** Ce qu'un titre d'« À suivre » garde au-delà de son en-tête et de son index. */
export const OPENING_TITLE_CHUNKS = 16;
/** Le plus qu'une reprise minimale garde au-delà de son en-tête et de son index — au-delà, l'en-tête seul. */
export const RESUME_MINIMAL_MAX_CHUNKS = 64;
/** Combien de titres se partagent la réserve, au plus. */
export const ACTIVE_TITLES = 4;
/** Un titre pas lu sur cet appareil depuis plus longtemps n'a plus de part. */
export const ACTIVE_DAYS = 5;

/** En dessous, le mode réduit. */
export const LOW_SPACE_BYTES = 5e9;

export interface StorageBudget {
  mode: "normal" | "réduit";
  /** Le plafond commun, tous étages confondus, en morceaux de 1 Mio — une borne de sûreté. */
  totalChunks: number;
  /** La réserve d'avance, partagée entre les titres actifs. */
  poolChunks: number;
  /** Ce qu'un titre actif garde au moins quand un autre, en lecture, lui emprunte. */
  floorChunks: number;
  /** Ce qui est gardé derrière la tête pendant une lecture, pour les retours en arrière. */
  behindChunks: number;
}

export const NORMAL_BUDGET: StorageBudget = { mode: "normal", totalChunks: 2560, poolChunks: 1024, floorChunks: 128, behindChunks: 128 };
export const REDUCED_BUDGET: StorageBudget = { mode: "réduit", totalChunks: 750, poolChunks: 256, floorChunks: 64, behindChunks: 64 };

/**
 * Le budget pour un appareil qui annonce ce quota et cette occupation. Sans mesure (un navigateur
 * sans `estimate`), le budget normal : une écriture refusée faute de place n'est qu'un titre de
 * moins gardé.
 */
export function budgetFor(estimate: { quota?: number; usage?: number } | null): StorageBudget {
  const quota = estimate?.quota;
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0) return NORMAL_BUDGET;
  const usage = typeof estimate?.usage === "number" && Number.isFinite(estimate.usage) ? estimate.usage : 0;
  return quota - usage < LOW_SPACE_BYTES ? REDUCED_BUDGET : NORMAL_BUDGET;
}

/** Le budget de cet appareil, maintenant. Ne lève jamais. */
export async function deviceBudget(): Promise<StorageBudget> {
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!storage || typeof storage.estimate !== "function") return NORMAL_BUDGET;
    return budgetFor(await storage.estimate());
  } catch {
    return NORMAL_BUDGET;
  }
}

/** Des octets en morceaux entiers. */
export function chunksOf(bytes: number): number {
  return Math.ceil(bytes / MIB);
}

/** Ce que l'index dit d'un titre, pour décider de sa part. */
export interface ActivityEntry {
  /** Quand une lecture de ce titre s'est arrêtée sur cet appareil pour la dernière fois. */
  playedAt?: number;
}

/**
 * Les titres actifs, du plus récemment lu au moins récent : lus dans les `ACTIVE_DAYS` derniers
 * jours, les `ACTIVE_TITLES` plus récents.
 */
export function activeTitles(index: Record<string, ActivityEntry>, now: number): string[] {
  return Object.entries(index)
    .filter(([, entry]) => typeof entry.playedAt === "number" && now - entry.playedAt <= ACTIVE_DAYS * 24 * 3600_000)
    .sort((a, b) => (b[1].playedAt ?? 0) - (a[1].playedAt ?? 0))
    .slice(0, ACTIVE_TITLES)
    .map(([itemId]) => itemId);
}

/** La part d'avance d'un titre au repos : la réserve divisée entre les actifs, rien s'il ne l'est pas. */
export function restingShare(itemId: string, active: string[], budget: StorageBudget): number {
  return active.includes(itemId) ? Math.floor(budget.poolChunks / active.length) : 0;
}
