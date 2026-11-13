import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface DiskUsage {
  total: number;
  used: number;
  free: number;
}

export const UNKNOWN_DISK: DiskUsage = { total: -1, used: -1, free: -1 };

/**
 * `df` sur un chemin, en octets. Sorti de `disk-stats.ts` le 13/11/2026 : le relevé quotidien de
 * l'occupation (`diskSamples.ts`) n'a besoin que de ça, et importer `disk-stats.ts` lance au chargement
 * l'inventaire complet de la bibliothèque (`find -exec stat` sur chaque fichier).
 */
export async function dfStatsAsync(path: string): Promise<DiskUsage> {
  try {
    // -P (POSIX format) forces single-line output regardless of filesystem name length.
    // Without it, `df` wraps onto a second line once the filesystem name is long enough
    // (e.g. a ZFS dataset or LVM name) — `tail -1` would then grab a line that happens to
    // start with the numeric columns instead of the filesystem name, shifting every field
    // by one. That only "worked" here by accident, for however long the mount's name stayed
    // long enough to trigger the wrap.
    const { stdout } = await execAsync(`df -B1 -P "${path}" 2>/dev/null | tail -1`, { timeout: 5_000 });
    return parseDfLine(stdout);
  } catch { return UNKNOWN_DISK; }
}

/**
 * La dernière ligne de `df -B1 -P`. Sur un chemin absent, `df` n'écrit que son en-tête, et
 * `tail -1` le rendait : « 1-blocks » se lisait 1 octet, « Used » et « Available » NaN — la carte
 * Stockage d'une installation sans dossier de médias affichait « — libres sur 1.0 B » (13/10/2026).
 * Tout ce qui n'est pas trois nombres est « inconnu ».
 */
export function parseDfLine(stdout: string): DiskUsage {
  const parts = stdout.trim().split(/\s+/);
  const [total, used, free] = [parts[1], parts[2], parts[3]].map((p) => (p !== undefined && /^\d+$/.test(p) ? Number(p) : NaN));
  if (!Number.isFinite(total) || !Number.isFinite(used) || !Number.isFinite(free) || total <= 0) return UNKNOWN_DISK;
  return { total, used, free };
}
