// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import type { ReactNode } from "react";
import { followOnlyOptions, liveFeedOptions } from "@/lib/swr";

// 26/09/2026 : après un film, « Reprendre » gardait l'ancienne durée restante. SWR ne relit une
// clé que par le premier crochet inscrit sur elle, et la reprise instantanée — montée avant le
// cinéma — la suivait sans récupérateur : la relecture après la fermeture ne partait jamais.

const KEY = "/api/jellyfin/resume";

function Follower({ fetcher }: { fetcher: (k: string) => Promise<unknown> }) {
  useSWR(KEY, fetcher, followOnlyOptions);
  return null;
}
function Row({ fetcher, onMutate }: { fetcher: (k: string) => Promise<unknown>; onMutate: (m: () => Promise<unknown>) => void }) {
  useSWR(KEY, fetcher, liveFeedOptions);
  const { mutate } = useSWRConfig();
  onMutate(() => mutate(KEY));
  return null;
}

describe("followOnlyOptions", () => {
  it("ne demande rien au montage, mais porte la relecture quand il est inscrit le premier", async () => {
    const fetcher = vi.fn(async () => ({ items: [] }));
    let relire: () => Promise<unknown> = async () => {};
    const wrap = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    // Le suiveur seul : aucune requête.
    const { rerender } = render(<Follower fetcher={fetcher} />, { wrapper: wrap });
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    // La rangée arrive après lui, puis une relecture est demandée.
    rerender(
      <>
        <Follower fetcher={fetcher} />
        <Row fetcher={fetcher} onMutate={(m) => (relire = m)} />
      </>
    );
    await act(async () => {});
    const avant = fetcher.mock.calls.length;
    await act(async () => {
      await relire();
    });
    expect(fetcher.mock.calls.length).toBe(avant + 1);
  });
});
