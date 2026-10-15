// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { useCatalogueRefresh } from "@/lib/useCatalogueRefresh";
import { CATALOGUE_REFRESH_AFTER_MS, resetCatalogueRefreshForTests } from "@/lib/catalogueRefresh";
import { MOVIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { setWatchingFullScreen } from "@/lib/playbackBusy";
import { uiQuietForTests } from "@/lib/uiQuiet";

/**
 * Le crochet des deux accueils, avec le vrai SWR et le vrai récupérateur du catalogue (§94) : au
 * retour au premier plan passé un quart d'heure, une requête conditionnelle ; un 304 ne redessine
 * rien ; jamais pendant un film ni page cachée ; l'échéance passée pendant un film est rattrapée à
 * sa fermeture.
 */

const wire = (ids: number[]) => ({
  genres: ["Drame"],
  items: ids.map((id) => ({ radarrId: id, title: `Film ${id}`, genres: ["Drame"] })),
  rows: { Drame: ids },
  spotlight: ids,
  recentlyAdded: ids,
  top10: [],
  top10Theme: null,
});

let renders = 0;
let seen: unknown[] = [];
/** Chaque rendu de l'accueil, et chaque objet distinct que SWR lui a donné. */
function noteRender(data: unknown) {
  renders += 1;
  if (data && seen[seen.length - 1] !== data) seen.push(data);
}

function Home({ blocked }: { blocked: boolean }) {
  const { data } = useSWR<{ items: { title: string }[] }>(MOVIES_CATALOGUE_KEY, cinemaFetcher);
  useCatalogueRefresh(blocked);
  noteRender(data);
  return <p data-testid="titres">{data ? data.items.map((i) => i.title).join(",") : "…"}</p>;
}

function app(blocked = false) {
  const tree = (b: boolean) => (
    // Les réglages de `SWRProvider` : le catalogue ne se relit pas de lui-même au focus.
    <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, revalidateIfStale: true, dedupingInterval: 10000 }}>
      <Home blocked={b} />
    </SWRConfig>
  );
  const view = render(tree(blocked));
  return { ...view, setBlocked: (b: boolean) => view.rerender(tree(b)) };
}

let visibility: DocumentVisibilityState = "visible";
const requests: { url: string; ifNoneMatch: string | null }[] = [];
let answer: (url: string, ifNoneMatch: string | null) => Response;

function comeBack() {
  act(() => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  resetCatalogueRefreshForTests();
  uiQuietForTests.reset();
  setWatchingFullScreen(false);
  renders = 0;
  seen = [];
  requests.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  answer = () => new Response(JSON.stringify(wire([1, 2])), { status: 200, headers: { etag: 'W/"a"' } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"] ?? null;
      requests.push({ url, ifNoneMatch });
      return answer(url, ifNoneMatch);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function launched() {
  const view = app();
  await waitFor(() => expect(screen.getByTestId("titres").textContent).toBe("Film 1,Film 2"));
  expect(requests).toHaveLength(1);
  return view;
}

function later(ms = CATALOGUE_REFRESH_AFTER_MS + 1000) {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + ms);
}

describe("useCatalogueRefresh", () => {
  it("avant quinze minutes, un retour ne demande rien", async () => {
    await launched();
    later(CATALOGUE_REFRESH_AFTER_MS - 60_000);
    comeBack();
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1);
  });

  it("passé quinze minutes : If-None-Match, et un 304 ne pose aucun objet neuf — aucun rendu", async () => {
    await launched();
    const rendersBefore = renders;
    const dataBefore = seen.length;
    answer = () => new Response(null, { status: 304, headers: { etag: 'W/"a"' } });
    later();
    comeBack();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({ url: MOVIES_CATALOGUE_KEY, ifNoneMatch: 'W/"a"' });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.length).toBe(dataBefore);
    expect(renders).toBe(rendersBefore);
  });

  it("le cache HTTP du navigateur qui rend un 200 à la même étiquette : SWR reçoit l'objet qu'il tient", async () => {
    await launched();
    const held = seen[seen.length - 1];
    // La relecture ordinaire de SWR (reconnexion, filet d'une fiche) : même étiquette, corps reconstitué.
    answer = () => new Response(JSON.stringify(wire([1, 2])), { status: 200, headers: { etag: 'W/"a"' } });
    const again = await cinemaFetcher(MOVIES_CATALOGUE_KEY);
    expect(again).toBe(held);
  });

  it("un catalogue changé est posé : le titre arrivé paraît, le titre retiré part", async () => {
    await launched();
    answer = () => new Response(JSON.stringify(wire([3, 1])), { status: 200, headers: { etag: 'W/"b"' } });
    later();
    comeBack();
    await waitFor(() => expect(screen.getByTestId("titres").textContent).toBe("Film 3,Film 1"));
    // Et la lecture suivante part avec la nouvelle étiquette.
    answer = () => new Response(null, { status: 304 });
    later(2 * CATALOGUE_REFRESH_AFTER_MS + 5000);
    comeBack();
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].ifNoneMatch).toBe('W/"b"');
  });

  it("page cachée : rien", async () => {
    await launched();
    later();
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1);
  });

  it("jamais pendant un film ; l'échéance passée est rattrapée à la fermeture du lecteur", async () => {
    const view = await launched();
    view.setBlocked(true);
    setWatchingFullScreen(true);
    later();
    comeBack();
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1);
    answer = () => new Response(null, { status: 304 });
    setWatchingFullScreen(false);
    view.setBlocked(false);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].ifNoneMatch).toBe('W/"a"');
  });

  it("le focus et visibilitychange ensemble ne font qu'une requête", async () => {
    await launched();
    let release: () => void = () => undefined;
    answer = () => new Response(null, { status: 304 });
    const slow = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ url, ifNoneMatch: (init?.headers as Record<string, string> | undefined)?.["If-None-Match"] ?? null });
          release = () => resolve(new Response(null, { status: 304 }));
        })
    );
    vi.stubGlobal("fetch", slow);
    later();
    comeBack();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    comeBack();
    await waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("une copie de secours de la panne ne remplace pas les titres plus récents", async () => {
    await launched();
    const fresh = seen[seen.length - 1] as { items: unknown[] };
    answer = () =>
      new Response(JSON.stringify({ ...wire([1, 2, 99]), stale: true, jellyfinDown: true, savedAt: Date.now() - 3600_000 }), {
        status: 200,
        headers: { etag: 'W/"x"' },
      });
    later();
    comeBack();
    await waitFor(() => expect((seen[seen.length - 1] as { stale?: boolean }).stale).toBe(true));
    const held = seen[seen.length - 1] as { items: unknown[]; jellyfinDown?: boolean };
    expect(held.items).toBe(fresh.items);
    expect(held.jellyfinDown).toBe(true);
    expect(screen.getByTestId("titres").textContent).toBe("Film 1,Film 2");
  });
});
