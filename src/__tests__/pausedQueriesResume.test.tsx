// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import useSWR, { SWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";

let control: ReturnType<typeof usePlayback>;

/**
 * Le contexte remonté par un effet et non pendant le rendu : écrire dans une variable extérieure
 * au moment du rendu est un effet de bord, et le compilateur React le refuse — à raison.
 */
function Control() {
  const playback = usePlayback();
  useEffect(() => {
    control = playback;
  }, [playback]);
  return null;
}

/** Un écran ordinaire derrière le film — ici, celui qui décide du bouton Lire. */
function Consumer() {
  const { data } = useSWR<{ playerEnabled: boolean }>("/api/config/public", fetcher);
  return <span data-testid="config">{data === undefined ? "sans réponse" : "servi"}</span>;
}

function Harness({ withConsumer }: { withConsumer: boolean }) {
  return (
    // La vraie configuration de l'application : la pause est celle du lecteur.
    <SWRConfig value={{ isPaused: isWatchingFullScreen, provider: () => new Map(), dedupingInterval: 0 }}>
      <PlaybackProvider>
        <Control />
        {withConsumer && <Consumer />}
      </PlaybackProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ playerEnabled: true }) }))
  );
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Ce que la pause avalait, et ne rendait jamais.
 *
 * `isPaused` fait renoncer une requête sans erreur, et SWR ne la rejoue pas quand la pause se
 * lève. Un écran monté *pendant* une lecture plein écran restait donc sans données pour toujours —
 * la fiche derrière le film revenait sans son bouton Lire, sur une page par ailleurs vivante.
 */
describe("les requêtes sautées pendant une lecture plein écran", () => {
  it("repartent quand le film libère l'écran", async () => {
    const view = render(<Harness withConsumer={false} />);

    // Le film prend l'écran d'abord : c'est ce que fait la reprise après rechargement, dès le
    // montage, avant que quoi que ce soit ait pu être demandé.
    await act(async () => {
      control.play({ itemId: "x", title: "L'Exorciste" });
    });
    expect(isWatchingFullScreen()).toBe(true);

    // La fiche se monte derrière lui. Sa requête est avalée, sans erreur ni donnée.
    view.rerender(<Harness withConsumer />);
    await act(async () => {});
    expect(view.getByTestId("config").textContent).toBe("sans réponse");
    expect(fetch).not.toHaveBeenCalled();

    // On ferme le lecteur. Rien ne remonte cette fiche — c'est tout le problème.
    await act(async () => {
      control.close();
    });
    await waitFor(() => expect(view.getByTestId("config").textContent).toBe("servi"));
    expect(fetch).toHaveBeenCalledWith("/api/config/public");
  });
});
