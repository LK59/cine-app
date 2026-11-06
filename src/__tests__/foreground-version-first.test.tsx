// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ session: null }) }));
vi.mock("@/lib/playerBench/store", () => ({ benchStore: { subscribe: () => () => {}, get: () => ({ phase: "idle" }) } }));
vi.mock("@/lib/appBuild", async (importOriginal) => ({ ...(await importOriginal<object>()), APP_BUILD: "build-a" }));
// Pas d'IndexedDB sous jsdom : le cache gardé sur l'appareil n'a rien à faire ici.
vi.mock("@/lib/persistentCache", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hydrateFromDisk: async () => 0,
  startPersistence: () => {},
  persistMiddleware: (useSWRNext: unknown) => useSWRNext,
}));

import useSWR, { SWRConfig, unload } from "swr";
import { SWRProvider } from "@/components/SWRProvider";
import { BuildRefresh } from "@/components/BuildRefresh";
import { fetcher, liveFeedOptions, RESUME_KEY } from "@/lib/swr";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { useCatalogueRefresh } from "@/lib/useCatalogueRefresh";
import { CATALOGUE_REFRESH_AFTER_MS, resetCatalogueRefreshForTests } from "@/lib/catalogueRefresh";
import { MOVIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { setWatchingFullScreen } from "@/lib/playbackBusy";
import { uiQuietForTests } from "@/lib/uiQuiet";

/**
 * Au retour au premier plan, la version d'abord (DECISIONS.md §134), avec le vrai `SWRProvider`, le
 * vrai `BuildRefresh` et le vrai crochet du catalogue. Le 06/11/2026, un iPhone revenu après un
 * déploiement relisait « Reprendre » et les catalogues sur l'ancienne page, puis se rechargeait et
 * redemandait tout : 141 requêtes en 8 s.
 */

const wire = { genres: [], items: [{ radarrId: 1, title: "Film 1", genres: [] }], rows: {}, spotlight: [1], recentlyAdded: [1], top10: [], top10Theme: null };

function Home() {
  const { data: resume } = useSWR<{ items: unknown[] }>(RESUME_KEY, fetcher, liveFeedOptions);
  const { data: movies } = useSWR<{ items: unknown[] }>(MOVIES_CATALOGUE_KEY, cinemaFetcher);
  useCatalogueRefresh(false);
  return <p data-testid="etat">{resume && movies ? "prêt" : "…"}</p>;
}

let visibility: DocumentVisibilityState = "visible";
const requests: string[] = [];
let versionAnswer: (build: string) => void = () => {};

beforeEach(() => {
  resetCatalogueRefreshForTests();
  uiQuietForTests.reset();
  setWatchingFullScreen(false);
  sessionStorage.clear();
  // Le cache global de SWR, requêtes en vol comprises, vidé d'un test à l'autre.
  unload({ revalidate: false });
  requests.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url === "/api/version") {
        const build = await new Promise<string>((resolve) => (versionAnswer = resolve));
        return new Response(JSON.stringify({ build }), { status: 200 });
      }
      if (url === RESUME_KEY) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify(wire), { status: 200, headers: { etag: 'W/"a"' } });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function launchedThenBack({ gate = true } = {}) {
  render(
    <SWRProvider>
      {/* Sans dédoublonnage : la requête du montage, à quelques millisecondes, masquerait la relecture
          au focus — et un test qui passe parce que SWR a dédoublonné ne prouve rien. */}
      <SWRConfig value={{ dedupingInterval: 0 }}>
        <Home />
      </SWRConfig>
      {gate && <BuildRefresh />}
    </SWRProvider>
  );
  await waitFor(() => expect(screen.getByTestId("etat").textContent).toBe("prêt"));
  // Seize minutes plus tard : « Reprendre » (30 s) et le catalogue (15 min) sont dus au retour.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + CATALOGUE_REFRESH_AFTER_MS + 60_000);
  requests.length = 0;
  act(() => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  act(() => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  // Le temps que la relecture au focus de SWR (un `setTimeout`) ait eu sa chance.
  await act(() => new Promise((r) => setTimeout(r, 50)));
}

describe("retour au premier plan : la version d'abord", () => {
  it("témoin, sans BuildRefresh (ni porte) : « Reprendre » et le catalogue partent aussitôt", async () => {
    await launchedThenBack({ gate: false });
    expect(requests).toEqual(expect.arrayContaining([RESUME_KEY, MOVIES_CATALOGUE_KEY]));
  });

  it("même build : « Reprendre » et le catalogue partent après la réponse", async () => {
    await launchedThenBack();
    // La question de version est partie, seule.
    expect(requests).toEqual(["/api/version"]);
    await act(async () => versionAnswer("build-a"));
    await waitFor(() => expect(requests).toEqual(expect.arrayContaining([RESUME_KEY, MOVIES_CATALOGUE_KEY])));
    expect(requests[0]).toBe("/api/version");
  });

  it("nouveau build, rechargement permis : rien ne part avant le rechargement", async () => {
    await launchedThenBack();
    expect(requests).toEqual(["/api/version"]);
    await act(async () => versionAnswer("build-b"));
    // Le rechargement a eu lieu (sa garde contre la boucle est posée)…
    await waitFor(() => expect(sessionStorage.getItem("cine:build-reloaded-for")).toBe("build-b"));
    // … et l'ancienne page n'a rien relu, même passé le délai de réponse.
    await act(() => new Promise((r) => setTimeout(r, 1700)));
    expect(requests).toEqual(["/api/version"]);
  });
});
