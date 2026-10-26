// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

// Des règles du lecteur serveur (PlayerHost) gardées jusqu'au 22/10/2026 par des tests qui lisaient
// le texte de `PlayerHost.tsx` (castToken, bughunt-zone5-relay, PlayerReauthScreen,
// upstreamUnreachable, player-frame-no-select). Un découpage du fichier les aurait fait échouer sans
// rien casser — et une règle déplacée puis perdue les aurait laissés verts. Ici, ce que le lecteur
// fait. Le harnais est celui de PlayerHost-audit-22-10.test.tsx.

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
  PlayerControls: (props: { onClose: () => void; onChangeAudio: (id: number) => void; onChangeSubtitle: (id: number | null) => void; onCastReturn?: () => void }) => (
    <div data-testid="commandes">
      <button onClick={props.onClose}>fermer</button>
      <button onClick={() => props.onChangeAudio(2)}>piste</button>
      <button onClick={() => props.onChangeSubtitle(null)}>sous-titre</button>
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
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
const SERVEUR = vi.hoisted(() => ["film"]);
/** Le relais du lecteur natif : `{ cast: true, owner }` pour une séance ouverte pour diffuser. */
const relais = vi.hoisted(() => ({ takeover: null as unknown }));
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: SERVEUR, negotiating: false, reason: null, takeover: relais.takeover, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
const reportPlayback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...a: unknown[]) => reportPlayback(...a) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
/** hls.js par défaut ; WebKit (HLS natif, AirPlay) quand le test le dit. */
const engine = vi.hoisted(() => ({ nativeHls: false }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => engine.nativeHls }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, reportNow: () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

/** Les adresses que hls.js a reçues, dans l'ordre. */
const hlsSources = vi.hoisted(() => [] as string[]);
vi.mock("hls.js", () => {
  class Hls {
    static isSupported = () => true;
    static Events = { FRAG_BUFFERED: "hlsFragBuffered", ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed", LEVEL_LOADED: "hlsLevelLoaded", MEDIA_DETACHING: "hlsMediaDetaching" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
    bandwidthEstimate = 0;
    audioTracks = [];
    on() {}
    off() {}
    loadSource(url: string) {
      hlsSources.push(url);
    }
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    detachMedia() {}
    recoverMediaError() {}
    destroy() {}
  }
  return { default: Hls };
});

import { PlayerHost } from "@/components/PlayerHost";
import { UPSTREAM_UNREACHABLE } from "@/lib/http";

const CAST_URL = "https://cine.example/api/jellyfin/stream/film/master.m3u8?castToken=laissez-passer";
const reponseBase = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [{ index: 1, language: "fre", displayTitle: "fr" }, { index: 2, language: "eng", displayTitle: "en" }],
  subtitleTracks: [],
  title: "Film",
};
let reponse: Record<string, unknown> = reponseBase;
/** La réponse de la négociation, quand elle n'est pas un succès. */
let refus: { status: number; body: Record<string, unknown> } | null = null;
let negociations: Record<string, unknown>[] = [];

const video = () => document.querySelector("video")!;
const fire = (name: string) => act(() => void video().dispatchEvent(new Event(name)));
const text = () => document.body.textContent ?? "";

async function nextNegotiation(count: number) {
  await waitFor(() => expect(negociations.length).toBe(count), { timeout: 6000 });
  await act(async () => {});
}

/** La route AirPlay s'établit, comme Safari le signale. */
function castOn() {
  const el = video();
  Object.defineProperty(el, "webkitCurrentPlaybackTargetIsWireless", { configurable: true, value: true });
  act(() => void el.dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged")));
}
function failWith(code: number) {
  const el = video();
  Object.defineProperty(el, "error", { configurable: true, value: { code } });
  act(() => void el.dispatchEvent(new Event("error")));
}
/** Plus que le délai de la première marche de l'échelle (1,2 s). */
const pastLadderDelay = () => act(() => new Promise((resolve) => setTimeout(resolve, 1700)));
const lines = (kind: string) => reportPlayback.mock.calls.filter(([k]) => k === kind).map(([, f]) => f as Record<string, unknown>);

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  negociations = [];
  reponse = reponseBase;
  refus = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === "/api/jellyfin/playback/start") {
        negociations.push(JSON.parse(init?.body ?? "{}"));
        if (refus) {
          const { status, body } = refus;
          return { ok: false, status, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => reponse };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  playback.mode = "full";
  relais.takeover = null;
  engine.nativeHls = false;
  hlsSources.length = 0;
  reportPlayback.mockClear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("le cadre du lecteur serveur ne sélectionne rien", () => {
  // La règle CSS est dans globals.css (player-frame-no-select.test.ts) ; elle ne sert que si le
  // cadre porte la marque et contient la vidéo et les commandes.
  it("la vidéo et les commandes sont dans le cadre marqué", async () => {
    const { getByTestId } = render(<PlayerHost />);
    await nextNegotiation(1);
    const frame = video().closest("[data-player-frame]");
    expect(frame).not.toBeNull();
    expect(frame!.contains(getByTestId("commandes"))).toBe(true);
  });
});

describe("une lecture dans la page charge l'adresse signée (bughunt zone 5, §64)", () => {
  // Toute lecture du lecteur serveur dans la page — Fire TV, Mac Safari 17, Edge sans HEVC —
  // demande ses segments avec le laissez-passer : le bouton AirPlay de la vidéo peut l'envoyer
  // à la télé sans passer par « Diffuser ».
  it("WebKit : `src` est `castUrl`, pas `manifestUrl`", async () => {
    engine.nativeHls = true;
    reponse = { ...reponseBase, castUrl: CAST_URL };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(video().src).toBe(CAST_URL);
  });

  it("hls.js : la source chargée est `castUrl`", async () => {
    reponse = { ...reponseBase, castUrl: CAST_URL };
    render(<PlayerHost />);
    await nextNegotiation(1);
    await waitFor(() => expect(hlsSources).toEqual([CAST_URL]));
  });

  it("un serveur d'avant `castUrl` : `manifestUrl`", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    await waitFor(() => expect(hlsSources).toEqual([reponseBase.manifestUrl]));
  });
});

describe("le lecteur serveur, session Jellyfin expirée (BUREAU-22)", () => {
  const reauth = () => (refus = { status: 401, body: { code: "jellyfin_reauth_required" } });

  it("montre l'écran de reconnexion, qui se referme par « Quitter »", async () => {
    reauth();
    const { getByText } = render(<PlayerHost />);
    await waitFor(() => expect(getByText("player.reconnect")).toBeTruthy());
    act(() => void getByText("player.quit").click());
    expect(lines("stop").map((l) => l.why)).toEqual(["close"]);
  });

  it("et par Échap en plein écran", async () => {
    reauth();
    const { getByText } = render(<PlayerHost />);
    await waitFor(() => expect(getByText("player.reconnect")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(lines("stop").map((l) => l.why)).toEqual(["close"]);
  });

  it("laisse Échap à l'écran parcouru dans le mini-lecteur", async () => {
    reauth();
    playback.mode = "mini";
    const { getByText } = render(<PlayerHost />);
    await waitFor(() => expect(getByText("player.reconnect")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(lines("stop")).toEqual([]);
  });
});

describe("un serveur média absent se dit comme dans le lecteur natif", () => {
  it("une négociation refusée avec le code de panne amont : la phrase partagée", async () => {
    refus = { status: 502, body: { code: UPSTREAM_UNREACHABLE, error: "jellyfin.local ne répond pas" } };
    render(<PlayerHost />);
    await waitFor(() => expect(text()).toContain("player.libraryUnreachable"));
    expect(text()).not.toContain("jellyfin.local ne répond pas");
  });
});

/**
 * L'interruption d'une diffusion (19/09/2026, « ça bloque au bout d'environ trente secondes »).
 *
 * La première marche de l'échelle rejoue la requête, ce qui remonte l'élément sur WebKit — et un
 * élément neuf n'a plus de route AirPlay. « Rattraper » et « couper » sont le même geste : l'échelle
 * se tait et l'écran laisse le geste au spectateur. La relecture du drapeau au moment où la reprise
 * partirait est gardée dans PlayerHost-echelle.test.tsx.
 */
describe("l'interruption d'une diffusion", () => {
  it("ne relance jamais la lecture toute seule : l'écran « diffusion interrompue », sans échelle", { timeout: 20_000 }, async () => {
    engine.nativeHls = true;
    render(<PlayerHost />);
    await nextNegotiation(1);
    castOn();
    failWith(4);
    await pastLadderDelay();
    expect(negociations).toHaveLength(1);
    expect(text()).toContain("player.castInterrupted");
    expect(text()).not.toContain("player.reconnecting");
    expect(lines("error").map((l) => l.reason)).toContain("erreur pendant une diffusion — reprise refusée, relance proposée");
  });

  it("« Relancer » renégocie et rouvre le sélecteur, dont le verrou est relâché", { timeout: 20_000 }, async () => {
    engine.nativeHls = true;
    const picker = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, "webkitShowPlaybackTargetPicker", { configurable: true, value: picker });
    try {
      // Une séance ouverte pour diffuser : le sélecteur s'ouvre dès que l'image est là.
      relais.takeover = { resumeAt: 600, cast: true, owner: playback.session };
      const { getByText } = render(<PlayerHost />);
      await nextNegotiation(1);
      fire("loadedmetadata");
      expect(picker).toHaveBeenCalledTimes(1);
      castOn();
      failWith(4);
      await waitFor(() => expect(text()).toContain("player.castInterrupted"));

      act(() => void getByText("player.castRelaunch").click());
      await nextNegotiation(2);
      expect(lines("start").map((l) => l.why)).toContain("cast-relaunch");
      expect(text()).not.toContain("player.castInterrupted");
      // L'élément neuf de la relance : le sélecteur s'y rouvre.
      fire("loadedmetadata");
      expect(picker).toHaveBeenCalledTimes(2);
    } finally {
      delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).webkitShowPlaybackTargetPicker;
    }
  });

  /**
   * Le changement de piste audio prévient avant d'agir pendant une diffusion : il rompt la route.
   * Le geste reste permis ; c'est la surprise qui ne l'est plus. Hors diffusion, rien ne s'interpose.
   */
  it("hors diffusion, une piste choisie part sans question", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    act(() => void getByText("piste").click());
    await nextNegotiation(2);
    expect(negociations[1].audioStreamIndex).toBe(2);
    expect(text()).not.toContain("player.castAudioWarning");
  });

  /** Le sous-titre incrusté dans l'image du téléviseur (`castSubtitle.ts`, 26/10/2026). */
  it("une séance ouverte pour diffuser demande l'incrustation du sous-titre que le natif montrait", { timeout: 20_000 }, async () => {
    const castSubtitle = { index: 5, language: "fra", forced: false };
    relais.takeover = { resumeAt: 600, cast: true, owner: playback.session, castSubtitle };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(negociations[0]).toMatchObject({ forCast: true, burnSubtitle: castSubtitle });
  });

  it("changer de sous-titre pendant la diffusion le dit, et propose de revenir sur le téléphone", { timeout: 20_000 }, async () => {
    relais.takeover = { resumeAt: 600, cast: true, owner: playback.session };
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    castOn();
    act(() => void getByText("sous-titre").click());
    expect(text()).toContain("player.castSubtitleWarning");
    act(() => void getByText("common.cancel").click());
    expect(text()).not.toContain("player.castSubtitleWarning");
    act(() => void getByText("sous-titre").click());
    act(() => void getByText("player.castSubtitleReturn").click());
    expect(text()).not.toContain("player.castSubtitleWarning");
    expect(lines("fallback").map((l) => l.reason)).toContain("fin de diffusion (retour demandé sur le téléphone)");
  });

  it("hors diffusion, un sous-titre choisi s'applique sans question", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    act(() => void getByText("sous-titre").click());
    expect(text()).not.toContain("player.castSubtitleWarning");
  });

  it("pendant une diffusion, la confirmation d'abord : « Annuler » ne change rien, « Continuer » change la piste", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    castOn();

    act(() => void getByText("piste").click());
    expect(text()).toContain("player.castAudioWarning");
    act(() => void getByText("common.cancel").click());
    expect(text()).not.toContain("player.castAudioWarning");
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(negociations).toHaveLength(1);

    act(() => void getByText("piste").click());
    act(() => void getByText("player.castAudioContinue").click());
    await nextNegotiation(2);
    expect(negociations[1].audioStreamIndex).toBe(2);
  });

  /**
   * Nath, 26/10/2026 : l'incrustation retarde la première image d'une quinzaine de secondes, le
   * sélecteur AirPlay attend cette image, et la roue tournait sans un mot.
   */
  it("une diffusion au sous-titre incrusté dit pourquoi elle attend, jusqu'à la première image", { timeout: 20_000 }, async () => {
    relais.takeover = { resumeAt: 600, cast: true, owner: playback.session, castSubtitle: { index: 3, language: "fra", forced: true } };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(text()).toContain("player.castSubtitlePrep");
    fire("loadeddata");
    fire("playing");
    expect(text()).not.toContain("player.castSubtitlePrep");
  });

  it("sans sous-titre à incruster, la diffusion n'annonce rien de tel", { timeout: 20_000 }, async () => {
    relais.takeover = { resumeAt: 600, cast: true, owner: playback.session };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(text()).not.toContain("player.castSubtitlePrep");
  });
});

describe("la croix coupe un élément encore en chargement", () => {
  /**
   * Retiré de la page avant sa première image, l'élément d'iOS continuait de demander les morceaux
   * trente secondes après la croix, et Jellyfin relançait un encodage 4K pour lui (26/10/2026).
   */
  it("sans image, la croix retire la source de l'élément", { timeout: 20_000 }, async () => {
    engine.nativeHls = true;
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    const el = video();
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    load.mockClear();
    act(() => void getByText("fermer").click());
    expect(el.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalled();
  });

  it("avec une image, la croix laisse l'élément au fondu, comme avant", { timeout: 20_000 }, async () => {
    engine.nativeHls = true;
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    const el = video();
    fire("loadeddata");
    Object.defineProperty(el, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA });
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    load.mockClear();
    act(() => void getByText("fermer").click());
    expect(load).not.toHaveBeenCalled();
  });
});
