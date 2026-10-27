// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor, fireEvent, screen } from "@testing-library/react";
import { createFakeCast, type FakeCast } from "./helpers/fakeCast";

// DECISIONS.md §64 — la télécommande du Chromecast, sur un kit simulé : aucun récepteur réel n'est là.

vi.mock("@/components/TranslationProvider", () => {
  const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  const locale = { locale: "fr", setLocale: () => {} };
  return { useT: () => t, useLocale: () => locale };
});
const playback = { close: vi.fn(), advance: vi.fn(), minimize: vi.fn(), expand: vi.fn() };
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => playback }));
const reportPlayback = vi.fn();
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...args: unknown[]) => reportPlayback(...args) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: vi.fn(async () => {}) }));
vi.mock("@/lib/resumeRewind", () => ({ noteWatching: vi.fn() }));
const sessionInfo: unknown[] = [];
const stopNow = vi.fn(async () => {});
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (_pos: () => number, info: unknown) => {
    sessionInfo.push(info);
    return { stop: stopNow, reportNow: () => {}, resume: vi.fn(), savePaused: vi.fn() };
  },
  stopOrphanSession: vi.fn(async () => {}),
}));

import { ChromecastPlayer, CHROMECAST_MAX_BITRATE } from "@/components/player/ChromecastPlayer";
import { resetChromecastForTests, startChromecastSender } from "@/lib/chromecast/framework";

const ITEM = "a".repeat(32);
const negotiations: Record<string, unknown>[] = [];

function negotiation(overrides: Record<string, unknown> = {}) {
  return {
    playSessionId: `play-${negotiations.length}`,
    mediaSourceId: "src-1",
    castUrl: `https://cine.example/api/jellyfin/stream/${ITEM}/master.m3u8?castToken=t`,
    isDirectPlay: false,
    title: "Le Film",
    audioTracks: [
      { index: 1, language: "fre", title: null, codec: "eac3", channels: 6, profile: null, isDefault: true },
      { index: 2, language: "eng", title: null, codec: "aac", channels: 2, profile: null, isDefault: false },
    ],
    subtitleTracks: [
      { index: 3, url: `/api/jellyfin/stream/subtitle/${ITEM}?mediaSourceId=src-1&index=3&castToken=t`, language: "fre", title: null, isDefault: false, isText: true },
      { index: 4, url: `/api/jellyfin/stream/subtitle/${ITEM}?mediaSourceId=src-1&index=4&castToken=t`, language: "eng", title: null, isDefault: false, isText: false },
    ],
    playbackInfo: { playMethod: "Transcode" },
    ...overrides,
  };
}

let fake: FakeCast;
const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url === "/api/player/cast") return { ok: true, json: async () => ({ allowed: true, receiverAppId: "CC1AD845" }) };
  negotiations.push(JSON.parse(init?.body ?? "{}"));
  return { ok: true, status: 200, json: async () => negotiation() };
});

const linesOf = (kind: string) => reportPlayback.mock.calls.filter((c) => c[0] === kind).map((c) => c[1] as Record<string, unknown>);

async function mount(opts: { next?: { itemId: string; title: string } | null; resumeAt?: number; mode?: "full" | "mini" } = {}) {
  const onCastEnded = vi.fn();
  const session = { itemId: ITEM, title: "Le Film", openId: 1, getNextEpisode: () => opts.next ?? null };
  const view = render(
    <ChromecastPlayer
      session={session}
      mode={opts.mode ?? "full"}
      takeover={{ resumeAt: opts.resumeAt ?? 1200, audioStreamIndex: 1, cast: true, castTarget: "chromecast", owner: session }}
      continuesSession="seance-1"
      onCastEnded={onCastEnded}
    />
  );
  // Le chargement fini (la ligne `cast` part après lui) : le récepteur est alors cru sur sa position.
  await waitFor(() => expect(linesOf("cast")).toHaveLength(1));
  return { onCastEnded, view };
}

beforeEach(async () => {
  vi.clearAllMocks();
  negotiations.length = 0;
  sessionInfo.length = 0;
  resetChromecastForTests();
  vi.stubGlobal("fetch", fetchMock);
  fake = createFakeCast();
  fake.install();
  await startChromecastSender();
  fake.connect("Salon");
});

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  // L'arrêt au démontage part un tour plus tard (voir le composant) : qu'il tombe dans ce test-ci.
  await new Promise((resolve) => setTimeout(resolve, 5));
  vi.unstubAllGlobals();
});

describe("l'ouverture", () => {
  it("négocie pour le Chromecast à la position du relais, puis charge l'adresse signée sur le récepteur", async () => {
    await mount();
    expect(negotiations[0]).toMatchObject({ itemId: ITEM, castTarget: "chromecast", maxBitrate: CHROMECAST_MAX_BITRATE, audioStreamIndex: 1, startTicks: 12_000_000_000 });
    const load = fake.loads[0] as { currentTime: number; media: { contentId: string; contentType: string } };
    expect(load.media.contentId).toBe(`https://cine.example/api/jellyfin/stream/${ITEM}/master.m3u8?castToken=t`);
    expect(load.media.contentType).toBe("application/x-mpegurl");
    expect(load.currentTime).toBe(1200);
  });

  it("écrit start puis cast, marqués Chromecast, dans la séance du lecteur natif", async () => {
    await mount();
    await waitFor(() => expect(linesOf("cast")).toHaveLength(1));
    expect(linesOf("start")[0]).toMatchObject({ itemId: ITEM, player: "serveur", cast: true, target: "chromecast", session: "seance-1", why: "handover", hls: "récepteur", device: "Salon" });
    expect(linesOf("cast")[0]).toMatchObject({ target: "chromecast", reason: "diffusion établie", device: "Salon", session: "seance-1" });
  });

  it("dit sur quel téléviseur, et rapporte la reprise à Jellyfin depuis la page", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/player.chromecast.playingOn/)).toBeTruthy());
    expect(screen.getByText(/Salon/)).toBeTruthy();
    expect(sessionInfo.at(-1)).toMatchObject({ itemId: ITEM, playSessionId: "play-1", mediaSourceId: "src-1", client: "Laterna" });
  });

  it("un chargement refusé par le récepteur : l'erreur dite, et la ligne au journal avec son code", async () => {
    const session = fake.globals.framework.CastContext.getInstance().getCurrentSession() as { loadMedia: unknown };
    session.loadMedia = () => Promise.reject("load_media_failed");
    render(
      <ChromecastPlayer
        session={{ itemId: ITEM, title: "Le Film", openId: 1 }}
        mode="full"
        takeover={{ resumeAt: 0, cast: true, castTarget: "chromecast" }}
        onCastEnded={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText("player.chromecast.failed")).toBeTruthy());
    expect(linesOf("error")[0]).toMatchObject({ target: "chromecast", code: "load_media_failed", reason: "chromecast : le récepteur n'a pas pu charger le flux" });
    expect(screen.getByText("player.chromecast.retry")).toBeTruthy();
  });
});

describe("pendant la diffusion", () => {
  it("suit la position du récepteur, et la commande lecture/pause et le saut vont au récepteur", async () => {
    await mount();
    act(() => fake.play(1500));
    expect(screen.getByText("25:00")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("player.pause"));
    expect(fake.controllerCalls).toContain("playOrPause");
    fireEvent.change(screen.getByLabelText("player.chromecast.position"), { target: { value: "1800" } });
    expect(fake.controllerCalls).toContain("seek:1800");
  });

  it("une piste son relance le flux à la même position, sur la nouvelle piste", async () => {
    await mount();
    act(() => fake.play(1500));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "2" } });
    await waitFor(() => expect(fake.loads).toHaveLength(2));
    expect(negotiations[1]).toMatchObject({ audioStreamIndex: 2, startTicks: 15_000_000_000, castTarget: "chromecast" });
    expect((fake.loads[1] as { currentTime: number }).currentTime).toBe(1500);
    expect(linesOf("start")[1]).toMatchObject({ why: "audio" });
  });

  it("un sous-titre texte s'allume sur le récepteur sans relancer le flux ; un sous-titre en images relance, incrusté", async () => {
    await mount();
    act(() => fake.play(1500));
    const select = screen.getAllByRole("combobox")[1];
    fireEvent.change(select, { target: { value: "3" } });
    expect(fake.editedTracks).toEqual([[4]]);
    expect(negotiations).toHaveLength(1);
    fireEvent.change(select, { target: { value: "4" } });
    await waitFor(() => expect(fake.loads).toHaveLength(2));
    expect(negotiations[1]).toMatchObject({ subtitleStreamIndex: 4, audioStreamIndex: 1 });
    expect((fake.loads[1] as { activeTrackIds: number[] }).activeTrackIds).toEqual([]);
  });
});

describe("la fin de la diffusion", () => {
  it("le téléviseur s'éteint : la main revient au lecteur natif, en pause, à la dernière position", async () => {
    const { onCastEnded } = await mount();
    act(() => fake.play(2000));
    act(() => fake.disconnect());
    expect(onCastEnded).toHaveBeenCalledWith(2000, true);
    expect(linesOf("fallback")[0]).toMatchObject({ target: "chromecast", cast: true, reason: "fin de diffusion (téléviseur)", at: 2000 });
  });

  it("« Reprendre sur cet appareil » : le téléviseur s'arrête et le film continue ici", async () => {
    const { onCastEnded } = await mount();
    act(() => fake.play(2100));
    fireEvent.click(screen.getByText("player.chromecast.resumeHere"));
    expect(onCastEnded).toHaveBeenCalledWith(2100, false);
    expect(onCastEnded).toHaveBeenCalledTimes(1);
    expect(fake.ended).toContain(true);
    expect(linesOf("fallback")[0]).toMatchObject({ reason: "fin de diffusion (retour demandé sur l'appareil)" });
  });

  it("la croix : bilan, arrêt chez Jellyfin, téléviseur arrêté, lecteur fermé", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onCastEnded } = await mount();
    act(() => fake.play(2200));
    fireEvent.click(screen.getByLabelText("common.close"));
    expect(linesOf("stop")[0]).toMatchObject({ why: "close", target: "chromecast", at: 2200 });
    expect(stopNow).toHaveBeenCalled();
    expect(fake.ended).toContain(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(playback.close).toHaveBeenCalledWith(1);
    expect(onCastEnded).not.toHaveBeenCalled();
  });

  // Retour ferme la télécommande comme sa croix (LECTEUR-11, 15/10/2026).
  it("Retour : la croix — bilan, téléviseur arrêté, lecteur fermé", async () => {
    const { holdPlayerEntry, installPlayerHistory, __resetPlayerHistoryForTests } = await import("@/lib/playerHistory");
    __resetPlayerHistoryForTests();
    const uninstall = installPlayerHistory(vi.fn(), false);
    try {
      const { onCastEnded } = await mount();
      act(() => fake.play(2200));
      holdPlayerEntry(1);
      await act(async () => {
        window.history.back();
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(linesOf("stop")[0]).toMatchObject({ why: "close", target: "chromecast", at: 2200 });
      expect(fake.ended).toContain(true);
      await waitFor(() => expect(playback.close).toHaveBeenCalledWith(1));
      expect(onCastEnded).not.toHaveBeenCalled();
    } finally {
      uninstall();
      __resetPlayerHistoryForTests();
    }
  });

  it("la fin du film avec un épisode suivant : il s'enchaîne", async () => {
    await mount({ next: { itemId: "b".repeat(32), title: "Épisode 2" } });
    act(() => fake.play(3590, 3600));
    act(() => fake.idle("FINISHED"));
    expect(linesOf("stop")[0]).toMatchObject({ why: "next", ended: true });
    expect(playback.advance).toHaveBeenCalledWith({ itemId: "b".repeat(32), title: "Épisode 2" });
  });

  it("la fin du film sans épisode suivant : fermé, téléviseur arrêté", async () => {
    await mount();
    act(() => fake.play(3590, 3600));
    act(() => fake.idle("FINISHED"));
    expect(linesOf("stop")[0]).toMatchObject({ why: "close", ended: true });
    expect(fake.ended).toContain(true);
  });

  it("arrêté depuis le téléviseur (télécommande) : retour au lecteur natif, en pause", async () => {
    const { onCastEnded } = await mount();
    act(() => fake.play(2300));
    act(() => fake.idle("CANCELLED"));
    expect(onCastEnded).toHaveBeenCalledWith(2300, true);
  });

  it("une erreur du récepteur en cours de lecture : dite, et écrite", async () => {
    await mount();
    act(() => fake.play(2300));
    act(() => fake.idle("ERROR"));
    expect(screen.getByText("player.chromecast.failed")).toBeTruthy();
    expect(linesOf("error")[0]).toMatchObject({ target: "chromecast" });
  });
});

describe("réduit", () => {
  it("une pastille : titre, lecture/pause, agrandir", async () => {
    await mount({ mode: "mini" });
    fireEvent.click(screen.getByLabelText("player.chromecast.expand"));
    expect(playback.expand).toHaveBeenCalled();
  });
});

/**
 * Un récepteur qui accepte le chargement et ne lit jamais (27/10/2026) : un Freebox Player POP a pris
 * un épisode en E-AC3 copié, lu le premier segment, puis plus rien — la page tournait sans fin.
 */
describe("un téléviseur qui accepte sans lire", () => {
  it("relance une fois avec le son en AAC, puis dit l'échec au lieu de tourner sans fin", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    expect(negotiations[0].forceAudioTranscode).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    await waitFor(() => expect(fake.loads).toHaveLength(2));
    expect(negotiations[1]).toMatchObject({ castTarget: "chromecast", forceAudioTranscode: true, audioStreamIndex: 1, startTicks: 12_000_000_000 });
    expect(linesOf("start")[1]).toMatchObject({ why: "ladder", rung: 1, trigger: "aucune image en 25 s → son en AAC" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    await waitFor(() => expect(linesOf("error")).toHaveLength(1));
    expect(linesOf("error")[0]).toMatchObject({ target: "chromecast", reason: "chromecast : le téléviseur n'a pas démarré la lecture" });
    expect(fake.loads).toHaveLength(2);
  });

  it("une image à temps : rien ne bouge", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    act(() => fake.play(1200));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fake.loads).toHaveLength(1);
    expect(linesOf("error")).toHaveLength(0);
  });

  it("le son AAC reste acquis pour les relances suivantes de ce téléviseur", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    await waitFor(() => expect(fake.loads).toHaveLength(2));
    act(() => fake.play(1210));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "2" } });
    await waitFor(() => expect(fake.loads).toHaveLength(3));
    expect(negotiations[2]).toMatchObject({ audioStreamIndex: 2, forceAudioTranscode: true });
  });
});
