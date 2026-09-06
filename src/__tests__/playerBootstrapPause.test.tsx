// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { useLegacyPlayer } from "@/lib/useLegacyPlayer";

function Ordinary() {
  const { data } = useSWR<unknown>("/api/cinema/movies", fetcher);
  return <span data-testid="ordinaire">{data === undefined ? "rien" : "servi"}</span>;
}

function Probe() {
  const { legacy } = useLegacyPlayer();
  return <span data-testid="legacy">{legacy === undefined ? "inconnu" : String(legacy)}</span>;
}

/**
 * Un film qui occupe l'écran ne doit pas empêcher de savoir comment le lire.
 *
 * `SWRProvider` suspend toute requête pendant une lecture plein écran — pour taire les sondages de
 * la page invisible derrière. Ça attrapait aussi la préférence « ancien lecteur », sans laquelle
 * PlayerHost ne rend rien du tout ; et comme la séance est rouverte dès le montage après le
 * rechargement que WebKit impose pour changer de piste audio, l'écran était déclaré occupé avant
 * que la réponse n'arrive. Elle n'arrivait plus jamais : plus de lecteur, plus de bouton Lire,
 * une recherche vide, et rien dans l'interface pour en sortir.
 */
function renderPaused() {
  return render(
    <SWRConfig value={{ isPaused: () => true, provider: () => new Map(), dedupingInterval: 0 }}>
      <Probe />
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ legacyPlayer: { enabled: true } }) }))
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("l'amorçage du lecteur sous pause globale", () => {
  it("répond quand même, alors que tout le reste est suspendu", async () => {
    const view = renderPaused();
    await waitFor(() => expect(view.getByTestId("legacy").textContent).toBe("true"));
    expect(fetch).toHaveBeenCalledWith("/api/user/preferences");
  });

  it("ne reste jamais sur « inconnu », qui est l'état où PlayerHost ne rend rien", async () => {
    const view = renderPaused();
    await waitFor(() => expect(view.getByTestId("legacy").textContent).not.toBe("inconnu"));
  });

  it("les autres requêtes, elles, restent bien suspendues", async () => {
    // La contrepartie, et elle compte autant : l'exemption doit être étroite. Si la pause cessait
    // de retenir le reste, on aurait échangé un blocage contre les réveils de radio qu'elle
    // existe pour empêcher.
    const view = render(
      <SWRConfig value={{ isPaused: () => true, provider: () => new Map(), dedupingInterval: 0 }}>
        <Ordinary />
      </SWRConfig>
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(view.getByTestId("ordinaire").textContent).toBe("rien");
    expect(fetch).not.toHaveBeenCalled();
  });
});
