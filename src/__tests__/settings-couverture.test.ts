import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT_GUIDE, GENERATED_SECRETS, SETTINGS } from "@/lib/settings/schema";

/**
 * Chaque variable de `.env.example` a sa place dans l'interface (DECISIONS.md §48) : réglable dans
 * l'application, expliquée par le guide de déploiement avec la ligne à ajouter, ou générée au
 * premier lancement. Né d'un oubli du 05/10/2026 — la galerie, le préchauffage des affiches et les
 * sous-dossiers de la bibliothèque n'étaient nulle part.
 */
const DEV_ONLY = ["DEV_BIND"]; // la pile de développement seulement (docker-compose.dev.yml)

function envExampleKeys(): string[] {
  const text = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  // Les lignes actives et les lignes commentées qui donnent un exemple (`# CLÉ=valeur`).
  return [...new Set([...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]))];
}

describe("la couverture du .env.example", () => {
  const inApp = new Set(SETTINGS.filter((s) => s.inApp).map((s) => s.key));
  const guided = new Set(DEPLOYMENT_GUIDE.flatMap((e) => e.keys));
  const generated = new Set<string>(GENERATED_SECRETS);

  it("ne laisse aucune variable ni réglable, ni guidée, ni générée", () => {
    const orphans = envExampleKeys().filter((k) => !inApp.has(k) && !guided.has(k) && !generated.has(k) && !DEV_ONLY.includes(k));
    expect(orphans).toEqual([]);
  });

  it("ne guide pas ce qui se règle déjà dans l'application", () => {
    expect([...guided].filter((k) => inApp.has(k))).toEqual([]);
  });

  it("donne pour chaque entrée du guide une ligne qui nomme ses variables", () => {
    for (const entry of DEPLOYMENT_GUIDE) for (const key of entry.keys) expect(entry.snippet, entry.id).toContain(key);
  });

  it("garde le lecteur et son relais vers Jellyfin activés par défaut", () => {
    const fallback = (k: string) => SETTINGS.find((s) => s.key === k)?.fallback;
    expect(fallback("PLAYER_ENABLED")).toBe("true");
    expect(fallback("PLAYER_SERVER_FALLBACK")).toBe("true");
  });
});
