// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { useEffect, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import { fakeIndexedDb } from "./helpers/fakeIndexedDb";
import { SWRProvider } from "@/components/SWRProvider";
import {
  PERSISTED_CACHE_SCHEMA,
  catalogueCacheReady,
  flushPersistentWritesForTests,
  readAccountCache,
  resetPersistentCacheForTests,
  writeEntries,
} from "@/lib/persistentCache";
import { MOVIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";

/**
 * Le chemin complet, avec le vrai SWR : l'écran s'affiche sur le cache, la donnée est aussitôt
 * redemandée, la réponse fraîche remplace l'ancienne et part sur le disque pour la fois suivante.
 */

function Screen({ fetcher }: { fetcher: (key: string) => Promise<{ title: string }> }) {
  const { data } = useSWR<{ title: string }>(MOVIES_CATALOGUE_KEY, fetcher);
  return <p data-testid="titre">{data?.title ?? "chargement"}</p>;
}

/** Comme la page du cinéma : ne se monte qu'une fois le cache relu. */
function Gate({ fetcher }: { fetcher: (key: string) => Promise<{ title: string }> }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void catalogueCacheReady(2000).then(() => setReady(true));
  }, []);
  return ready ? <Screen fetcher={fetcher} /> : null;
}

function app(account: string | null, fetcher: (key: string) => Promise<{ title: string }>) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <SWRProvider account={account}>
        <Gate fetcher={fetcher} />
      </SWRProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  resetPersistentCacheForTests();
  vi.stubGlobal("indexedDB", fakeIndexedDb());
});
afterEach(() => vi.unstubAllGlobals());

describe("le catalogue à l'ouverture", () => {
  it("s'affiche depuis le cache, puis se rafraîchit aussitôt, en une seule requête", async () => {
    await writeEntries([{ account: "louis", key: MOVIES_CATALOGUE_KEY, savedAt: Date.now(), schema: PERSISTED_CACHE_SCHEMA, data: { title: "hier" } }]);
    let answer: (value: { title: string }) => void = () => {};
    const fetcher = vi.fn(() => new Promise<{ title: string }>((resolve) => (answer = resolve)));
    app("louis", fetcher);

    await waitFor(() => expect(screen.getByTestId("titre").textContent).toBe("hier"));
    // Une donnée présente est revalidée à l'image suivante (SWR passe par `requestAnimationFrame`).
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => answer({ title: "aujourd'hui" }));
    await waitFor(() => expect(screen.getByTestId("titre").textContent).toBe("aujourd'hui"));

    // Réécrite pour la prochaine ouverture.
    flushPersistentWritesForTests();
    await waitFor(async () => {
      const [saved] = await readAccountCache("louis");
      expect(saved.data).toEqual({ title: "aujourd'hui" });
    });
  });

  it("sans cache, se comporte comme avant", async () => {
    const fetcher = vi.fn(async () => ({ title: "réseau" }));
    app("louis", fetcher);
    await waitFor(() => expect(screen.getByTestId("titre").textContent).toBe("réseau"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ne montre jamais le cache d'un autre compte", async () => {
    await writeEntries([{ account: "lucas", key: MOVIES_CATALOGUE_KEY, savedAt: Date.now(), schema: PERSISTED_CACHE_SCHEMA, data: { title: "chez lucas" } }]);
    let answer: (value: { title: string }) => void = () => {};
    const fetcher = vi.fn(() => new Promise<{ title: string }>((resolve) => (answer = resolve)));
    app("louis", fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.getByTestId("titre").textContent).toBe("chargement");
    await act(async () => answer({ title: "chez louis" }));
    await waitFor(() => expect(screen.getByTestId("titre").textContent).toBe("chez louis"));
  });
});
