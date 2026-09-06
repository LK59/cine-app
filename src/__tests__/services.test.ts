import { describe, it, expect } from "vitest";
import { configuredServices, SERVICE_ENV } from "@/lib/services";

const NOTHING = {
  radarr: { apiKey: "" },
  sonarr: { apiKey: "" },
  bazarr: { apiKey: "" },
  jackett: { apiKey: "" },
  jellyfin: { apiKey: "" },
  jellyseerr: { apiKey: "" },
  qbittorrent: { password: "" },
  tmdb: { apiKey: "" },
};

describe("configuredServices", () => {
  it("says nothing is connected on a bare installation", () => {
    expect(Object.values(configuredServices(NOTHING)).every((v) => v === false)).toBe(true);
  });

  // L'adresse a une valeur par défaut pour chaque service : elle est donc toujours renseignée, et
  // s'y fier ferait passer une installation vide pour une installation complète. C'est le secret
  // qui dit si quelqu'un a réellement branché quelque chose.
  it("reads the secret rather than the address", () => {
    const configured = configuredServices({ ...NOTHING, radarr: { apiKey: "abc" } });
    expect(configured.radarr).toBe(true);
    expect(configured.sonarr).toBe(false);
  });

  it("uses the password for qBittorrent, which has no key", () => {
    expect(configuredServices({ ...NOTHING, qbittorrent: { password: "s3cr3t" } }).qbittorrent).toBe(true);
  });

  // Chaque service doit pouvoir dire quoi poser : un écran « non configuré » sans la marche à
  // suivre ne fait que déplacer la question.
  it("names the variables to set for every service it knows", () => {
    for (const key of Object.keys(configuredServices(NOTHING)) as (keyof typeof SERVICE_ENV)[]) {
      expect(SERVICE_ENV[key]?.length).toBeGreaterThan(0);
      for (const name of SERVICE_ENV[key]) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});
