import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hardRefreshApp, SW_STATIC_CACHE_PREFIX } from "@/lib/pwaRefresh";

/**
 * « Actualiser l'application » ne doit évincer que le code (`cine-static-*`).
 *
 * Il supprimait tous les caches, celui de l'application compris (`cine-app-v12` : offline.html,
 * la marque de `reloadHiddenTabsOnce`). L'adresse du worker n'ayant pas changé, rien ne les
 * reposait : une navigation hors ligne recevait « Offline 503 », et le déploiement suivant
 * rechargeait de nouveau les onglets cachés, film ouvert ou non.
 */
describe("hardRefreshApp", () => {
  let names: string[];
  let deleted: string[];
  const reload = vi.fn();

  beforeEach(() => {
    names = ["cine-app-v12", "cine-static-abc"];
    deleted = [];
    vi.stubGlobal("caches", {
      keys: async () => [...names],
      delete: async (k: string) => {
        deleted.push(k);
        names = names.filter((n) => n !== k);
        return true;
      },
    });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { location: { reload } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ne supprime que les caches de code, jamais celui de l'application", async () => {
    await hardRefreshApp();
    expect(deleted).toEqual(["cine-static-abc"]);
    expect(names).toEqual(["cine-app-v12"]);
    expect(reload).toHaveBeenCalled();
  });

  it("le préfixe est celui que public/sw.js donne à ses caches de code", () => {
    const sw = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
    expect(sw).toContain(`const STATIC_PREFIX = "${SW_STATIC_CACHE_PREFIX}";`);
  });
});
