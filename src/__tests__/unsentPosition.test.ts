// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// C — la position de reprise pendant une coupure (DECISIONS.md §78) : gardée sur l'appareil quand
// Jellyfin ne la reçoit pas, effacée dès qu'un rapport plus récent passe, renvoyée au retour du réseau
// ou au lancement suivant par la route d'arrêt marquée `late`.

let account = "louis";
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => account }));

import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { clearUnsentPosition, findUnsentPositions, flushUnsentPositions, saveUnsentPosition } from "@/lib/unsentPosition";

const session = { itemId: "film-1", playSessionId: "s-1", mediaSourceId: "m-1" };
let online = true;
let posted: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  localStorage.clear();
  account = "louis";
  posted = [];
  online = true;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!online) throw new TypeError("Failed to fetch");
    posted.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, json: async () => ({}) };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => void (await Promise.resolve()));
};

describe("la position d'une coupure", () => {
  it("un battement qui ne passe pas garde la position sur l'appareil ; le suivant qui passe l'efface", async () => {
    let at = 0;
    renderHook(() => usePlaybackSession(() => at, session));
    online = false;
    at = 1200;
    await act(async () => void vi.advanceTimersByTime(10_000));
    await settle();
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ itemId: "film-1", seconds: 1200 })]);
    online = true;
    at = 1210;
    await act(async () => void vi.advanceTimersByTime(10_000));
    await settle();
    expect(findUnsentPositions()).toEqual([]);
  });

  it("fermé pendant la coupure : l'arrêt ne passe pas, la position reste, et part au lancement suivant (`late`)", async () => {
    let at = 0;
    const { result, unmount } = renderHook(() => usePlaybackSession(() => at, session));
    online = false;
    at = 2421;
    await act(async () => void (await result.current.stop()));
    unmount();
    await settle();
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ seconds: 2421 })]);
    // Le réseau revient ; le lancement suivant (PlaybackProvider) envoie ce qui attend.
    online = true;
    await act(async () => void vi.advanceTimersByTime(30_000));
    await flushUnsentPositions();
    const late = posted.find((p) => p.url === "/api/jellyfin/playback/stop" && p.body.late === true);
    expect(late?.body).toMatchObject({ itemId: "film-1", positionTicks: 2421 * 10_000_000, late: true });
    expect(late!.body.lateByMs as number).toBeGreaterThanOrEqual(30_000);
    expect(findUnsentPositions()).toEqual([]);
  });

  it("un serveur qui redémarre (5xx) garde la position pour plus tard", async () => {
    saveUnsentPosition("film-2", 600);
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
    await flushUnsentPositions();
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ itemId: "film-2" })]);
  });

  it("appareil partagé : le même titre regardé par un autre compte n'efface ni n'écrase la position gardée du premier", async () => {
    // Une clé par titre seulement : le battement accepté de l'autre compte effaçait la position que
    // le premier n'avait pas pu envoyer, et l'échec de l'autre l'écrasait de la sienne (13/10/2026).
    saveUnsentPosition("film-9", 1500);
    account = "lucas";
    saveUnsentPosition("film-9", 30);
    clearUnsentPosition("film-9");
    expect(findUnsentPositions()).toEqual([]);
    account = "louis";
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ itemId: "film-9", seconds: 1500, account: "louis" })]);
    await flushUnsentPositions();
    expect(posted.filter((p) => p.body.late === true).map((p) => p.body.positionTicks)).toEqual([1500 * 10_000_000]);
    expect(findUnsentPositions()).toEqual([]);
  });

  it("une position gardée sous l'ancienne clé (par titre seul) est encore trouvée, envoyée et effacée", async () => {
    localStorage.setItem("cine:unsent-position:film-8", JSON.stringify({ itemId: "film-8", seconds: 700, savedAt: Date.now(), account: "louis" }));
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ itemId: "film-8", seconds: 700 })]);
    await flushUnsentPositions();
    expect(findUnsentPositions()).toEqual([]);
    expect(localStorage.getItem("cine:unsent-position:film-8")).toBeNull();
  });

  it("rien à garder pour une position nulle", () => {
    saveUnsentPosition("film-3", 0);
    expect(findUnsentPositions()).toEqual([]);
  });

  it("une horloge reculée entre l'écriture et l'envoi ne fait pas perdre la position", async () => {
    const now = Date.now();
    saveUnsentPosition("film-4", 1800, now + 3600_000);
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      // La validation de la route d'arrêt (`late`) : un retard négatif est refusé.
      return (body.lateByMs as number) < 0 ? { ok: false, status: 400 } : { ok: true, status: 200 };
    });
    await flushUnsentPositions(now);
    expect(sent).toHaveLength(1);
    expect(sent[0].lateByMs as number).toBeGreaterThanOrEqual(0);
    expect(sent[0]).toMatchObject({ itemId: "film-4", positionTicks: 1800 * 10_000_000, late: true });
  });
});
