// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { SWRProvider } from "@/components/SWRProvider";
import { useLegacyPlayer } from "@/lib/useLegacyPlayer";
import { setWatchingFullScreen } from "@/lib/playbackBusy";

/**
 * Ce que ce banc protège : une séance en cours survit à une adresse publique.
 *
 * `useLegacyPlayer` ne pose plus la question sur un chemin public — sa clé SWR passe à `null` —
 * et `PlayerHost` ne rend **rien** tant que la réponse est inconnue (`legacy === undefined`,
 * PlayerHost.tsx). Entre les deux, une seule chose empêche le film de disparaître quand on
 * ouvre la page d'état avec le mini-lecteur en cours : `keepPreviousData: true`, posé une fois
 * pour toute l'application dans `SWRProvider`, qui rend la valeur précédente quand la clé
 * devient nulle.
 *
 * Trois fichiers, trois décisions prises séparément, et aucun ne cite les deux autres. D'où ce
 * banc : il monte le vrai `SWRProvider`, pas une configuration de test, pour que retirer
 * l'option là-bas fasse rougir ici plutôt que disparaître un film chez quelqu'un.
 */

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

function Probe({ seen }: { seen: Array<boolean | undefined> }) {
  const { legacy } = useLegacyPlayer();
  seen.push(legacy);
  return <span data-testid="legacy">{String(legacy)}</span>;
}

/** Une racine neuve à chaque rendu : sans cela le cache SWR d'un test répondrait au suivant. */
function mount(seen: Array<boolean | undefined>) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <SWRProvider>
        <Probe seen={seen} />
      </SWRProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  pathname.current = "/";
  // Une séance qui occupe l'écran, c'est-à-dire le cas où le couplage se joue. `SWRProvider`
  // suspend tout dans cet état ; `playerBootstrapOptions` est précisément ce qui exempte cette
  // requête-là, et le banc n'aurait rien prouvé sans lui.
  setWatchingFullScreen(true);
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ legacyPlayer: { enabled: true } }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  setWatchingFullScreen(false);
  vi.restoreAllMocks();
});

describe("useLegacyPlayer sur un chemin public, séance en cours", () => {
  it("garde la préférence déjà connue quand on navigue vers une adresse publique", async () => {
    const seen: Array<boolean | undefined> = [];
    const { rerender, getByTestId } = mount(seen);
    await waitFor(() => expect(getByTestId("legacy").textContent).toBe("true"));

    // La navigation : même arbre, même séance, seule l'adresse change — et elle est publique,
    // donc la clé de la requête devient nulle.
    pathname.current = "/status";
    rerender(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SWRProvider>
          <Probe seen={seen} />
        </SWRProvider>
      </SWRConfig>
    );

    // Le film survit : jamais `undefined`, donc `PlayerHost` ne repasse jamais par son
    // `return null`. C'est un seul `undefined` transitoire qui coupe la lecture.
    expect(getByTestId("legacy").textContent).toBe("true");
    expect(seen.slice(seen.indexOf(true))).not.toContain(undefined);
  });

  it("ne demande plus rien une fois sur l'adresse publique", async () => {
    const seen: Array<boolean | undefined> = [];
    const { rerender, getByTestId } = mount(seen);
    await waitFor(() => expect(getByTestId("legacy").textContent).toBe("true"));
    const callsBefore = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    pathname.current = "/login";
    rerender(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SWRProvider>
          <Probe seen={seen} />
        </SWRProvider>
      </SWRConfig>
    );

    // Le défaut d'origine : `/api/user/preferences` répond 401 sans session, et
    // `errorRetryInterval: 1500` en faisait une requête toutes les secondes et demie.
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  /**
   * La démonstration du couplage, dans l'autre sens.
   *
   * Même arbre, `keepPreviousData` remis à `false` par-dessus la configuration globale : la
   * valeur retombe à `undefined` dès que la clé devient nulle — soit exactement l'entrée du
   * `return null` de `PlayerHost`, film compris. Ce n'est pas un défaut à corriger ici, c'est
   * ce que le test du dessus achète.
   */
  it("retomberait à « je ne sais pas » sans keepPreviousData", async () => {
    const seen: Array<boolean | undefined> = [];
    const tree = (path: string) => {
      pathname.current = path;
      return (
        <SWRConfig value={{ provider: () => new Map() }}>
          <SWRProvider>
            <SWRConfig value={{ keepPreviousData: false }}>
              <Probe seen={seen} />
            </SWRConfig>
          </SWRProvider>
        </SWRConfig>
      );
    };
    const { rerender, getByTestId } = render(tree("/"));
    await waitFor(() => expect(getByTestId("legacy").textContent).toBe("true"));

    rerender(tree("/status"));
    expect(getByTestId("legacy").textContent).toBe("undefined");
  });
});
