import { beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

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
