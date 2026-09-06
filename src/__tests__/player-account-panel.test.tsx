// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

let payload: Record<string, unknown> = { username: "louis", jfUser: null };
vi.mock("swr", () => ({ default: () => ({ data: payload }) }));
vi.mock("@/lib/swr", () => ({ fetcher: async () => payload }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ["fr", vi.fn()],
}));
const errorToast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ error: errorToast, success: vi.fn() }) }));
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => <div /> }));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PlayerAccountPanel } from "@/components/player/PlayerAccountPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PlayerAccountPanel — known issues", () => {
  // La fiche n'est conditionnée à rien : elle est là pour qui la cherche, sans annoncer à
  // personne un problème qu'il n'a peut-être pas.
  it("always shows the card, whatever the browser", () => {
    render(<PlayerAccountPanel />);
    expect(screen.getByText("player.account.help.hdrTitle")).toBeTruthy();
    expect(screen.getByText("gfx.color_management.hdr")).toBeTruthy();
  });

  // Le nom du réglage se copie : on ne peut pas faire de lien vers about:config, et le retaper
  // sans faute est le seul endroit où l'utilisateur peut échouer.
  it("copies the setting name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<PlayerAccountPanel />);
    fireEvent.click(screen.getByText("player.account.help.copy"));

    expect(writeText).toHaveBeenCalledWith("gfx.color_management.hdr");
    expect(await screen.findByText("player.account.help.copied")).toBeTruthy();
  });

  // Un presse-papiers refusé — contexte non sécurisé, permission bloquée — laisse le texte à
  // l'écran : il reste sélectionnable, et le dire vaut mieux qu'un bouton qui ne fait rien.
  it("says so when the clipboard refuses", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });

    render(<PlayerAccountPanel />);
    fireEvent.click(screen.getByText("player.account.help.copy"));

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("player.account.help.copyFailed"));
    expect(screen.getByText("gfx.color_management.hdr")).toBeTruthy();
  });
});

// Jellyfin range ses préférences sous le nom terminologique de l'ISO 639-2 — `fra`, `deu` — et la
// liste de choix était écrite dans l'autre convention. Un compte réglé sur le français affichait
// donc « peu importe », et le premier réglage touché aurait effacé sa préférence.
describe("PlayerAccountPanel — playback preferences", () => {
  it("shows the language Jellyfin actually stored", async () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: "fra", subtitleLanguage: "fra", subtitleMode: "OnlyForced" };
    render(<PlayerAccountPanel />);

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const [audio, subtitles, mode] = selects.slice(-3);
    expect(audio.value).toBe("fra");
    expect(subtitles.value).toBe("fra");
    expect(mode.value).toBe("OnlyForced");
  });

  // La même langue écrite par un autre client, dans la forme bibliographique.
  it("recognises the other spelling of the same language", () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: "fre", subtitleLanguage: "ger", subtitleMode: "Default" };
    render(<PlayerAccountPanel />);

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects.slice(-3)[0].value).toBe("fra");
    expect(selects.slice(-3)[1].value).toBe("deu");
  });

  // Le mode « Smart » existe chez Jellyfin et manquait ici : un compte réglé dessus voyait le
  // premier de la liste, faute de correspondance.
  it("knows every subtitle mode Jellyfin can store", () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: null, subtitleLanguage: null, subtitleMode: "Smart" };
    render(<PlayerAccountPanel />);
    expect((screen.getAllByRole("combobox").slice(-1)[0] as HTMLSelectElement).value).toBe("Smart");
  });

  // Une langue hors de la courte liste doit rester visible : sinon le compte croit n'avoir rien
  // choisi, et l'efface en touchant autre chose.
  it("keeps a language it does not have a word for", () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: "rus", subtitleLanguage: null, subtitleMode: "Default" };
    render(<PlayerAccountPanel />);

    const audio = screen.getAllByRole("combobox").slice(-3)[0] as HTMLSelectElement;
    expect(audio.value).toBe("rus");
    expect(screen.getByText("RUS")).toBeTruthy();
  });
});
