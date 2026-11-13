import { getDiskStats } from "@/lib/disk-stats";
import { getStorageStats } from "@/lib/storage-scan";
import { readDiskSamples, slopeFromSamples, SAMPLE_WINDOW_DAYS, MIN_SAMPLE_SPAN_DAYS, type DiskSample } from "@/lib/diskSamples";
import { logError } from "@/lib/logger";

// Below this, a slope is just measurement noise — showing a "347 days left" estimate off a
// couple of near-empty months would be more misleading than saying nothing.
const MIN_GROWTH_BYTES_PER_DAY = 50 * 1024 * 1024; // 50 MB/day
const AVG_DAYS_PER_MONTH = 30.44;
// How many recent complete months feed the average — long enough to smooth over one unusually
// quiet or heavy month, short enough to still reflect current habits rather than the library's
// entire history.
const MONTHS_FOR_AVERAGE = 3;

export type ForecastTrend = "growing" | "stable" | "insufficient_data";

/**
 * D'où vient la pente (13/11/2026, DECISIONS.md §153) : `samples`, les relevés quotidiens de
 * l'occupation réelle du disque (`diskSamples.ts`) ; `imports`, la taille des fichiers importés
 * chaque mois — remplacements compris, donc trop pessimiste —, tant qu'il n'y a pas assez de relevés.
 * `null` quand aucune pente n'a été calculée (en cours, ou rien à lire).
 */
export type ForecastMethod = "samples" | "imports";

export interface DiskForecast {
  trend: ForecastTrend;
  growthBytesPerDay: number | null;
  daysUntilFull: number | null;
  monthlyGrowth: { month: string; bytes: number }[];
  monthsUsed: number;
  method: ForecastMethod | null;
  /** L'écart en jours couvert par les relevés quotidiens retenus (0 sans relevé). */
  sampleDays: number;
  /** Combien de jours de relevés il faut avant de passer à la pente mesurée. */
  minSampleDays: number;
  /**
   * L'analyse du stockage ou la mesure du disque n'a pas encore rendu son premier résultat
   * (13/11/2026). Les deux tournent en arrière-plan et répondent vide d'ici là : la prévision
   * tombait alors dans « insufficient_data », que la page traduit « Historique insuffisant —
   * revient dans quelques jours » — c'était le message vu à chaque ouverture après un déploiement,
   * pour une analyse qui finit en une dizaine de secondes. `pending` dit « en cours » et fait
   * revenir la page vite (`statsRefreshInterval`).
   */
  pending: boolean;
}

/** Les relevés de la fenêtre, ou aucun si la base refuse : la prévision retombe alors sur les imports. */
function samplesOrNone(): DiskSample[] {
  try {
    return readDiskSamples(SAMPLE_WINDOW_DAYS);
  } catch (err) {
    logError("disk-forecast", err);
    return [];
  }
}

/**
 * La prévision de saturation.
 *
 * **D'abord la pente des relevés quotidiens** (DECISIONS.md §153) : ce que le disque occupe vraiment,
 * jour après jour, par moindres carrés sur les trois derniers mois — dès quatorze jours de relevés
 * (`MIN_SAMPLE_SPAN_DAYS`, le pourquoi y est écrit). Un remplacement par une meilleure version n'y
 * compte que pour sa différence de taille, une suppression y compte en moins.
 *
 * **À défaut, la méthode des imports** — derives a saturation forecast straight from what's already
 * on disk, how many GB got added per month, available the moment the storage scan itself has run
 * once. « Ajouté » veut dire importé par Radarr/Sonarr ce mois-là (date d'ajout du fichier), et non
 * modifié ce mois-là : un réencodage FileFlows réécrit un fichier existant, souvent en plus petit, et
 * comptait comme un ajout entier (`computeMonthlyGrowth`, 13/10/2026). Un remplacement, lui, y compte
 * entier : octobre 2026 affichait 4,36 To « ajoutés ». D'où les relevés.
 */
export function computeDiskForecast(samples: readonly DiskSample[] = samplesOrNone()): DiskForecast {
  const storage = getStorageStats();
  const disk = getDiskStats();
  const monthlyGrowth = storage.monthlyGrowth;
  const slope = slopeFromSamples(samples);
  const sampleDays = slope?.spanDays ?? sampleSpanDays(samples);
  const base = { monthlyGrowth, sampleDays, minSampleDays: MIN_SAMPLE_SPAN_DAYS };

  // `computedAt === 0` : jamais calculé dans ce processus (une analyse échouée, elle, a une date).
  // Avec assez de relevés, seule la mesure du disque (l'espace libre) est attendue : la pente ne doit
  // rien à l'analyse du stockage.
  const pending = disk.computedAt === 0 || (!slope && storage.computedAt === 0);
  if (pending) {
    return { ...base, trend: "insufficient_data", growthBytesPerDay: null, daysUntilFull: null, monthsUsed: 0, method: null, pending };
  }
  if (disk.disk.total <= 0) {
    return { ...base, trend: "insufficient_data", growthBytesPerDay: null, daysUntilFull: null, monthsUsed: 0, method: null, pending: false };
  }

  if (slope) {
    return trendOf(slope.bytesPerDay, disk.disk.free, { ...base, monthsUsed: 0, method: "samples" });
  }

  // The current month is still in progress — including it would understate the real monthly
  // rate (e.g. "3 GB so far" on the 2nd of the month reads as a near-empty month).
  const nowMonth = monthlyGrowth[monthlyGrowth.length - 1]?.month;
  const completeMonths = nowMonth ? monthlyGrowth.filter((m) => m.month !== nowMonth) : monthlyGrowth;
  // Un mois sans ajout compte pour zéro : la série de storage-scan est continue exprès. Les
  // retirer lisait « 900 Go, 0, 0 » comme 900 Go/mois au lieu de 300, et avançait la date de
  // saturation justement quand l'activité baisse. Seul un trio entièrement vide ne dit rien.
  const recentMonths = completeMonths.slice(-MONTHS_FOR_AVERAGE);

  if (recentMonths.every((m) => m.bytes <= 0)) {
    return { ...base, trend: "insufficient_data", growthBytesPerDay: null, daysUntilFull: null, monthsUsed: recentMonths.length, method: null, pending: false };
  }

  const avgBytesPerMonth = recentMonths.reduce((s, m) => s + m.bytes, 0) / recentMonths.length;
  return trendOf(avgBytesPerMonth / AVG_DAYS_PER_MONTH, disk.disk.free, { ...base, monthsUsed: recentMonths.length, method: "imports" });
}

function trendOf(
  growthBytesPerDay: number,
  free: number,
  rest: Omit<DiskForecast, "trend" | "growthBytesPerDay" | "daysUntilFull" | "pending">,
): DiskForecast {
  // Une pente négative (le disque se vide) est une utilisation stable, pas une date dans le passé.
  if (growthBytesPerDay < MIN_GROWTH_BYTES_PER_DAY) {
    return { ...rest, trend: "stable", growthBytesPerDay, daysUntilFull: null, pending: false };
  }
  return { ...rest, trend: "growing", growthBytesPerDay, daysUntilFull: Math.round(free / growthBytesPerDay), pending: false };
}

/** L'écart couvert par des relevés trop peu nombreux pour une pente — pour dire où on en est. */
function sampleSpanDays(samples: readonly DiskSample[]): number {
  if (samples.length < 2) return 0;
  return Math.floor((samples[samples.length - 1].sampledAt - samples[0].sampledAt) / 86_400_000);
}
