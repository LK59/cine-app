import { describe, expect, it } from "vitest";
import { isLoopbackUrl } from "@/lib/settings/testService";

// Le test d'un service dit « localhost » à part (19/11/2026, installation à blanc).
describe("adresse de la machine elle-même", () => {
  it("reconnaît localhost, 127.x, ::1 et 0.0.0.0, pas un nom de conteneur ni une IP du réseau", () => {
    for (const u of ["http://localhost:8096", "http://127.0.0.1:8096", "http://[::1]:8096", "http://0.0.0.0:8096", "http://jellyfin.localhost"]) expect(isLoopbackUrl(u)).toBe(true);
    for (const u of ["http://jellyfin:8096", "http://192.168.1.10:8096", "https://media.example.com", "pas une adresse"]) expect(isLoopbackUrl(u)).toBe(false);
  });
});
