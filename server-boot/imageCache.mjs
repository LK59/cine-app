// Le cache des affiches optimisées dans le volume de données (DECISIONS.md §48).
//
// Next le range dans `.next/cache/images`, dans l'image : sans montage dédié, chaque mise à jour
// repartait d'un cache vide et réencodait toute la bibliothèque. Le compose minimal n'a qu'un
// volume (`/app/data`) ; le dossier de Next devient donc, au démarrage, un lien vers
// `data/image-cache` — le même dossier que le modèle avancé monte à cet endroit, si bien qu'une
// installation qui le monte déjà garde son cache tel quel, sans copie : un dossier monté n'est
// jamais touché.

import fs from "node:fs";
import path from "node:path";

/** Le point de montage est-il un montage à lui seul (`/proc/self/mountinfo`, cinquième champ) ? */
export function isMountPoint(dir, mountinfo) {
  let text = mountinfo;
  if (text === undefined) {
    try {
      text = fs.readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return false;
    }
  }
  const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return text.split("\n").some((line) => unescape(line.split(" ")[4] ?? "") === dir);
}

/**
 * Rend ce qui a été fait : `monté` (rien), `lié` (lien créé), `déjà lié`. Le contenu d'un dossier
 * réel trouvé à la place (un conteneur redémarré sans être recréé) est déplacé dans le volume
 * avant d'être remplacé par le lien : rien de déjà encodé n'est perdu.
 */
export function linkImageCache({ appDir, dataDir, mountinfo }) {
  const cacheDir = path.join(appDir, ".next", "cache", "images");
  const target = path.join(dataDir, "image-cache");
  if (isMountPoint(cacheDir, mountinfo)) return "monté";
  fs.mkdirSync(target, { recursive: true });
  let stat = null;
  try {
    stat = fs.lstatSync(cacheDir);
  } catch {
    /* absent : on crée le lien */
  }
  if (stat?.isSymbolicLink()) {
    if (path.resolve(path.dirname(cacheDir), fs.readlinkSync(cacheDir)) === target) return "déjà lié";
    fs.unlinkSync(cacheDir);
  } else if (stat?.isDirectory()) {
    for (const entry of fs.readdirSync(cacheDir)) {
      const to = path.join(target, entry);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(path.join(cacheDir, entry), to);
      } catch {
        fs.cpSync(path.join(cacheDir, entry), to, { recursive: true });
      }
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  fs.symlinkSync(target, cacheDir, "dir");
  return "lié";
}
