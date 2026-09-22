import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

/** Tourné à cette taille. Borné à dessein : un carnet, pas une archive. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Combien de fichiers précédents un journal garde — un par défaut, chaque journal pouvant en
 * demander davantage (`appendJsonLine(fichier, ligne, { keep })`).
 *
 * Un seul suffisait tant qu'un journal ne se remplissait qu'au rythme des spectateurs. Le banc
 * d'essai a changé l'échelle : une série complète écrit des centaines de lignes `seek` portant
 * jusqu'à 4 000 caractères de trace, et elle pouvait faire tourner `player.log` deux fois dans la
 * soirée — emportant l'historique de la veille, celui des vrais spectateurs, qui est précisément
 * ce que ce journal existe pour garder.
 */
export const DEFAULT_KEEP = 1;

/** Au-delà, ce n'est plus un carnet : on borne ce qu'un appelant peut demander. */
const MAX_KEEP = 20;

function keepOf(keep: number | undefined): number {
  if (keep === undefined || !Number.isFinite(keep)) return DEFAULT_KEEP;
  return Math.min(MAX_KEEP, Math.max(1, Math.floor(keep)));
}

/**
 * Le journal et ses archives, **du plus ancien au plus récent** — l'ordre dans lequel on les relit
 * pour retrouver une chronologie. Les fichiers absents sont laissés au lecteur (`readLogLines` les
 * saute) : on ne sonde pas le disque pour construire une liste de noms.
 */
export function logGenerations(file: string, keep?: number): string[] {
  const n = keepOf(keep);
  const out: string[] = [];
  for (let i = n; i >= 1; i--) out.push(`${file}.${i}`);
  out.push(file);
  return out;
}

function rotate(file: string, keep: number): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
  } catch {
    // Pas encore de fichier : l'ajout qui suit le crée.
    return;
  }
  /**
   * Chaque archive glisse d'un rang, la plus ancienne écrasée par sa cadette — un renommage par
   * génération, et seulement au moment de tourner, soit une fois tous les 5 Mo : l'écriture
   * ordinaire ne paie toujours qu'un `stat`.
   *
   * Chaque renommage a sa propre garde : une archive manquante (un journal qui n'a encore tourné
   * qu'une fois) ou un renommage qui a perdu la course avec une autre écriture ne doit pas
   * empêcher les suivants, et surtout pas le dernier, celui qui libère le fichier courant.
   */
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      /* rien à décaler à ce rang */
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Un renommage qui a perdu la course avec une autre écriture : c'est l'ajout qui suit qui
    // compte, et il crée ce dont il a besoin.
  }
}

/**
 * Ajoute un objet, sur une ligne. Ne lève pas : un disque qui refuse une note n'est pas une
 * raison d'interrompre ce qu'on était en train de faire.
 */
export function appendJsonLine(file: string, entry: Record<string, unknown>, options?: { keep?: number }): void {
  /**
   * Une exécution de tests n'écrit pas dans le carnet de la production.
   *
   * La porte de vérification tourne dans un conteneur qui monte le dépôt entier, `data/` compris :
   * chaque route testée dont le double lève écrivait donc une ligne dans le vrai journal
   * d'erreurs. Cinq lignes sur quarante, relevées le 19/09/2026 — des `[vitest] No "tmdb"
   * export…` au milieu de vraies pannes.
   *
   * Ce n'est pas qu'une question de propreté. `server.log` est l'outil de diagnostic de référence
   * de ce dépôt, et il a servi deux fois aujourd'hui ; des lignes qui décrivent un double de test
   * y font perdre exactement le temps qu'il fait gagner.
   *
   * La borne est le dossier temporaire, et non l'exécution de tests elle-même : plusieurs tests
   * vérifient précisément ce qui s'écrit — la rotation, le bornage des champs, la pile sur disque
   * — et le font en pointant `DATA_DIR` vers un `mkdtemp`. Ceux-là écrivent, parce qu'ils lisent
   * ensuite. Les autres, qui ne montent rien, ne peuvent atteindre que le vrai dossier : c'est
   * exactement ce qu'on refuse. Une première version coupait tout et rendait sept tests muets.
   */
  if (process.env.VITEST && !file.startsWith(os.tmpdir())) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotate(file, keepOf(options?.keep));
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Volontairement muet, et c'est le seul endroit de l'application où ça se justifie : signaler
    // qu'on n'a pas pu écrire une erreur ne peut se faire qu'en écrivant une erreur.
  }
}
