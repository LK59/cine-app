// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

// Le dictionnaire ne se charge pas : hors ligne, ou le morceau d'une version précédente qu'un
// déploiement a retiré.
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  loadLocaleDict: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
}));

import { TranslationProvider, useLocale, useT } from "@/components/TranslationProvider";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cine-lang=;path=/;max-age=0";
});

/**
 * Changer de langue ne rejette jamais.
 *
 * L'accueil attend `setLocale` avant de recharger la page, bouton grisé : un dictionnaire
 * introuvable faisait rejeter l'appel, et l'accueil restait figé sur « occupé », sans issue.
 */
describe("TranslationProvider — un dictionnaire introuvable", () => {
  it("laisse setLocale aboutir, et les textes dans la langue d'avant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    let outcome: Promise<void> | null = null;
    function Probe() {
      const t = useT();
      const { setLocale } = useLocale();
      return (
        <div>
          <span data-testid="key">{t("common.cancel")}</span>
          <button onClick={() => (outcome = setLocale("es"))}>switch</button>
        </div>
      );
    }
    render(
      <TranslationProvider initialLocale="fr">
        <Probe />
      </TranslationProvider>
    );
    await act(async () => screen.getByText("switch").click());
    await expect(outcome).resolves.toBeUndefined();
    expect(screen.getByTestId("key").textContent).toBe("Annuler");
    // Le choix est tout de même retenu : le prochain chargement de page le servira.
    expect(document.cookie).toContain("cine-lang=es");
  });
});
