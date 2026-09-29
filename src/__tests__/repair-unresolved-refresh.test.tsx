// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";

const cinemaNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: (...a: unknown[]) => cinemaNavigate(...a) }));
let fullScreen = false;
vi.mock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: () => fullScreen }));

import { useRepairUnresolvedSheet } from "@/lib/useRepairUnresolvedSheet";
import { MOVIES_CATALOGUE_KEY } from "@/lib/swr";

/**
 * Un titre importé pendant la séance ne s'ouvrait pas (audit A5, 29/09/2026).
 *
 * La notification « Disponible » mène à la fiche TMDB, dont « Voir » ouvre `film=<id>` — mais le
 * catalogue de l'accueil est figé pour la séance, et ce titre n'y était pas encore. Au bout de
 * 2 s, le filet effaçait l'adresse : la fiche n'apparaissait jamais. Même chose depuis Ma liste
 * ou une filmographie. Le filet relit désormais le catalogue une fois avant de conclure.
 */

const X = 42;

// La configuration de `SWRProvider`, sans la persistance.
const PROD_LIKE = {
  isPaused: () => fullScreen,
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  revalidateIfStale: true,
  dedupingInterval: 10000,
  keepPreviousData: true,
};

function setup(answers: number[][]) {
  let call = 0;
  const fetcher = vi.fn(async () => ({ ids: answers[Math.min(call++, answers.length - 1)] }));
  /** Ce que fait chaque client : la fiche se résout dans le catalogue qu'il tient. */
  function Client({ film }: { film: number | null }) {
    const { data } = useSWR<{ ids: number[] }>(MOVIES_CATALOGUE_KEY, fetcher);
    const resolved = film !== null && !!data?.ids.includes(film);
    useRepairUnresolvedSheet(film !== null ? `film=${film}` : null, resolved, data !== undefined, MOVIES_CATALOGUE_KEY);
    return <div data-testid="sheet">{resolved ? "ouverte" : "aucune"}</div>;
  }
  const provider = () => new Map();
  const ui = (film: number | null) => (
    <SWRConfig value={{ ...PROD_LIKE, provider }}>
      <Client film={film} />
    </SWRConfig>
  );
  return { fetcher, ui };
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  cinemaNavigate.mockClear();
  fullScreen = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRepairUnresolvedSheet relit le catalogue avant de conclure", () => {
  it("un titre arrivé depuis le chargement s'ouvre, et l'adresse reste", async () => {
    const { fetcher, ui } = setup([[1, 2], [1, 2, X]]);
    const { rerender, getByTestId } = render(ui(null));
    await tick(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Un quart d'heure plus tard, « Voir » sur la fiche de la notification.
    await tick(15 * 60_000);
    rerender(ui(X));
    await tick(50);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getByTestId("sheet").textContent).toBe("ouverte");
    await tick(5000);
    expect(cinemaNavigate).not.toHaveBeenCalled();
  });

  it("un titre toujours absent après la relecture : l'adresse est effacée comme avant", async () => {
    const { fetcher, ui } = setup([[1, 2]]);
    const { rerender, getByTestId } = render(ui(null));
    await tick(50);
    rerender(ui(X));
    await tick(50);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getByTestId("sheet").textContent).toBe("aucune");
    await tick(2500);
    expect(cinemaNavigate).toHaveBeenCalledWith({ film: null, serie: null, episodes: false }, "replace");
  });

  it("une seule relecture par titre demandé", async () => {
    const { fetcher, ui } = setup([[1, 2]]);
    const { rerender } = render(ui(null));
    await tick(50);
    rerender(ui(X));
    await tick(50);
    await tick(3000);
    // Le même titre redemandé : pas de seconde relecture, le filet conclut comme avant.
    rerender(ui(null));
    await tick(50);
    rerender(ui(X));
    await tick(3000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cinemaNavigate).toHaveBeenCalledTimes(2);
  });

  it("n'efface rien tant que la relecture n'a pas répondu", async () => {
    let release: (v: { ids: number[] }) => void = () => {};
    let call = 0;
    const fetcher = vi.fn(() =>
      call++ === 0 ? Promise.resolve({ ids: [1] }) : new Promise<{ ids: number[] }>((r) => { release = r; })
    );
    function Client({ film }: { film: number | null }) {
      const { data } = useSWR<{ ids: number[] }>(MOVIES_CATALOGUE_KEY, fetcher);
      const resolved = film !== null && !!data?.ids.includes(film);
      useRepairUnresolvedSheet(film !== null ? `film=${film}` : null, resolved, data !== undefined, MOVIES_CATALOGUE_KEY);
      return null;
    }
    const provider = () => new Map();
    const ui = (film: number | null) => (
      <SWRConfig value={{ ...PROD_LIKE, provider }}><Client film={film} /></SWRConfig>
    );
    const { rerender } = render(ui(null));
    await tick(50);
    rerender(ui(X));
    // Une connexion lente : la réponse arrive après le délai de grâce d'autrefois.
    await tick(6000);
    expect(cinemaNavigate).not.toHaveBeenCalled();
    await act(async () => { release({ ids: [1, X] }); await vi.advanceTimersByTimeAsync(50); });
    await tick(5000);
    expect(cinemaNavigate).not.toHaveBeenCalled();
  });

  it("attend que l'écran soit libéré : une relecture en pause serait jetée", async () => {
    // SWR abandonne une requête lancée pendant qu'un film occupe l'écran : relire à ce moment-là,
    // c'était conclure sur le catalogue d'avant.
    const { fetcher, ui } = setup([[1], [1, X]]);
    const { rerender, getByTestId } = render(ui(null));
    await tick(50);
    fullScreen = true;
    rerender(ui(X));
    await tick(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cinemaNavigate).not.toHaveBeenCalled();
    fullScreen = false;
    await tick(500);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getByTestId("sheet").textContent).toBe("ouverte");
  });
});
