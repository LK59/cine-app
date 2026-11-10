// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));

import { ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Le motif commun des cartes de fonction (DECISIONS.md §142) : ce dont elles ont besoin est écrit,
 * ce qui manque estompe la carte et donne le lien vers l'endroit où il se règle, et l'état vient du
 * serveur. Rendu avec de vraies réponses de `/api/settings` et `/api/subtitle-gen/admin`.
 */
const view = (key: string, o: Partial<SettingView> = {}): SettingView => ({ key, source: "default", value: "", set: false, hint: null, envPresent: false, ...o });

function stubApi(settings: SettingView[], features: { id: string; audience: string; blocked: string | null }[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.startsWith("/api/settings")
        ? { settings, missing: [] }
        : { available: false, hasKey: false, provider: "anthropic", model: "m", price: null, budgetUsd: 5, month: { cost: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, requests: 0 }, features, jobs: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const wrap = (ui: React.ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("une carte de fonction", () => {
  it("sans clé d'IA : estompée, le besoin en avertissement, le lien vers le fournisseur", async () => {
    stubApi([view("SUBTITLE_GEN_API_KEY"), view("DESCRIBE_SEARCH_ENABLED", { value: "true" })], [{ id: "describe", audience: "tous", blocked: "provider" }]);
    const { container } = wrap(<ConfigurationSection cards={CONFIG_LAYOUT.aiFeatures.filter((c) => c.feature === "describe")} />);
    await waitFor(() => expect(container.querySelector('[data-need-missing="aiKey"]')).toBeTruthy());
    expect(container.querySelector('[data-need-missing="aiKey"] a')?.getAttribute("href")).toBe("/parametres/ia#fournisseur");
    expect(container.querySelector("section#describe")?.hasAttribute("data-dimmed")).toBe(true);
    // L'état du serveur : le public, puis ce qui bloque.
    await waitFor(() => expect(container.querySelector('[data-feature-state="describe"]')?.textContent).toContain("aiFeatures.blocked.provider"));
  });

  it("« Jusqu'ici » dit ses trois besoins ; ceux qui sont là se lisent « prêt »", async () => {
    stubApi([
      view("SUBTITLE_GEN_API_KEY", { set: true, value: null }),
      view("XRAY_URL", { value: "http://laterna-xray:8000" }),
      view("XRAY_API_KEY", { set: true, value: null }),
      view("XRAY_ENABLED", { value: "off" }),
    ]);
    const { container } = wrap(<ConfigurationSection cards={CONFIG_LAYOUT.aiFeatures.filter((c) => c.feature === "sofar")} />);
    await waitFor(() => expect(container.querySelector('[data-need-missing="xrayOn"]')).toBeTruthy());
    expect(container.querySelector('[data-need-missing="xrayOn"] a')?.getAttribute("href")).toBe("/parametres/acteurs");
    expect(container.querySelector("[data-need-ok]")?.textContent).toContain("config.needs.aiKey");
    expect(container.querySelector("[data-need-ok]")?.textContent).toContain("config.needs.xrayService");
  });

  it("tout est là : ni avertissement, ni carte estompée", async () => {
    stubApi([view("SUBTITLE_GEN_API_KEY", { set: true, value: null })]);
    const { container } = wrap(<ConfigurationSection cards={CONFIG_LAYOUT.aiFeatures.filter((c) => c.feature === "recap")} />);
    await waitFor(() => expect(container.querySelector("section#recap")).toBeTruthy());
    expect(container.querySelector("[data-need-missing]")).toBeNull();
    expect(container.querySelector("section#recap")?.hasAttribute("data-dimmed")).toBe(false);
  });
});

describe("les acteurs à l'écran", () => {
  it("Connexions : l'adresse, la clé et le test du service, pas l'interrupteur", async () => {
    stubApi([view("XRAY_URL", { value: "http://laterna-xray:8000" }), view("XRAY_API_KEY"), view("XRAY_ENABLED", { value: "off" })]);
    wrap(<ConfigurationSection cards={CONFIG_LAYOUT.connections.filter((c) => c.group === "xray")} />);
    await waitFor(() => expect(screen.getByLabelText("setup.fields.XRAY_URL")).toBeTruthy());
    expect(screen.queryByLabelText("setup.fields.XRAY_ENABLED")).toBeNull();
    expect(screen.getByText("setup.test")).toBeTruthy();
  });

  it("Fonctions intelligentes : l'interrupteur, sans test de connexion, et le lien vers le service qui manque", async () => {
    stubApi([view("XRAY_URL", { value: "http://laterna-xray:8000" }), view("XRAY_API_KEY"), view("XRAY_ENABLED", { value: "tous" })]);
    const { container } = wrap(<ConfigurationSection cards={CONFIG_LAYOUT.xray} />);
    await waitFor(() => expect(screen.getByLabelText("setup.fields.XRAY_ENABLED")).toBeTruthy());
    expect(screen.queryByLabelText("setup.fields.XRAY_URL")).toBeNull();
    expect(screen.queryByText("setup.test")).toBeNull();
    expect(container.querySelector('[data-need-missing="xrayService"] a')?.getAttribute("href")).toBe("/parametres#xray");
  });
});
