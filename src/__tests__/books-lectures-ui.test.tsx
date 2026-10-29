// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

/**
 * Les écrans du §129 : le segment « À lire » de Ma liste — seulement quand les livres sont affichés pour
 * ce compte, jamais choisi d'office, ses livres touchés ouvrant leur fiche dans la catégorie Livres — et
 * la vue « Lectures » de l'activité. Le serveur est simulé clé par clé.
 */
let answers: Record<string, unknown> = {};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (key: string) => {
    const path = key.split("?")[0];
    if (!(path in answers)) throw new Error(`pas de réponse pour ${key}`);
    return answers[path];
  },
}));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const mockNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaNavigate: (...a: unknown[]) => mockNavigate(...a),
  cinemaClose: vi.fn(),
  openLibraryTitle: vi.fn(),
}));
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, cancelRequest: vi.fn(), setStatus: vi.fn(), request: vi.fn() }),
}));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { PlayerListPanel } from "@/components/player/PlayerListPanel";
import { ActivityReadings } from "@/components/activity/views/ActivityReadings";
import { useState } from "react";
import { waitFor } from "@testing-library/react";
import { useReaderPrefsSync } from "@/lib/books/readerPrefsSync";
import { defaultReaderPrefs, type ReaderPrefs } from "@/lib/books/readerPrefs";

/** Le lecteur réduit à ses réglages : ce qu'il montre, et un geste qui change la taille du texte. */
function PrefsProbe({ offline = false }: { offline?: boolean }) {
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => ({ ...defaultReaderPrefs(), theme: "light" }));
  useReaderPrefsSync(prefs, setPrefs, offline);
  return (
    <button type="button" onClick={() => setPrefs((p) => ({ ...p, fontSize: 140 }))}>
      {prefs.theme}/{prefs.fontSize}
    </button>
  );
}

describe("les réglages du lecteur entre l'appareil et le serveur", () => {
  let calls: { url: string; method: string; body: string }[];
  let answer: () => Promise<Response>;
  beforeEach(() => {
    calls = [];
    localStorage.clear();
    // Un appareil qui a déjà parlé au serveur : la règle ordinaire (l'amorçage a son propre test).
    localStorage.setItem("laterna:books:reader-synced", "1");
    answer = async () => new Response(JSON.stringify({ prefs: { ...defaultReaderPrefs(), theme: "sepia" }, own: false }), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
        return init?.method === "PUT" ? new Response("{}", { status: 200 }) : answer();
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ouvre sur la copie de l'appareil, puis prend ceux du compte — sans les renvoyer", async () => {
    render(<PrefsProbe />);
    expect(screen.getByRole("button").textContent).toBe("light/100");
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("sepia/100"));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0].url).toBe("/api/books/reader-prefs?device=ordinateur");
  });

  it("au premier échange, des réglages faits sur l'appareil avant (pas ceux d'origine) partent comme les siens au lieu d'être remplacés", async () => {
    localStorage.removeItem("laterna:books:reader-synced");
    render(<PrefsProbe />);
    await waitFor(() => expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]));
    expect(screen.getByRole("button").textContent).toBe("light/100");
    expect(JSON.parse(calls[1].body)).toMatchObject({ device: "ordinateur", prefs: { theme: "light" } });
    expect(localStorage.getItem("laterna:books:reader-synced")).toBe("1");
  });

  it("au premier échange, un appareil aux réglages d'origine prend ceux du compte", async () => {
    localStorage.removeItem("laterna:books:reader-synced");
    function Plain() {
      const [prefs, setPrefs] = useState<ReaderPrefs>(() => defaultReaderPrefs());
      useReaderPrefsSync(prefs, setPrefs, false);
      return <span>{prefs.theme}</span>;
    }
    render(<Plain />);
    await waitFor(() => expect(screen.getByText("sepia")).toBeTruthy());
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("un geste fait avant la réponse l'emporte, et part une seconde après", async () => {
    let release: () => void = () => {};
    const late = new Promise<void>((r) => (release = r));
    const original = answer;
    answer = async () => {
      await late;
      return original();
    };
    render(<PrefsProbe />);
    fireEvent.click(screen.getByRole("button"));
    release();
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true), { timeout: 2500 });
    expect(screen.getByRole("button").textContent).toBe("light/140");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body)).toMatchObject({ device: "ordinateur", prefs: { theme: "light", fontSize: 140 } });
    // Partie : la marque d'attente est retirée.
    await waitFor(() => expect(localStorage.getItem("laterna:books:reader-pending")).toBeNull());
  });

  it("hors ligne, rien ne part : la marque attend la prochaine ouverture, qui envoie d'abord la copie de l'appareil", async () => {
    const { unmount } = render(<PrefsProbe offline />);
    fireEvent.click(screen.getByRole("button"));
    expect(calls).toHaveLength(0);
    expect(localStorage.getItem("laterna:books:reader-pending")).toMatch(/ordinateur/);
    unmount();
    render(<PrefsProbe />);
    await waitFor(() => expect(calls.map((c) => c.method)).toEqual(["PUT"]));
  });
});

const BOOK = "a".repeat(32);
const LISTS = { requests: [], watched: [], toWatch: [{ tmdbId: 603, type: "movie", title: "Matrix", year: 1999, poster: null, libraryId: 42, jellyfinId: null }] };
const LISTED = {
  books: [{ id: BOOK, name: "Terremer", coverTag: null, fileTag: null, seriesName: null, index: null, year: 1968, authors: ["Ursula K. Le Guin"], genres: [], addedAt: null, played: false, progress: null, listedAt: 1 }],
};

const wrap = (node: ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("« À lire » dans Ma liste", () => {
  it("absent quand les livres ne sont pas affichés pour ce compte — et sans requête de la liste", async () => {
    answers = { "/api/player/lists": LISTS, "/api/config/public": { booksEnabled: false } };
    wrap(<PlayerListPanel />);
    expect(await screen.findByText("Matrix")).toBeTruthy();
    expect(screen.queryByText(/player\.lists\.toRead/)).toBeNull();
  });

  it("présent après « À voir », jamais choisi d'office ; ses livres ouvrent leur fiche dans la catégorie Livres", async () => {
    answers = { "/api/player/lists": { ...LISTS, toWatch: [] }, "/api/config/public": { booksEnabled: true }, "/api/books/list": LISTED };
    wrap(<PlayerListPanel />);
    const chip = await screen.findByText("player.lists.toRead");
    const chips = screen.getAllByRole("button", { pressed: false }).concat(screen.getAllByRole("button", { pressed: true })).map((b) => b.textContent ?? "");
    expect(chips.some((c) => c.startsWith("player.lists.toWatch"))).toBe(true);
    // « À voir » est vide et « À lire » a un livre : Ma liste s'ouvre quand même sur « À voir », comme avant.
    expect(screen.getByText("player.lists.empty.toWatch")).toBeTruthy();
    fireEvent.click(chip);
    // Le titre est deux fois sur la carte : la couverture dessinée et la légende.
    fireEvent.click((await screen.findAllByText("Terremer"))[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ books: true, book: BOOK, reading: false });
  });
});

describe("« Lectures » dans l'activité", () => {
  it("chaque compte : ses livres en cours avec l'appareil, ses terminés, et le fil", async () => {
    const now = Date.parse("2026-10-29T20:00:00Z");
    answers = {
      "/api/admin/activity/books": {
        now,
        accounts: [
          {
            account: "lucas",
            inProgress: [{ id: BOOK, title: "Terremer", author: "Ursula K. Le Guin", fraction: 0.42, at: now - 3_600_000, device: "iPhone" }],
            finished: [{ id: "b".repeat(32), title: "Dune", author: "Frank Herbert", fraction: 1, at: now - 86_400_000, device: null }],
            week: { ms: 5_400_000, sessions: 3 },
            month: { ms: 9_000_000, sessions: 6 },
            lastReadAt: now - 3_600_000,
          },
        ],
        recent: [{ at: now - 3_600_000, kind: "séance", account: "lucas", title: "Terremer", durationMs: 1_800_000, device: "iPhone", deviceType: "telephone", offline: true }],
      },
    };
    wrap(<ActivityReadings />);
    expect((await screen.findAllByText("lucas")).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("reading-book")).toHaveLength(2);
    expect(screen.getAllByTestId("reading-book")[0].textContent).toMatch(/Terremer.*Ursula K. Le Guin/);
    expect(screen.getByText(/42 %/).textContent).toMatch(/iPhone/);
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByTestId("reading-event").textContent).toMatch(/activity\.readings\.eventSession.*activity\.readings\.offline/);
  });
});
