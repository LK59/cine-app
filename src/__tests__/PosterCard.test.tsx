// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({ useRole: () => mockUseRole() }));

import { PosterCard, type PosterCardItem } from "@/components/PosterCard";

const base: PosterCardItem = {
  tmdbId: 42,
  title: "Un Film",
  year: 2020,
  posterUrl: null,
  rating: 7.1,
  inLibrary: false,
  libraryHref: null,
};

function renderCard(item: Partial<PosterCardItem> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PosterCard item={{ ...base, ...item }} mediaType="movie" />
    </SWRConfig>
  );
}

/** La feuille d'actions ouverte — les mêmes libellés existent aussi dans le survol de la carte. */
function sheet() {
  return within(document.querySelector("[data-action-sheet]") as HTMLElement);
}

/** Ses entrées, dans l'ordre où elle les écrit. */
function sheetLabels(): string[] {
  return sheet().getAllByRole("button").map((b) => b.textContent?.trim() ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

beforeEach(() => {
  mockUseRole.mockReturnValue({ role: "admin" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
  }));
});

describe("carte d'affiche", () => {
  async function openSheet() {
    const user = userEvent.setup();
    await user.click(screen.getByTitle("common.moreOptions"));
    return user;
  }

  it("ne propose pas de demander un titre déjà dans la bibliothèque", async () => {
    renderCard({ inLibrary: true, libraryHref: "/radarr/7" });
    await openSheet();

    expect(sheet().queryByText("recommendations.request")).not.toBeInTheDocument();
    expect(sheet().getByText("recommendations.viewSheet")).toBeInTheDocument();
  });

  it("propose de demander un titre absent, et pas d'aller voir une fiche qui n'existe pas", async () => {
    renderCard();
    await openSheet();

    expect(sheet().getByText("recommendations.request")).toBeInTheDocument();
    expect(sheet().queryByText("recommendations.viewSheet")).not.toBeInTheDocument();
  });

  it("dit « demandé » sans proposer de le redemander quand la demande est déjà partie", async () => {
    renderCard({ pending: true });
    await openSheet();

    const already = sheet().getByText("recommendations.requestSent");
    expect(already).toBeInTheDocument();
    expect(already.closest("button")).toBeDisabled();
  });

  it("ouvre sur les actions, les statuts de liste venant après sous leur intitulé", async () => {
    renderCard({ inLibrary: true, libraryHref: "/radarr/7" });
    await openSheet();

    const labels = sheetLabels();
    const fiche = labels.findIndex((l) => l.includes("recommendations.viewSheet"));
    const premierStatut = labels.findIndex((l) => l.includes("watchlist.statuses.toWatch"));
    expect(fiche).toBeGreaterThanOrEqual(0);
    expect(premierStatut).toBeGreaterThan(fiche);
    expect(sheet().getByText("watchlist.pageTitle")).toBeInTheDocument();
  });

  it("ne propose la recherche interactive qu'à un admin, et seulement hors bibliothèque", async () => {
    renderCard();
    await openSheet();
    expect(sheet().getByText("recommendations.interactiveSearch")).toBeInTheDocument();

    cleanup();
    mockUseRole.mockReturnValue({ role: "user" });
    renderCard();
    await openSheet();
    expect(sheet().queryByText("recommendations.interactiveSearch")).not.toBeInTheDocument();
  });
});
