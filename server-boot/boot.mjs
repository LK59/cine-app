// Le point d'entrée de l'image : les fichiers statiques des builds précédents d'abord (voir
// staticCarryover.mjs), le serveur de Next ensuite. Un échec ici n'empêche jamais le démarrage :
// il ne coûte qu'un morceau de code manquant à un onglet resté sur l'ancien build.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { carryOverStatic } from "./staticCarryover.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(appDir, "data");
try {
  const { buildId, carried, removed } = carryOverStatic({ appDir, dataDir });
  console.log(
    `[démarrage] build ${buildId} — builds précédents gardés : ${carried.join(", ") || "aucun"}` +
      (removed.length ? ` ; effacés : ${removed.join(", ")}` : "")
  );
} catch (error) {
  console.error(`[démarrage] fichiers des builds précédents non repris : ${error instanceof Error ? error.message : error}`);
}

await import(pathToFileURL(path.join(appDir, "server.js")).href);
