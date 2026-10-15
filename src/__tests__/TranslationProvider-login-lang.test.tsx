// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import deDict from "@/locales/de.json";
import { TranslationProvider } from "@/components/TranslationProvider";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cine-lang=;path=/;max-age=0";
});

/**
 * 15/10/2026 (passe de nuit, BUREAU-1) : déconnecté, la page de connexion lisait `/api/user/preferences`
 * (401), prenait la langue de l'instance pour cible, réécrivait le cookie d'un compte allemand en
 * français et se rechargeait. Le cookie est la seule trace de la langue de ce navigateur : il reste.
 *
 * Une seule ouverture par fichier : l'amorçage passe par le préchargement de SWR, gardé pour la vie
 * du module.
 */
describe("TranslationProvider — déconnecté", () => {
  it("garde la langue du cookie quand la préférence du compte ne peut pas être lue", async () => {
    document.cookie = "cine-lang=de;path=/";
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/config/public"
        ? { ok: true, status: 200, json: async () => ({ defaultLang: "fr" }) }
        : { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <TranslationProvider initialLocale="de" initialDict={deDict as Record<string, unknown>}>
        <span />
      </TranslationProvider>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/user/preferences"));
    // Laisser l'amorçage aller au bout de sa décision.
    await new Promise((r) => setTimeout(r, 20));
    expect(document.cookie).toContain("cine-lang=de");
  });
});
