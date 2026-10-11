// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// L'échelle du son du lecteur serveur (`AUDIO_FALLBACK_RUNGS`, PlayerHost) — DECISIONS §67.
// Caractérisation de ce qu'elle fait aujourd'hui (marches, délais, transcodage forcé en dernier,
// rechargement WebKit une fois), la décision du 11/10/2026 (plus aucune exclusion de codec retenue
// d'une séance à l'autre), et la boucle prouvée que le registre des tentatives devra arrêter.
// Le harnais est celui de PlayerHost-fin-relance.test.tsx : tout ce qui entoure le lecteur est simulé.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/playerBench/bridge", () => ({ publishHandedOver: () => {} }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/components/ExperimentalPlayerHost", () => ({ ExperimentalPlayerHost: () => <div data-testid="natif" /> }));
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "volume",
  PlayerControls: (props: { onClose: () => void }) => (
    <div data-testid="commandes">
      <button onClick={props.onClose}>fermer</button>
    </div>
  ),
}));

const playback = {
  session: null as null | Record<string, unknown>,
  mode: "full" as "full" | "mini" | "closed",
  close: vi.fn(),
  advance: vi.fn(),
  minimize: vi.fn(),
  expand: vi.fn(),
};
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => playback,
  PLAYER_RELOAD_INTENT_KEY: "reload-intent",
}));
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy: true }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({
    handedOver: [],
    negotiating: false,
    reason: null,
    takeover: null,
    stepAside: vi.fn(),
    stepBack: vi.fn(),
    returning: null,
  }),
}));
const reportPlayback = vi.fn();
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...args: unknown[]) => reportPlayback(...args) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
// Safari : HLS natif, l'échelle est son chemin d'erreur.
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

import { PlayerHost, LEGACY_AUDIO_BLOCKLIST_KEY, __resetLegacyBlocklistPurgeForTests } from "@/components/PlayerHost";

const reponse = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
};

/** Le corps de chaque négociation, dans l'ordre. */
let negociations: Record<string, unknown>[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === "/api/jellyfin/playback/start") {
        negociations.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, status: 200, json: async () => reponse };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
}

const video = () => document.querySelector("video")!;

/** L'élément échoue (code 4 : source refusée), comme Safari sur un E-AC3 qu'il annonce et ne lit pas. */
function failElement() {
  const el = video();
  Object.defineProperty(el, "error", { configurable: true, value: { code: 4 } });
  act(() => void el.dispatchEvent(new Event("error")));
}

function loadElement() {
  act(() => void video().dispatchEvent(new Event("loadeddata")));
}

async function nextNegotiation(count: number) {
  await waitFor(() => expect(negociations.length).toBe(count), { timeout: 6000 });
  // Laisse la négociation finir de poser la source avant le geste suivant.
  await act(async () => {});
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  // jsdom n'a pas `MediaError` ; l'écouteur d'erreur y lit `MEDIA_ERR_ABORTED`.
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  playback.mode = "full";
  reportPlayback.mockClear();
  negociations = [];
  localStorage.clear();
  sessionStorage.clear();
  __resetLegacyBlocklistPurgeForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("échelle du son — caractérisation", () => {
  it("trois marches : même demande, sans E-AC3/FLAC/Opus, puis AAC seul ré-encodé ; délais 1,2 s × marche", { timeout: 20_000 }, async () => {
    stubFetch();
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(negociations[0].disableAudioCodecs).toEqual([]);

    const t1 = Date.now();
    failElement();
    await nextNegotiation(2);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1100);
    expect(negociations[1].disableAudioCodecs).toEqual([]);
    expect(negociations[1].forceAudioTranscode).toBeUndefined();

    const t2 = Date.now();
    failElement();
    await nextNegotiation(3);
    expect(Date.now() - t2).toBeGreaterThanOrEqual(2300);
    expect(negociations[2].disableAudioCodecs).toEqual(["eac3", "flac", "opus"]);
    expect(negociations[2].forceAudioTranscode).toBeUndefined();

    failElement();
    await nextNegotiation(4);
    expect(negociations[3].disableAudioCodecs).toEqual(["eac3", "flac", "opus", "ac3"]);
    expect(negociations[3].forceAudioTranscode).toBe(true);
    // Chaque marche est écrite au journal avec son rang.
    const rungs = reportPlayback.mock.calls.filter(([k]) => k === "start").map(([, f]) => (f as { rung?: number }).rung);
    expect(rungs).toEqual([undefined, 1, 2, 3]);
  });

  it("échelle épuisée sur WebKit : un seul rechargement de page, l'intention écrite avec attempt 1", { timeout: 20_000 }, async () => {
    stubFetch();
    render(<PlayerHost />);
    await nextNegotiation(1);
    for (let n = 2; n <= 4; n++) {
      failElement();
      await nextNegotiation(n);
    }
    failElement();
    const intent = JSON.parse(sessionStorage.getItem("reload-intent") ?? "null");
    expect(intent).toMatchObject({ itemId: "film", attempt: 1, server: true });
  });

  it("échelle épuisée après un rechargement : plus de rechargement, l'écran d'erreur", { timeout: 20_000 }, async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film", reloadAttempt: 1 };
    stubFetch();
    render(<PlayerHost />);
    await nextNegotiation(1);
    for (let n = 2; n <= 4; n++) {
      failElement();
      await nextNegotiation(n);
    }
    failElement();
    expect(sessionStorage.getItem("reload-intent")).toBeNull();
    await waitFor(() => expect(document.body.textContent).toContain("player.playbackInterrupted"));
  });
});

describe("plus aucune exclusion de codec retenue d'une séance à l'autre (11/10/2026)", () => {
  it("une marche qui réussit vaut pour l'ouverture en cours ; la séance suivante repart de la marche 0", { timeout: 20_000 }, async () => {
    stubFetch();
    const { unmount } = render(<PlayerHost />);
    await nextNegotiation(1);
    failElement();
    await nextNegotiation(2);
    failElement();
    await nextNegotiation(3);
    loadElement(); // la marche « sans E-AC3/FLAC/Opus » se charge
    expect(localStorage.getItem(LEGACY_AUDIO_BLOCKLIST_KEY)).toBeNull();
    unmount();

    // Une nouvelle ouverture du lecteur : une séance neuve, aucune exclusion héritée.
    playback.session = { itemId: "film", openId: 2, resumeAt: 120, title: "Film" };
    render(<PlayerHost />);
    await nextNegotiation(4);
    expect(negociations[3].disableAudioCodecs).toEqual([]);
  });

  it("l'ancienne mémoire permanente est effacée à la première négociation", async () => {
    localStorage.setItem(LEGACY_AUDIO_BLOCKLIST_KEY, JSON.stringify(["eac3", "flac", "opus"]));
    stubFetch();
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(negociations[0].disableAudioCodecs).toEqual([]);
    expect(localStorage.getItem(LEGACY_AUDIO_BLOCKLIST_KEY)).toBeNull();
  });

  it("le rechargement WebKit d'un changement de piste continue la séance : ce qu'elle a appris le suit", { timeout: 20_000 }, async () => {
    stubFetch();
    const { unmount } = render(<PlayerHost />);
    await nextNegotiation(1);
    failElement();
    await nextNegotiation(2);
    failElement();
    await nextNegotiation(3);
    loadElement();
    unmount();

    // La page rechargée pour changer de piste : la même séance, `fromReload`.
    playback.session = { itemId: "film", openId: 3, resumeAt: 300, title: "Film", fromReload: true };
    render(<PlayerHost />);
    await nextNegotiation(4);
    expect(negociations[3].disableAudioCodecs).toEqual(["eac3", "flac", "opus"]);
  });
});

describe("boucle (a)1 — l'échelle remise à zéro par `loadeddata`", () => {
  // Prouvée et non corrigée (§67, étape 2 : observation seulement) : un flux qui se charge puis
  // échoue toujours au même endroit remonte l'échelle à chaque fois, sans fin. À basculer en `it`
  // quand le registre des tentatives sera activé sur ce chemin.
  it.fails("un échec qui revient au même endroit après chaque chargement ne relance pas sans fin", { timeout: 30_000 }, async () => {
    stubFetch();
    render(<PlayerHost />);
    await nextNegotiation(1);
    // Cinq cycles « chargé, puis l'élément échoue » : chaque échec relance la marche 0.
    for (let cycle = 0; cycle < 5; cycle++) {
      loadElement();
      failElement();
      await nextNegotiation(cycle + 2);
    }
    // Ce qu'on attend une fois le registre actif : la même tentative n'est plus rejouée.
    expect(negociations.length).toBeLessThanOrEqual(4);
  });

  it("observation : les tentatives identiques sont comptées au bilan `stop`", { timeout: 30_000 }, async () => {
    stubFetch();
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    for (let cycle = 0; cycle < 3; cycle++) {
      loadElement();
      failElement();
      await nextNegotiation(cycle + 2);
    }
    act(() => void getByText("fermer").click());
    await waitFor(() => expect(reportPlayback.mock.calls.some(([k]) => k === "stop")).toBe(true));
    const stop = reportPlayback.mock.calls.filter(([k]) => k === "stop").map(([, f]) => f as Record<string, unknown>)[0];
    expect(stop.identicalRetries).toBe(2);
    expect(stop.retryMotif).toBe("élément : code 4");
  });
});
