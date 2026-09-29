// Le point d'entrée de l'image : les contrôles qui refusent un démarrage d'abord, les fichiers
// statiques des builds précédents ensuite (voir staticCarryover.mjs), le serveur de Next enfin.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { carryOverStatic } from "./staticCarryover.mjs";
import { dataDirProblem, startupRefusal } from "./startupChecks.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(appDir, "data");

// Avant tout import du serveur, et une vraie sortie. Le même refus levé dans `instrumentation.ts`
// devenait « Failed to prepare server » et une promesse rejetée : le processus restait en vie, le
// conteneur « Up » répondait 500 à tout, aucune boucle de redémarrage ne signalait rien (audit du
// 29/09/2026). Un secret absent est lu comme vide — « vide » est ce qu'il faut corriger —, là où
// la configuration lui substitue sa valeur par défaut, refusée elle aussi.
const refusal =
  startupRefusal({
    sessionSecret: process.env.SESSION_SECRET ?? "",
    adminPassword: process.env.APP_ADMIN_PASSWORD ?? "",
  }) ?? dataDirProblem(dataDir);
if (refusal) {
  console.error(`[démarrage] refusé : ${refusal}`);
  process.exit(1);
}

// La version de package.json (que la sortie `standalone` de Next copie à la racine de l'image),
// pour que la ligne de démarrage dise quelle livraison démarre, pas seulement quel build. Illisible,
// elle n'empêche rien : la ligne dit « ? ».
let version = "?";
try {
  version = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")).version ?? "?";
} catch {
  /* sans version, la ligne garde le build */
}

// Un échec ici n'empêche jamais le démarrage : il ne coûte qu'un morceau de code manquant à un
// onglet resté sur l'ancien build.
try {
  const { buildId, carried, removed } = carryOverStatic({ appDir, dataDir });
  console.log(
    `[démarrage] version ${version}, build ${buildId} — builds précédents gardés : ${carried.join(", ") || "aucun"}` +
      (removed.length ? ` ; effacés : ${removed.join(", ")}` : "")
  );
} catch (error) {
  console.error(`[démarrage] fichiers des builds précédents non repris : ${error instanceof Error ? error.message : error}`);
}

await import(pathToFileURL(path.join(appDir, "server.js")).href);
