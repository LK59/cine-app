/**
 * Ce que l'appareil garde, en octets — pas en secondes : **de quoi démarrer, rien de plus.**
 *
 * - un titre d'« À suivre » : l'en-tête, l'index et `OPENING_TITLE_CHUNKS` ;
 * - un titre de « Reprendre » : l'en-tête, l'index, et de l'image clé qui précède la position
 *   jusqu'à un groupe après elle (`RESUME_MINIMAL_MAX_CHUNKS` au plus).
 *
 * Au repos, rien n'est téléchargé d'avance ; pendant une lecture, l'avance vit **en mémoire**
 * (`MemoryReserve`), jamais sur l'appareil. Une réserve d'avance écrite dans l'OPFS a existé le
 * 28/09/2026 au matin (`DiskReserve`) : presque chaque octet regardé passait une fois par la mémoire
 * flash — de l'ordre de 12 Go par heure de 4K. Retirée le jour même, pour la santé des appareils ; ce
 * qu'elle avait laissé est ramené au minimum par le passage d'arrière-plan.
 *
 * Mesures du 28/09/2026 : 41 Go de quota sur l'iPhone (application de l'écran d'accueil), 10,8 Go
 * sur Chrome Windows, tous deux en stockage persistant. Un appareil à court de place (moins de
 * `LOW_SPACE_BYTES` entre ce qu'il annonce et ce qu'il occupe) passe en mode réduit. Un navigateur ne
 * dit pas l'espace libre du disque ; le quota moins l'occupation est la seule mesure qu'il donne.
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

/** En dessous, le mode réduit. */
export const LOW_SPACE_BYTES = 5e9;

export interface StorageBudget {
  mode: "normal" | "réduit";
  /** Le plafond de sûreté, tous titres confondus, en morceaux de 1 Mio. */
  totalChunks: number;
}

export const NORMAL_BUDGET: StorageBudget = { mode: "normal", totalChunks: 1024 };
export const REDUCED_BUDGET: StorageBudget = { mode: "réduit", totalChunks: 512 };

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

/**
 * L'occupation que le navigateur mesure, au-delà de laquelle plus rien n'est écrit : le plafond commun,
 * plus une marge pour le reste du site (catalogue, code). Un garde-fou sur la mesure réelle, pas sur
 * nos comptes — ce sont nos comptes qui s'étaient trompés le 28/09/2026 (`exactBytes`).
 */
export function overQuota(usageBytes: number | null | undefined, budget: StorageBudget): boolean {
  return typeof usageBytes === "number" && Number.isFinite(usageBytes) && usageBytes > budget.totalChunks * MIB + 256 * MIB;
}

/** L'occupation du site selon le navigateur, ou null. Ne lève jamais. */
export async function deviceUsage(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return typeof estimate?.usage === "number" ? estimate.usage : null;
  } catch {
    return null;
  }
}
