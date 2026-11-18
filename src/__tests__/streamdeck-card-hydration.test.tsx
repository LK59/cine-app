// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("swr", () => ({ default: () => ({ data: { tokens: [] }, mutate: vi.fn() }) }));
vi.mock("@/components/settings/AdminTools", () => ({
  ConfigCardFrame: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import { StreamDeckCard } from "@/components/settings/StreamDeckCard";

// 18/11/2026 : l'adresse à saisir dans le plugin était lue au rendu (`window.location.origin`), vide côté
// serveur et pleine côté navigateur — erreur d'hydratation React #418 à chaque ouverture de la page
// Configuration → Administration.
describe("StreamDeckCard — hydratation", () => {
  it("s'hydrate sans désaccord, puis montre l'adresse de la page", async () => {
    const win = globalThis.window;
    // Le rendu serveur : pas de `window`.
    vi.stubGlobal("window", undefined);
    let html: string;
    try {
      html = renderToString(<StreamDeckCard />);
    } finally {
      vi.stubGlobal("window", win);
    }
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, <StreamDeckCard />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.querySelector("code")?.textContent).toBe(window.location.origin);
    vi.unstubAllGlobals();
  });
});
