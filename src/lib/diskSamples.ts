import { getDb } from "@/lib/db";
import { MEDIA_ROOT } from "@/lib/media-paths";
import { dfStatsAsync, type DiskUsage } from "@/lib/diskUsage";
import { taskLog } from "@/lib/taskLog";
import { logError } from "@/lib/logger";

/**
 * Le relevé quotidien de l'occupation réelle du disque des médias (13/11/2026, DECISIONS.md §153).
 *
 * La prévision de saturation additionnait la taille des fichiers importés chaque mois — remplacements
 * par une meilleure version compris : octobre 2026 comptait 4,36 To « ajoutés » pour un disque qui en
 * avait pris bien moins, puisque chaque fichier remplacé libère sa place. Elle annonçait donc la
 * saturation trop tôt. Ce que le disque occupe vraiment, `df` le dit en quelques millisecondes ; il
 * suffit de le noter chaque jour et de suivre la pente (`forecastFromSamples`).
 *
 * Une ligne par jour (clé `day`, le jour local), 400 jours au plus. Le minuteur passe toutes les heures
 * mais n'écrit qu'une fois par jour : le jour déjà relevé est retenu en mémoire, et l'insertion ne
 * remplace jamais une ligne existante. Toutes les requêtes sont courtes (une ligne, ou au plus 90
 * relues) : SQLite tient la boucle d'évènements le temps de chacune.
 *
 * Tâche de fond derrière `CINE_BACKGROUND_JOBS` : une copie de test (le banc) lit le même disque mais
 * écrit dans sa propre base, recopiée — elle n'a rien à relever.
 */

export const DISK_SAMPLES_KEPT_DAYS = 400;
const FIRST_DELAY_MS = 3 * 60_000;
const TICK_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

export interface DiskSample {
  day: string;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
  sampledAt: number;
}

/** Le jour local (fuseau du foyer) « AAAA-MM-JJ ». */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Note la mesure du jour si ce jour n'en a pas encore. Rend `true` si une ligne a été écrite. Une mesure
 * inconnue (`df` muet, dossier absent) n'écrit rien. Le ménage des lignes de plus de 400 jours suit
 * l'insertion, donc une fois par jour aussi.
 */
export function recordDiskSample(usage: DiskUsage, now = Date.now()): boolean {
  if (!(usage.total > 0) || usage.used < 0 || usage.free < 0) return false;
  const db = getDb();
  const day = localDay(now);
  const inserted = db
    .prepare("INSERT OR IGNORE INTO disk_samples (day, used_bytes, free_bytes, total_bytes, sampled_at) VALUES (?, ?, ?, ?, ?)")
    .run(day, usage.used, usage.free, usage.total, now).changes > 0;
  if (inserted) db.prepare("DELETE FROM disk_samples WHERE day < ?").run(localDay(now - DISK_SAMPLES_KEPT_DAYS * DAY_MS));
  return inserted;
}

export function hasDiskSampleFor(now = Date.now()): boolean {
  return getDb().prepare("SELECT 1 FROM disk_samples WHERE day = ?").get(localDay(now)) !== undefined;
}

/** Les relevés des `days` derniers jours, du plus ancien au plus récent. */
export function readDiskSamples(days: number, now = Date.now()): DiskSample[] {
  const rows = getDb()
    .prepare("SELECT day, used_bytes, free_bytes, total_bytes, sampled_at FROM disk_samples WHERE day >= ? ORDER BY day")
    .all(localDay(now - days * DAY_MS)) as { day: string; used_bytes: number; free_bytes: number; total_bytes: number; sampled_at: number }[];
  return rows.map((r) => ({ day: r.day, usedBytes: r.used_bytes, freeBytes: r.free_bytes, totalBytes: r.total_bytes, sampledAt: r.sampled_at }));
}

// ─── La pente ─────────────────────────────────────────────────────────────────

/**
 * **Quatorze jours de relevés au moins avant de leur faire confiance**, sur dix relevés au moins.
 * L'occupation d'un jour bouge pour d'autres raisons que la croissance de la bibliothèque : un pack de
 * saison qui se télécharge puis se lie, un remplacement qui double un film le temps de l'import, une
 * passe de ménage. Sur une semaine, un seul de ces évènements fait la pente ; sur deux, la régression les
 * absorbe, et deux semaines couvrent deux fois le rythme du foyer (les demandes arrivent surtout le
 * week-end). Attendre ne coûte rien : la méthode par les imports répond d'ici là. Dix relevés au moins,
 * pour qu'un serveur arrêté la plupart de ces jours ne trace pas une droite entre deux points.
 */
export const MIN_SAMPLE_SPAN_DAYS = 14;
export const MIN_SAMPLE_COUNT = 10;
/** La fenêtre de la pente : trois mois, comme la méthode par les imports — les habitudes du moment. */
export const SAMPLE_WINDOW_DAYS = 90;

export interface SampleSlope {
  /** Octets par jour (négatif quand le disque se vide). */
  bytesPerDay: number;
  /** L'écart, en jours, entre le premier et le dernier relevé retenus. */
  spanDays: number;
  count: number;
}

/**
 * La pente de l'occupation, par moindres carrés plutôt qu'entre le premier et le dernier jour : un pic
 * d'un jour (téléchargement en cours ce jour-là) ne fait pas la tendance à lui seul.
 *
 * Seuls comptent les relevés faits à la taille de disque actuelle : un disque agrandi ou un volume
 * ajouté change l'occupation d'un coup sans que la bibliothèque ait grandi. Rend `null` tant qu'il n'y
 * a pas assez de relevés (voir `MIN_SAMPLE_SPAN_DAYS`).
 */
export function slopeFromSamples(samples: readonly DiskSample[]): SampleSlope | null {
  if (samples.length === 0) return null;
  const total = samples[samples.length - 1].totalBytes;
  // Le dernier passage à la taille actuelle : rien d'avant un changement de disque.
  let start = samples.length - 1;
  while (start > 0 && Math.abs(samples[start - 1].totalBytes - total) <= total * 0.001) start--;
  const kept = samples.slice(start);
  const spanDays = (kept[kept.length - 1].sampledAt - kept[0].sampledAt) / DAY_MS;
  if (kept.length < MIN_SAMPLE_COUNT || spanDays < MIN_SAMPLE_SPAN_DAYS) return null;

  const t0 = kept[0].sampledAt;
  const xs = kept.map((s) => (s.sampledAt - t0) / DAY_MS);
  const ys = kept.map((s) => s.usedBytes);
  const n = kept.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den <= 0) return null;
  return { bytesPerDay: num / den, spanDays: Math.round(spanDays), count: n };
}

// ─── La tâche ─────────────────────────────────────────────────────────────────

interface CronState { started: boolean; recordedDay: string | null; running: boolean }
function cronState(): CronState {
  const g = globalThis as unknown as Record<symbol, CronState | undefined>;
  return (g[Symbol.for("laterna.diskSamples")] ??= { started: false, recordedDay: null, running: false });
}

/** Un passage : rien si le jour est déjà relevé (en mémoire, puis dans la base), sinon `df` et une ligne. */
export async function sampleDiskOnce(
  now: () => number = Date.now,
  measure: (path: string) => Promise<DiskUsage> = dfStatsAsync,
): Promise<boolean> {
  const st = cronState();
  const day = localDay(now());
  if (st.recordedDay === day || st.running) return false;
  st.running = true;
  try {
    if (hasDiskSampleFor(now())) {
      st.recordedDay = day;
      return false;
    }
    const usage = await measure(MEDIA_ROOT);
    const written = recordDiskSample(usage, now());
    if (written) {
      st.recordedDay = day;
      taskLog("disque", "occupation relevée", { usedGB: Math.round(usage.used / 1e9), freeGB: Math.round(usage.free / 1e9) });
    }
    return written;
  } catch (err) {
    logError("disk-samples", err);
    return false;
  } finally {
    st.running = false;
  }
}

/** Au démarrage, derrière `CINE_BACKGROUND_JOBS` : un premier passage après trois minutes, puis toutes les heures. */
export function startDiskSampleCron(): void {
  const st = cronState();
  if (st.started) return;
  st.started = true;
  const first = setTimeout(() => {
    void sampleDiskOnce();
    const tick = setInterval(() => void sampleDiskOnce(), TICK_MS);
    (tick as { unref?: () => void }).unref?.();
  }, FIRST_DELAY_MS);
  (first as { unref?: () => void }).unref?.();
}

export const __testing = {
  reset: () => Object.assign(cronState(), { started: false, recordedDay: null, running: false }),
};
