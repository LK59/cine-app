import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayVersion } from "@/lib/appBuild";

/**
 * La version de l'application : une seule source (`package.json`), montrée façon iOS, annoncée à
 * Jellyfin. Jusqu'au 29/09/2026 Jellyfin recevait « 1.0.0 » écrit en dur à deux endroits, et la
 * liste de ses appareils ne disait rien du code qui lui parlait.
 */
const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };

describe("displayVersion", () => {
  it("tait le correctif quand il vaut zéro, comme iOS", () => {
    expect(displayVersion("8.1.0")).toBe("8.1");
    expect(displayVersion("10.0.0")).toBe("10.0");
  });

  it("le montre sinon", () => {
    expect(displayVersion("8.1.1")).toBe("8.1.1");
    expect(displayVersion("8.1.12")).toBe("8.1.12");
  });

  it("rend tel quel ce qui n'a pas la forme majeur.mineur.correctif", () => {
    // « dev » est la valeur de repli hors d'un build Next — la suite de tests, justement.
    expect(displayVersion("dev")).toBe("dev");
    expect(displayVersion("9.0.0-beta.1")).toBe("9.0.0-beta.1");
  });

  it("la version de package.json a la forme attendue", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("l'en-tête de lecture envoyé à Jellyfin", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("porte la version de package.json, et plus « 1.0.0 »", async () => {
    // `NEXT_PUBLIC_APP_VERSION` est posé par next.config.js au build ; ici on le pose comme lui,
    // puis on recharge les modules qui l'ont lu à leur chargement.
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", version);
    vi.resetModules();
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: { get: () => null },
      json: async () => undefined,
      text: async () => "",
    } as unknown as Response);
    await jellyfin.reportPlaybackStart("u1", "item", "jeton", "ps", "ms", "DirectStream").catch(() => {});
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toContain(`Version="${version}"`);
    expect(auth).not.toContain('Version="1.0.0"');
  });
});
