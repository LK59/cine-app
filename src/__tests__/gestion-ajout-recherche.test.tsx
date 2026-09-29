// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

// La recherche de la fenêtre « Ajouter » des pages Radarr et Sonarr faisait
// `setResults(await res.json())` sans lire `res.ok` : sur un 502, la fenêtre restait vide et
// muette ; une réponse vide ne disait rien non plus ; une erreur réseau devenait un rejet non
// géré. Les deux pages passent maintenant par `useLookupSearch`.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/useRole", () => ({
  useRole: () => ({ isReadOnly: false, role: "admin", jfId: null, jfUser: null }),
}));

import RadarrPage from "@/app/(dashboard)/radarr/page";
import SonarrPage from "@/app/(dashboard)/sonarr/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Lookup = { status: number; body: unknown } | "network";

function stubFetch(lookup: Lookup) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/lookup")) {
        if (lookup === "network") throw new TypeError("Failed to fetch");
        return {
          ok: lookup.status < 400,
          status: lookup.status,
          statusText: "",
          headers: new Headers(),
          json: async () => lookup.body,
        };
      }
      // Bibliothèque vide, méta de l'ajout.
      const body = url.endsWith("/meta") ? { qualityProfiles: [], rootFolders: [] } : [];
      return { ok: true, status: 200, headers: new Headers(), json: async () => body };
    }),
  );
}

const pages = [
  { name: "Radarr", Page: RadarrPage, open: "radarr.addMovie", input: "radarr.addMoviePlaceholder" },
  { name: "Sonarr", Page: SonarrPage, open: "sonarr.addSeries", input: "sonarr.addSeriesPlaceholder" },
];

async function search({ Page, open, input }: (typeof pages)[number]) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Page />
    </SWRConfig>,
  );
  fireEvent.click(await screen.findByText(open));
  const field = screen.getByPlaceholderText(input);
  fireEvent.change(field, { target: { value: "dune" } });
  fireEvent.submit(field.closest("form")!);
}

describe.each(pages)("ajout $name : la recherche dit son échec et son vide", (p) => {
  it("un 502 affiche une erreur, avec le message du serveur", async () => {
    stubFetch({ status: 502, body: { error: "Service injoignable" } });
    await search(p);
    expect(await screen.findByText("Service injoignable")).toBeInTheDocument();
    expect(screen.getByText("common.retry")).toBeInTheDocument();
  });

  it("une erreur réseau affiche une erreur au lieu d'un rejet non géré", async () => {
    stubFetch("network");
    await search(p);
    expect(await screen.findByText("common.retry")).toBeInTheDocument();
  });

  it("une réponse [] affiche « aucun résultat »", async () => {
    stubFetch({ status: 200, body: [] });
    await search(p);
    expect(await screen.findByText("search.noResults")).toBeInTheDocument();
  });
});
