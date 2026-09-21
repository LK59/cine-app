// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

describe("preloadQuietly", () => {
  it("absorbe un réseau absent au lieu d'en faire un rejet non rattrapé", async () => {
    // 21/09/2026 : « Load failed » sur `/`, journalisé par l'iPhone de Louis à chaque réouverture
    // juste après un déploiement — le préchargement de « Ma liste » partait sans `.catch`.
    const { preloadQuietly } = await import("@/lib/prefetch");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = await preloadQuietly("/api/test-hors-ligne", () => Promise.reject(new TypeError("Load failed")));
      expect(result).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("rend les données quand la requête aboutit", async () => {
    const { preloadQuietly } = await import("@/lib/prefetch");
    expect(await preloadQuietly("/api/test-en-ligne", async () => ({ ok: 1 }))).toEqual({ ok: 1 });
  });

  it("est le seul chemin vers le preload de SWR", () => {
    // Un appel direct ailleurs, c'est la même fuite qui revient : personne n'attend sa promesse.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__") walk(full);
        } else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk("src");
    const offenders = files.filter(
      (file) => file !== path.join("src", "lib", "prefetch.ts") && /import\s*\{[^}]*\bpreload\b[^}]*\}\s*from\s*"swr"/.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
