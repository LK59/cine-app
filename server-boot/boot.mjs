// Le point d'entrée de l'image : les contrôles qui refusent un démarrage d'abord, les fichiers
// statiques des builds précédents ensuite (voir staticCarryover.mjs), le serveur de Next enfin.

import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { carryOverStatic } from "./staticCarryover.mjs";
import { dataDirProblem, startupRefusal } from "./startupChecks.mjs";
import { applyFirstRunSecrets } from "./firstRunSecrets.mjs";
import { linkImageCache } from "./imageCache.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(appDir, "data");

// Avant tout import du serveur, et une vraie sortie. Le même refus levé dans `instrumentation.ts`
// devenait « Failed to prepare server » et une promesse rejetée : le processus restait en vie, le
// conteneur « Up » répondait 500 à tout, aucune boucle de redémarrage ne signalait rien (audit du
// 29/09/2026). Un secret absent est lu comme vide — « vide » est ce qu'il faut corriger —, là où
// la configuration lui substitue sa valeur par défaut, refusée elle aussi.
// Le dossier de données d'abord : les secrets générés au premier lancement y vivent.
const dataProblem = dataDirProblem(dataDir);
if (dataProblem) {
  console.error(`[démarrage] refusé : ${dataProblem}`);
  process.exit(1);
}

// Les secrets que l'environnement ne donne pas : générés une fois, gardés dans data/config
// (DECISIONS.md §48). Ceux de `.env` ne sont jamais touchés.
try {
  const generated = await applyFirstRunSecrets(dataDir);
  if (generated.length) console.log(`[démarrage] secrets lus dans data/config/secrets.json : ${generated.join(", ")}`);
} catch (error) {
  console.error(`[démarrage] secrets du premier lancement indisponibles : ${error instanceof Error ? error.message : error}`);
}

const refusal = startupRefusal({
  sessionSecret: process.env.SESSION_SECRET ?? "",
  adminPassword: process.env.APP_ADMIN_PASSWORD ?? "",
});
if (refusal) {
  console.error(`[démarrage] refusé : ${refusal}`);
  process.exit(1);
}

// Le cache des affiches dans le volume de données (voir imageCache.mjs). Un échec ne coûte que des
// affiches réencodées : jamais un démarrage.
try {
  const imageCache = linkImageCache({ appDir, dataDir });
  if (imageCache !== "déjà lié") console.log(`[démarrage] cache des affiches : ${imageCache === "monté" ? "dossier monté, gardé tel quel" : "lié à data/image-cache"}`);
} catch (error) {
  console.error(`[démarrage] cache des affiches hors du volume : ${error instanceof Error ? error.message : error}`);
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

/**
 * L'adresse de la connexion, notée sur chaque requête avant que Next ne la voie (08/10/2026).
 *
 * Les gestionnaires de route de Next n'y ont pas accès ; sans elle, `X-Forwarded-For` — que n'importe
 * quel voisin du réseau Docker peut écrire — était la seule adresse connue. `x-cine-peer` est écrasé à
 * chaque requête : un client ne peut pas le fournir. Voir `src/lib/trustedProxy.ts`.
 */
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.prependListener("request", (req) => {
    req.headers["x-cine-peer"] = req.socket?.remoteAddress ?? "";
  });
  return server;
};
process.env.CINE_PEER_HEADER = "1";

await import(pathToFileURL(path.join(appDir, "server.js")).href);
