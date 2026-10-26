import { describe, it, expect, vi } from "vitest";

vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ session: null }) }));
vi.mock("@/lib/playerBench/store", () => ({ benchStore: { subscribe: () => () => {}, get: () => ({ phase: "idle" }) } }));

import { refreshPage } from "@/components/BuildRefresh";

// La nouvelle version se charge par une navigation, pas un rechargement (26/10/2026) : sur un
// rechargement, WebKit fait revalider chaque image en cache — la bannière restait vide sur un lien lent.

const fakeLocation = (href: string, hash: string) => ({ href, hash, replace: vi.fn(), reload: vi.fn() });

describe("refreshPage", () => {
  it("sans `#`, une navigation vers la même adresse", () => {
    const loc = fakeLocation("https://app.example/", "");
    refreshPage(loc);
    expect(loc.replace).toHaveBeenCalledWith("https://app.example/");
    expect(loc.reload).not.toHaveBeenCalled();
  });

  it("avec un `#` (une fiche ouverte), le rechargement : une navigation n'y serait qu'un saut dans la page", () => {
    const loc = fakeLocation("https://app.example/#film=12", "#film=12");
    refreshPage(loc);
    expect(loc.reload).toHaveBeenCalled();
    expect(loc.replace).not.toHaveBeenCalled();
  });
});
