import fs from "fs";
import path from "path";
import { getDb, DATA_DIR } from "@/lib/db";
import { logError } from "@/lib/logger";

// The app data volume already gets backed up externally — this is just a same-host safety
// net against a corrupted/truncated cine.db (e.g. a bad write, a disk hiccup) using
// better-sqlite3's own online backup API, which doesn't lock the DB while it runs.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const RETENTION_DAYS = 7;

/**
 * Le jour, tel qu'il est ici — pas tel qu'il est à Greenwich.
 *
 * `toISOString()` est en UTC quoi qu'il arrive : ni le `TZ` du conteneur ni `tzdata` n'y changent
 * quoi que ce soit. Une sauvegarde prise à 1h du matin à Paris portait donc la date de la veille,
 * et deux fichiers voisins ne racontaient pas les nuits qu'on croyait.
 *
 * Les composantes locales le disent juste, et le tri des noms reste ce qu'il était : `YYYY-MM-DD`
 * s'ordonne aussi bien dans un sens que dans l'autre.
 */
function backupFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `cine-${year}-${month}-${day}.db`;
}

export async function runDbBackup(): Promise<void> {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await getDb().backup(path.join(BACKUP_DIR, backupFileName()));

    // One file per day, named by ISO date — sorting the filenames is enough to find the
    // oldest ones, no need to stat/parse anything.
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("cine-") && f.endsWith(".db"))
      .sort();
    const stale = files.slice(0, Math.max(0, files.length - RETENTION_DAYS));
    for (const f of stale) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  } catch (err) {
    logError("db.backup", err);
  }
}

const BACKUP_INTERVAL_MS = 24 * 3600_000;

export function startDbBackupCron(): void {
  // 5 minutes after startup, not immediately — avoids competing with the app's own
  // startup work (cache warmup, notification checks) for DB access.
  const startupDelay = setTimeout(runDbBackup, 5 * 60_000);
  startupDelay.unref?.();

  const interval = setInterval(runDbBackup, BACKUP_INTERVAL_MS);
  interval.unref?.();
}
