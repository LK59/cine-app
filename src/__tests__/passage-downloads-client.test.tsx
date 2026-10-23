// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useState as useStateBox } from "react";

/**
 * Les téléchargements hors ligne et le passage d'adresse, côté navigateur (DECISIONS.md §119) : la
 * relance par le chemin normal, l'effacement sur l'ancienne adresse seulement après l'attestation du
 * serveur et jamais pendant une lecture, l'invitation une seule fois et pas par-dessus l'aide
 * d'installation, la phrase de l'aide du passage seulement avec des téléchargements.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));
const env = vi.hoisted(() => ({ mode: "closed" as "closed" | "full" | "mini", onboarding: false, old: false as boolean | null, enabled: true }));
vi.mock("swr", () => ({ default: () => ({ data: { pending: env.onboarding } }) }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlaybackMode: () => env.mode }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "lea" }));
vi.mock("@/lib/passage/useOldAddress", () => ({ useOldAddress: () => ({ old: env.old, host: "app.example.org" }) }));
vi.mock("@/lib/offline/useOfflineEnabled", () => ({ useOfflineDownloadsEnabled: () => env.enabled }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStoreSupported: () => true }));
// La fenêtre « Passer » : ce qu'elle rassemble est doublé, seule sa phrase est regardée ici.
const dialog = vi.hoisted(() => ({ downloads: [] as unknown[] }));
vi.mock("@/lib/passage/client", () => ({
  collectPassageInput: async () => ({ settings: {}, pushEndpoint: null, downloads: dialog.downloads }),
  formatPassageCode: (c: string) => c,
}));

interface FakeDownload {
  id: string;
  itemId: string;
  state: string;
  createdAt: number;
  [key: string]: unknown;
}
const store = vi.hoisted(() => ({
  list: [] as FakeDownload[],
  account: "lea" as string | null,
  start: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/offline/downloads", () => ({
  currentOfflineDownloads: () => store.list,
  initOfflineDownloads: async () => undefined,
  offlineAccount: () => store.account,
  startOfflineDownload: (...a: unknown[]) => store.start(...a),
  removeOfflineDownload: async (id: string, options?: { server?: boolean }) => {
    store.remove(id, options);
    store.list = store.list.filter((d) => d.id !== id);
  },
}));

import {
  PASSAGE_OFFER_KEY,
  collectPassageDownloads,
  freeOldAddressDownloads,
  keepPassageOffer,
  passageOfferFor,
  relaunchPassageDownloads,
} from "@/lib/passage/offer";
import { PassageDownloadsCleanup, PassageDownloadsPrompt, PassageDownloadsCard } from "@/components/passage/PassageDownloads";
import { PassageInstallSteps } from "@/components/passage/PassageInstallHelp";
import { PassageDialog } from "@/components/passage/PassageDialog";
import { resetFloatingPrompts, useFloatingPromptTurn, PROMPT_RANK } from "@/lib/floatingPromptTurn";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function download(id: string, itemId: string, extra: Partial<FakeDownload> = {}): FakeDownload {
  return {
    id,
    itemId,
    state: "done",
    createdAt: 1,
    quality: "high",
    codec: "h264",
    audioIndex: 2,
    title: `Titre ${itemId.slice(0, 1)}`,
    expectedBytes: 500_000_000,
    year: 2021,
    radarrId: 7,
    runtimeSeconds: 1400,
    audioLabel: "English — 5.1",
    audioTracks: [{ index: 2, label: "English — 5.1" }],
    ...extra,
  };
}

const carried = (itemId: string) => ({
  itemId,
  quality: "high",
  codec: "h264",
  audioIndex: 2,
  title: `Titre ${itemId.slice(0, 1)}`,
  bytes: 500_000_000,
  year: 2021,
  radarrId: 7,
  runtimeSeconds: 1400,
  audioLabel: "English — 5.1",
  audioTracks: [{ index: 2, label: "English — 5.1" }],
});

let fetched: Record<string, string> = {};
const calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  env.mode = "closed";
  env.onboarding = false;
  env.old = false;
  env.enabled = true;
  store.list = [];
  store.account = "lea";
  store.start.mockReset();
  store.start.mockResolvedValue(undefined);
  store.remove.mockReset();
  fetched = {};
  calls.length = 0;
  localStorage.clear();
  resetFloatingPrompts();
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("/api/passage/fetched?")) {
      // Une vraie réponse prend du temps : la page a le loisir de se redessiner avant.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ fetched });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("au départ : la liste emportée", () => {
  it("les téléchargements terminés ou en cours de ce compte, jamais un échec", async () => {
    store.list = [download("j1", A), download("j2", B, { state: "paused", createdAt: 2 }), download("j3", C, { state: "failed" })];
    const list = await collectPassageDownloads();
    expect(list.map((d) => [d.itemId, d.quality, d.codec, d.audioIndex])).toEqual([
      [B, "high", "h264", 2],
      [A, "high", "h264", 2],
    ]);
  });

  it("la liste d'un autre compte que celui de la page ne part pas", async () => {
    store.list = [download("j1", A)];
    store.account = "autre";
    expect(await collectPassageDownloads()).toEqual([]);
  });
});

describe("à l'arrivée : la relance par le chemin normal", () => {
  it("chaque titre redemandé aux mêmes choix ; un titre refusé passe sans bruit ; un titre déjà là n'est pas redemandé", async () => {
    store.list = [download("j9", C, { state: "downloading" })];
    store.start.mockImplementation(async (r: { itemId: string }) => {
      if (r.itemId === B) throw new Error("Titre introuvable");
    });
    keepPassageOffer("lea", 1, [carried(A), carried(B), carried(C)]);
    const started = await relaunchPassageDownloads(passageOfferFor("lea")!.items);
    expect(started).toBe(1);
    expect(store.start.mock.calls.map((c) => c[0].itemId)).toEqual([A, B]);
    expect(store.start.mock.calls[0][0]).toMatchObject({ itemId: A, quality: "high", codec: "h264", audioIndex: 2, audioLabel: "English — 5.1", radarrId: 7 });
    expect(passageOfferFor("lea")).toBeNull();
  });

  it("une arrivée déjà gardée ne se remplace pas, et ne revient pas après sa fermeture", () => {
    keepPassageOffer("lea", 5, [carried(A)]);
    expect(passageOfferFor("lea")?.items).toHaveLength(1);
    expect(passageOfferFor("autre")).toBeNull();
    keepPassageOffer("lea", 5, [carried(A), carried(B)]);
    expect(passageOfferFor("lea")?.items).toHaveLength(1);
    keepPassageOffer("lea", 6, "abîmé");
    expect(passageOfferFor("lea")?.at).toBe(5);
  });
});

describe("l'invitation", () => {
  async function launch(node: React.ReactElement = <PassageDownloadsPrompt />) {
    vi.useFakeTimers();
    const view = render(node);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    return view;
  }
  const prompt = () => document.querySelector("[data-passage-downloads-prompt]");

  it("« Retélécharger vos N téléchargements (X Go) ? » une seule fois ; « Plus tard » la laisse dans la page des téléchargements", async () => {
    keepPassageOffer("lea", 1, [carried(A), carried(B)]);
    const view = await launch();
    expect(prompt()?.textContent).toContain("passage.downloads.offerMany");
    expect(prompt()?.textContent).toContain('"n":2');
    fireEvent.click(screen.getByText("passage.downloads.later"));
    expect(prompt()).toBeNull();
    view.unmount();
    await launch();
    expect(prompt()).toBeNull();
    render(<PassageDownloadsCard />);
    expect(document.querySelector("[data-passage-downloads-card]")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("passage.downloads.dismiss"));
    expect(document.querySelector("[data-passage-downloads-card]")).toBeNull();
    expect(localStorage.getItem(PASSAGE_OFFER_KEY)).toBeNull();
  });

  it("un appui relance tout, par le chemin normal", async () => {
    keepPassageOffer("lea", 1, [carried(A)]);
    await launch();
    await act(async () => {
      fireEvent.click(screen.getByText("passage.downloads.relaunch"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(prompt()).toBeNull();
  });

  it("jamais pendant un film, ni pendant l'écran d'accueil d'un premier lancement", async () => {
    keepPassageOffer("lea", 1, [carried(A)]);
    env.mode = "full";
    const view = await launch();
    expect(prompt()).toBeNull();
    view.unmount();
    env.mode = "closed";
    env.onboarding = true;
    await launch();
    expect(prompt()).toBeNull();
    expect(passageOfferFor("lea")?.prompted).toBe(false);
  });

  it("pas par-dessus l'aide d'installation : elle attend qu'elle se retire", async () => {
    keepPassageOffer("lea", 1, [carried(A)]);
    let setStep: (on: boolean) => void = () => {};
    function Step() {
      const [on, set] = useStateBox(true);
      setStep = set;
      useFloatingPromptTurn("install", PROMPT_RANK.step, on);
      return null;
    }
    await launch(
      <>
        <Step />
        <PassageDownloadsPrompt />
      </>
    );
    expect(prompt()).toBeNull();
    await act(async () => {
      setStep(false);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(prompt()).not.toBeNull();
  });
});

describe("sur l'ancienne adresse : l'effacement", () => {
  it("seulement ce que le serveur atteste ; la même version reste demandée au serveur, une autre en est retirée", async () => {
    store.list = [download("same", A), download("mine", B), download("other", C)];
    fetched = { [A]: "same", [B]: "theirs" };
    const removed = await freeOldAddressDownloads(() => false);
    expect(removed.map((d) => d.itemId)).toEqual([A, B]);
    expect(store.remove.mock.calls).toEqual([
      ["same", { server: false }],
      ["mine", { server: true }],
    ]);
    expect(store.list.map((d) => d.itemId)).toEqual([C]);
    // Une ligne au journal pour ce qui a été effacé.
    const log = calls.find((c) => c.url === "/api/passage/fetched" && c.init?.method === "POST");
    expect(JSON.parse(String(log?.init?.body))).toEqual({ removed: [A, B] });
  });

  it("sans attestation, rien ne s'efface", async () => {
    store.list = [download("j1", A)];
    expect(await freeOldAddressDownloads(() => false)).toEqual([]);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("jamais pendant une lecture — ni avant, ni si elle commence entre deux titres", async () => {
    store.list = [download("j1", A), download("j2", B)];
    fetched = { [A]: "j1", [B]: "j2" };
    expect(await freeOldAddressDownloads(() => true)).toEqual([]);
    expect(calls.some((c) => c.url.startsWith("/api/passage/fetched"))).toBe(false);
    let playing = false;
    store.remove.mockImplementation(() => {
      playing = true;
    });
    const removed = await freeOldAddressDownloads(() => playing);
    expect(removed.map((d) => d.itemId)).toEqual([A]);
  });

  it("le mot « effacés de l'ancienne adresse », même quand la page se redessine pendant la question", async () => {
    store.list = [download("j1", A), download("j2", B)];
    fetched = { [A]: "j1", [B]: "j2" };
    env.old = true;
    vi.useFakeTimers();
    render(<PassageDownloadsCleanup />);
    // Le délai du lancement, puis la réponse du serveur dans un second temps : entre les deux, la
    // page se redessine (essai de bout en bout du 23/10/2026 : le fichier partait, le mot jamais).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2510);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(document.querySelector("[data-passage-downloads-freed]")?.textContent).toContain("passage.downloads.freedMany");
    expect(store.list).toEqual([]);
  });

  it("le mot attend la fin d'un film", async () => {
    store.list = [download("j1", A)];
    fetched = { [A]: "j1" };
    env.old = true;
    env.mode = "full";
    vi.useFakeTimers();
    const view = render(<PassageDownloadsCleanup />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(store.remove).not.toHaveBeenCalled();
    expect(document.querySelector("[data-passage-downloads-freed]")).toBeNull();
    env.mode = "closed";
    view.rerender(<PassageDownloadsCleanup />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2510);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-passage-downloads-freed]")?.textContent).toContain("passage.downloads.freedOne");
  });

  it("sur la nouvelle adresse, rien n'est demandé ni effacé", async () => {
    store.list = [download("j1", A)];
    fetched = { [A]: "j1" };
    env.old = false;
    vi.useFakeTimers();
    render(<PassageDownloadsCleanup />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(store.remove).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("l'aide du passage", () => {
  it("dit « proposés à nouveau » seulement s'il y a des téléchargements", () => {
    const view = render(<PassageInstallSteps platform="ios" size="banner" />);
    expect(document.querySelector("[data-passage-downloads-note]")).toBeNull();
    view.unmount();
    render(<PassageInstallSteps platform="ios" size="banner" downloads />);
    expect(document.querySelector("[data-passage-downloads-note]")?.textContent).toBe("passage.downloads.again");
  });

  it("la fenêtre « Passer » le dit aussi, seulement avec des téléchargements sur l'appareil", async () => {
    for (const [downloads, expected] of [[[], false], [[carried(A)], true]] as const) {
      dialog.downloads = [...downloads];
      const view = render(<PassageDialog target="https://app.example.org" onClose={() => {}} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect([downloads.length, document.querySelector("[data-passage-downloads-note]") !== null]).toEqual([downloads.length, expected]);
      view.unmount();
    }
  });
});
