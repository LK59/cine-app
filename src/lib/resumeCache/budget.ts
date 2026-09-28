/**
 * Ce que l'appareil garde, en octets — pas en secondes.
 *
 * Décidé le 28/09/2026, mesures en main : les deux appareils mesurés annonçaient 41 Go (iPhone,
 * application de l'écran d'accueil) et 10,8 Go (Chrome Windows) de quota, tous deux en stockage
 * persistant. Une durée ne dit rien de la place : 128 Mio font 2 min 40 d'un film au débit médian
 * de la bibliothèque (6,4 Mb/s) et 40 s d'un 4K à 27 Mb/s. On vise donc des octets, et c'est le
 * fichier qui décide combien de temps ils couvrent.
 *
 * Trois étages, chacun borné par titre, et tous sous un plafond commun :
 *  - **l'ouverture** — un titre pas encore commencé (« À suivre ») : l'en-tête, l'index, et
 *    `OPENING_TITLE_CHUNKS` depuis l'image clé de départ ;
 *  - **la reprise** — un titre commencé (« Reprendre ») : l'en-tête, l'index, et
 *    `STARTED_TITLE_CHUNKS` depuis l'image clé qui précède la position ;
 *  - **le tampon** — la séance en cours (à venir) : `bufferChunks`.
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

/** Ce qu'un titre commencé garde au-delà de son en-tête et de son index. */
export const STARTED_TITLE_CHUNKS = 128;
/** Ce qu'un titre pas encore commencé garde au-delà de son en-tête et de son index. */
export const OPENING_TITLE_CHUNKS = 16;

/** En dessous, le mode réduit. */
export const LOW_SPACE_BYTES = 5e9;

export interface StorageBudget {
  mode: "normal" | "réduit";
  /** Le plafond commun, tous étages confondus, en morceaux de 1 Mio. */
  totalChunks: number;
  /** Ce que le tampon de la séance peut prendre. */
  bufferChunks: number;
  /** Ce que l'ouverture et la reprise se partagent. */
  resumeChunks: number;
}

export const NORMAL_BUDGET: StorageBudget = { mode: "normal", totalChunks: 2560, bufferChunks: 1280, resumeChunks: 768 };
export const REDUCED_BUDGET: StorageBudget = { mode: "réduit", totalChunks: 750, bufferChunks: 256, resumeChunks: 480 };

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
