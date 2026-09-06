// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

let payload: Record<string, unknown> | null = null;
vi.mock("@/lib/swr", () => ({ fetcher: async () => payload }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const mockAction = vi.fn(async () => ({}));
vi.mock("@/lib/apiAction", () => ({ apiAction: (...a: unknown[]) => mockAction(...(a as [])) }));

import { useJellyfinItemState } from "@/lib/useJellyfinItemState";

function Probe({ itemId }: { itemId: string | null }) {
  const { watched, known, busy, toggleWatched } = useJellyfinItemState(itemId);
  return (
    <SWRConfigless>
      <span data-testid="state">{`${known ? "connu" : "inconnu"}/${watched ? "vu" : "pas-vu"}/${busy ? "occupé" : "libre"}`}</span>
      <button onClick={toggleWatched}>basculer</button>
    </SWRConfigless>
  );
}
function SWRConfigless({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

function renderProbe(itemId: string | null = "jf1") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Probe itemId={itemId} />
    </SWRConfig>
  );
}

const state = () => screen.getByTestId("state").textContent;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useJellyfinItemState", () => {
  it("reads what Jellyfin says", async () => {
    payload = { played: true, favorite: false, known: true, resumeTicks: null, runtimeTicks: null };
    renderProbe();
    await waitFor(() => expect(state()).toBe("connu/vu/libre"));
  });

  // Le cœur de la correction : une lecture ratée valait « pas vu », sur un bouton qui écrit. On
  // proposait donc de marquer comme vu un film déjà vu, et le geste changeait la donnée.
  it("refuses to act while it does not know", async () => {
    payload = { played: false, favorite: false, known: false, resumeTicks: null, runtimeTicks: null };
    renderProbe();
    await waitFor(() => expect(state()).toBe("inconnu/pas-vu/occupé"));

    fireEvent.click(screen.getByText("basculer"));
    expect(mockAction).not.toHaveBeenCalled();
  });

  it("says nothing at all before the answer arrives", () => {
    payload = { played: true, favorite: false, known: true, resumeTicks: null, runtimeTicks: null };
    renderProbe();
    // Au premier rendu la réponse n'est pas là : l'état est inconnu, et donc intouchable.
    expect(state()).toBe("inconnu/pas-vu/occupé");
  });

  it("writes once it knows", async () => {
    payload = { played: false, favorite: false, known: true, resumeTicks: null, runtimeTicks: null };
    renderProbe();
    await waitFor(() => expect(state()).toBe("connu/pas-vu/libre"));

    fireEvent.click(screen.getByText("basculer"));
    await waitFor(() => expect(mockAction).toHaveBeenCalledWith("/api/jellyfin/played", expect.anything()));
    expect(JSON.parse((mockAction.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({
      itemId: "jf1",
      played: true,
    });
  });

  it("asks nothing without an item", () => {
    payload = null;
    renderProbe(null);
    expect(state()).toBe("inconnu/pas-vu/occupé");
  });
});
