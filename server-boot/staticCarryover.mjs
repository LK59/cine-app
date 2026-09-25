// Les fichiers statiques des builds précédents, gardés quelques heures après un déploiement.
//
// Un déploiement remplace l'image, et avec elle tout `.next/static` : les morceaux de code du build
// d'avant disparaissent du serveur. Un onglet resté sur ce build — pendant un film, puisqu'on ne
// recharge jamais un film (`BuildRefresh`) — qui charge à la demande un morceau qu'il n'avait pas
// encore utilisé (un décodeur au premier changement de piste, hls.js au passage au lecteur
// serveur) reçoit alors un 404, et l'erreur de morceau manquant recharge la page : le film est
// coupé au pire moment. C'est ce qu'on évite ici, sans rien retarder : l'onglet passe toujours à la
// dernière version au premier moment sûr ; d'ici là, il trouve encore son code.
//
// Au démarrage, avant le serveur : le build courant s'archive dans `data/static-previous/<build>`,
// les builds retirés depuis moins de KEEP_HOURS (KEEP_BUILDS au plus) sont remis à côté des siens,
// le reste est effacé. Les noms sont des empreintes de contenu : deux builds ne se marchent pas
// dessus, et rien du build courant n'est jamais écrasé. Environ 8 Mo par build.
//
// En JavaScript simple et hors de `src/` : il tourne avant Next, dans l'image, sans compilation.

import fs from "node:fs";
import path from "node:path";

/** Assez pour un film commencé juste avant un déploiement, pas davantage. */
export const KEEP_HOURS = 8;
/** Plusieurs déploiements par jour : trois builds d'avant couvrent une soirée chargée. */
export const KEEP_BUILDS = 3;

const RETIRED = ".retired-at";

/**
 * @param {{ appDir: string, dataDir: string, now?: number }} options
 * @returns {{ buildId: string, carried: string[], removed: string[] }}
 */
export function carryOverStatic({ appDir, dataDir, now = Date.now() }) {
  const staticDir = path.join(appDir, ".next", "static");
  const buildId = fs.readFileSync(path.join(appDir, ".next", "BUILD_ID"), "utf8").trim();
  if (!buildId || buildId.includes("/") || buildId.includes("..")) throw new Error(`BUILD_ID inattendu : ${buildId}`);
  const root = path.join(dataDir, "static-previous");
  fs.mkdirSync(root, { recursive: true });

  // Le build courant s'archive, une fois : il sera le « précédent » du prochain déploiement. Par un
  // dossier temporaire renommé, pour qu'une copie interrompue ne passe jamais pour une archive.
  const own = path.join(root, buildId);
  if (!fs.existsSync(own)) {
    const partial = `${own}.partiel`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.cpSync(staticDir, partial, { recursive: true });
    fs.renameSync(partial, own);
  }

  // Les autres sont des builds retirés. Leur âge compte depuis leur retrait — le premier démarrage
  // d'un build plus récent qui les a vus —, pas depuis leur propre construction.
  const others = [];
  const removed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === buildId) continue;
    const dir = path.join(root, entry.name);
    if (entry.name.endsWith(".partiel")) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const mark = path.join(dir, RETIRED);
    let retiredAt = Number.NaN;
    try {
      retiredAt = Number(fs.readFileSync(mark, "utf8"));
    } catch {
      /* pas encore marqué : il vient d'être retiré */
    }
    if (!Number.isFinite(retiredAt)) {
      retiredAt = now;
      fs.writeFileSync(mark, String(now));
    }
    others.push({ name: entry.name, dir, retiredAt });
  }

  others.sort((a, b) => b.retiredAt - a.retiredAt);
  const kept = [];
  for (const [index, build] of others.entries()) {
    if (index < KEEP_BUILDS && now - build.retiredAt < KEEP_HOURS * 3600_000) kept.push(build);
    else {
      fs.rmSync(build.dir, { recursive: true, force: true });
      removed.push(build.name);
    }
  }

  // Remis à côté des fichiers du build courant, sans jamais les écraser.
  for (const build of kept) {
    fs.cpSync(build.dir, staticDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (source) => path.basename(source) !== RETIRED,
    });
  }
  return { buildId, carried: kept.map((b) => b.name), removed };
}
