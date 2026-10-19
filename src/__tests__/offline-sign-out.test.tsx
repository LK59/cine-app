// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

/**
 * Se déconnecter avec des téléchargements sur l'appareil (Louis, 20/10/2026) : la question d'abord —
 * les garder ou les effacer ; sans téléchargement, la déconnexion comme avant.
 */
const signOut = vi.fn(async () => {});
const removeAll = vi.fn(async (_account: string) => {});
let count = 0;
vi.mock("@/lib/signOut", () => ({ signOut: () => signOut(), hardNavigate: vi.fn() }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "louis" }));
vi.mock("@/lib/offline/downloads", () => ({ offlineDownloadCount: async () => count, removeAccountDownloads: (a: string) => removeAll(a) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));

import { useSignOut } from "@/components/offline/useSignOut";

function Button() {
  const { logout, sheet } = useSignOut();
  return (
    <>
      <button type="button" onClick={logout}>
        partir
      </button>
      {sheet}
    </>
  );
}

beforeEach(() => {
  signOut.mockClear();
  removeAll.mockClear();
});
afterEach(cleanup);

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("se déconnecter", () => {
  it("sans téléchargement : déconnecté tout de suite", async () => {
    count = 0;
    render(<Button />);
    fireEvent.click(screen.getByText("partir"));
    await tick();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("avec des téléchargements : les garder, ou les effacer avant de partir", async () => {
    count = 2;
    render(<Button />);
    fireEvent.click(screen.getByText("partir"));
    await tick();
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("player.downloads.signOutDelete"));
    await tick();
    expect(removeAll).toHaveBeenCalledWith("louis");
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
