import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

/**
 * Écrire une ligne dans un journal, sans jamais faire échouer ce qui l'écrit.
 *
 * Le journal du lecteur a prouvé sa valeur : plusieurs pannes de cette application n'ont été
 * comprises que là, et nulle part ailleurs. Ce qu'il fait — un objet JSON par ligne, une taille
 * bornée, un fichier qu'on lit avec `tail` et `grep` — vaut pour tout ce qu'on veut retrouver
 * après coup. Le mécanisme est donc ici, et non recopié dans chaque journal : deux rotations
 * écrites séparément finissent par ne plus tourner pareil.
 *
 * Un fichier plutôt qu'une table : il se lit sans l'application, il survit à une base refaite, et
 * il n'ajoute pas une écriture SQLite synchrone sur le chemin d'une erreur — c'est-à-dire au pire
 * moment possible.
 */

export const LOG_DIR = path.join(DATA_DIR, "logs");

/** Tourné à cette taille, en gardant un fichier précédent. Borné à dessein : un carnet, pas une archive. */
const MAX_BYTES = 5 * 1024 * 1024;

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Pas encore de fichier, ou un renommage qui a perdu la course avec une autre écriture :
    // dans les deux cas c'est l'ajout qui suit qui compte, et il crée ce dont il a besoin.
  }
}

/**
 * Ajoute un objet, sur une ligne. Ne lève pas : un disque qui refuse une note n'est pas une
 * raison d'interrompre ce qu'on était en train de faire.
 */
export function appendJsonLine(file: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotate(file);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Volontairement muet, et c'est le seul endroit de l'application où ça se justifie : signaler
    // qu'on n'a pas pu écrire une erreur ne peut se faire qu'en écrivant une erreur.
  }
}
