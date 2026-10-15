// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@/lib/persistentCache", async (original) => ({
  ...(await original<typeof import("@/lib/persistentCache")>()),
  persistedCacheAccount: () => "louis",
}));
import { PlaybackProvider } from "@/components/PlaybackProvider";
import { keepUnsentLine, unsentLines } from "@/lib/unsentLines";

/**
 * Les lignes en attente partent au retour du réseau (15/10/2026, LECTEUR-4).
 *
 * Une coupure en plein film est ce qui remplit la file ; ses lignes n'étaient renvoyées qu'au
 * prochain envoi réussi ou au tic de la minute — souvent après la fermeture de la page.
 */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const logPosts = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter(([url]) => url === "/api/player/log");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("les lignes en attente, au retour du réseau", () => {
  it("partent dès l'événement `online`, sans attendre la minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // Au lancement le serveur ne répond pas : la ligne reste en file.
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("Load failed")));
    vi.stubGlobal("fetch", fetchMock);
    keepUnsentLine("ligne-1", "network", { session: "s1", reason: "coupure" });
    render(<PlaybackProvider>{null}</PlaybackProvider>);
    await settle();
    expect(unsentLines()).toHaveLength(1);

    fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as never);
    const before = logPosts(fetchMock).length;
    act(() => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(logPosts(fetchMock).length).toBeGreaterThan(before);
    expect(unsentLines()).toHaveLength(0);
  });

  it("une seconde passe suit : `online` dit l'interface revenue, pas encore le serveur joignable", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("Load failed")));
    vi.stubGlobal("fetch", fetchMock);
    keepUnsentLine("ligne-2", "stall", { session: "s2" });
    render(<PlaybackProvider>{null}</PlaybackProvider>);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    act(() => void window.dispatchEvent(new Event("online")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(unsentLines()).toHaveLength(1);
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as never);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(unsentLines()).toHaveLength(0);
  });
});
