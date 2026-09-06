// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

let respond: () => Promise<unknown> = async () => ({});
// Le module entier, moins son `fetcher` : il porte aussi les options d'amorçage du lecteur, sans
// lesquelles le hook ne se configure plus. Un bouchon partiel plutôt qu'un remplacement.
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: () => respond(),
}));

import { useLegacyPlayer } from "@/lib/useLegacyPlayer";

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

afterEach(cleanup);

describe("useLegacyPlayer", () => {
  it("does not know yet before the answer arrives", () => {
    respond = () => new Promise(() => {});
    const { result } = renderHook(() => useLegacyPlayer(), { wrapper });
    expect(result.current.legacy).toBeUndefined();
  });

  it("reports what the account asked for", async () => {
    respond = async () => ({ legacyPlayer: { enabled: true } });
    const { result } = renderHook(() => useLegacyPlayer(), { wrapper });
    await waitFor(() => expect(result.current.legacy).toBe(true));
  });

  // La régression : le lecteur d'accueil est monté par la racine, donc aussi sur la page de
  // connexion, où cette route répond 401. SWR retenait l'échec, la valeur restait indéfinie, et
  // PlayerHost — qui ne rend rien tant qu'il ne sait pas — laissait le bouton Lire inerte jusqu'à
  // ce qu'on recharge la page.
  it("settles on the native player when the answer fails rather than staying unknown", async () => {
    respond = async () => {
      throw new Error("401");
    };
    const { result } = renderHook(() => useLegacyPlayer(), { wrapper });
    await waitFor(() => expect(result.current.legacy).toBe(false));
  });
});
