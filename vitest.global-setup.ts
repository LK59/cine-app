import fs from "node:fs";
import path from "node:path";

/**
 * La base modèle de la suite (13/11/2026) : migrée **une fois**, avant le premier fichier, puis copiée par
 * `vitest.setup.ts` dans le dossier propre à chaque fichier.
 *
 * Une base par fichier a supprimé les « database is locked » (des dizaines de fichiers qui migraient la même
 * base en même temps), mais chacun migrait alors une base vide : la suite est passée de 123 à 200 s. Copier un
 * fichier déjà migré coûte quelques millisecondes ; la migration de chaque fichier, qui reste, n'a plus rien à
 * faire (chaque étape est marquée dans `migrations_done`) — comme quand la base était partagée.
 */
export default async function setup(): Promise<void> {
  const root = process.env.CINE_TEST_DATA_ROOT;
  if (!root) return;
  const dir = path.join(root, "modele");
  fs.mkdirSync(dir, { recursive: true });
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const { getDb } = await import("./src/lib/db");
    const db = getDb();
    // Tout dans le fichier principal, rien dans le journal : la copie prend `cine.db` seul.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (error) {
    // Sans modèle, chaque fichier migre sa base vide lui-même : plus lent, jamais faux.
    console.warn("base modèle des tests indisponible :", error instanceof Error ? error.message : error);
    fs.rmSync(path.join(dir, "cine.db"), { force: true });
  } finally {
    process.env.DATA_DIR = previous;
  }
}
