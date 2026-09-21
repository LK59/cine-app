import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * L'option galerie se lit au démarrage et reste fermée par défaut. Elle était figée dans l'image
 * au build (`NEXT_PUBLIC_CLARA_GALLERY_ENABLED`, par défaut "true"), si bien que l'image publiée
 * l'avait ouverte quoi que dise le `.env` (22/09/2026).
 */
describe("config.gallery.clara", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fermée sans réglage", async () => {
    vi.stubEnv("CLARA_GALLERY_ENABLED", "");
    const { config } = await import("@/lib/config");
    expect(config.gallery.clara).toBe(false);
  });

  it("ouverte par CLARA_GALLERY_ENABLED=true, lu au démarrage", async () => {
    vi.stubEnv("CLARA_GALLERY_ENABLED", "true");
    const { config } = await import("@/lib/config");
    expect(config.gallery.clara).toBe(true);
  });

  it("plus rien de figé au build", async () => {
    const { readFileSync } = await import("fs");
    expect(readFileSync("next.config.js", "utf8")).not.toMatch(/NEXT_PUBLIC_CLARA_GALLERY_ENABLED/);
  });
});
