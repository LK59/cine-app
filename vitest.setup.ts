import { beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Une base de test par fichier (13/11/2026).
 *
 * `DATA_DIR` (posé par `vitest.config.ts`) était partagé par tous les fichiers de la suite : chacun y ouvrait
 * `cine.db` et la migrait à son tour, des dizaines en même temps dans les fils. Sous la charge (la machine de
 * GitHub, la construction de l'image), l'un attendait le verrou d'un autre plus de 5 s et échouait sur
 * « database is locked » — `series-language`, le 13/11, sans aucun rapport avec ce qu'il teste. Chaque fichier
 * reçoit ici son propre sous-dossier, avant d'importer quoi que ce soit (`dataDir.ts` lit la variable une fois, au
 * chargement, et chaque fichier a son propre registre de modules) : plus aucune base partagée entre fichiers.
 * Un fichier qui se donnait déjà son dossier (`vi.hoisted`, comme `news-page-105.test.ts`) passe après, et garde
 * le sien. Les dossiers vivent sous la racine jetable de la suite.
 */
const SUITE_DATA_ROOT = process.env.CINE_TEST_DATA_ROOT ?? process.env.DATA_DIR;
if (SUITE_DATA_ROOT) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(SUITE_DATA_ROOT, "fichier-"));
  // La base déjà migrée (`vitest.global-setup.ts`), copiée : la migration du fichier n'a plus rien à faire.
  const model = path.join(SUITE_DATA_ROOT, "modele", "cine.db");
  if (fs.existsSync(model)) fs.copyFileSync(model, path.join(process.env.DATA_DIR, "cine.db"));
}
// Les matchers du DOM (`toBeInTheDocument`…) pour les seuls tests sous jsdom (249 fichiers sur 637).
// Importés partout, ils coûtaient à chaque fichier de la suite : 16 % de son temps (mesuré le
// 15/10/2026, 128 s → 115 s une fois réservés à jsdom).
if (typeof document !== "undefined") await import("@testing-library/jest-dom/vitest");

// jsdom implements neither scrollIntoView nor matchMedia — stub the ones this codebase actually
// calls so component/hook tests that trigger them don't crash. Guarded because this setup file
// also runs for the (much more numerous) node-environment API/lib tests, where `Element`/`window`
// don't exist at all.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Le coupe-circuit de Jellyfin vit sur `globalThis` (`jellyfinBreaker.ts`) : un test qui simule une
// panne l'ouvrirait pour les suivants du même fichier. Effacé avant chaque test.
beforeEach(() => {
  delete (globalThis as { __cineJellyfinBreaker?: unknown }).__cineJellyfinBreaker;
  // Et la limite du journal des pannes amont (`logger.ts`).
  delete (globalThis as { __cineUpstreamLogged?: unknown }).__cineUpstreamLogged;
});
