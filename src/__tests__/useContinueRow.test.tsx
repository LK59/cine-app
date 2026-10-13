// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, cleanup } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import { fakeIndexedDb } from "./helpers/fakeIndexedDb";
import { SWRProvider } from "@/components/SWRProvider";
import { PERSISTED_CACHE_SCHEMA, catalogueCacheReady, noteResponse, resetPersistentCacheForTests, swrEntryHolds, writeEntries } from "@/lib/persistentCache";
import { MOVIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { followOnlyOptions, fetcher, NEXT_UP_KEY, RESUME_KEY } from "@/lib/swr";
import {
  LEAVE_MS,
  continueChanges,
  episodeStartFrom,
  movieStartFrom,
  useContinueRow,
  withLeaving,
  type FeedStart,
} from "@/lib/useContinueRow";

/**
 * « Reprendre » à l'ouverture (13/10/2026, DECISIONS.md §86) : dessiné tout de suite depuis le cache
 * de l'appareil, puis corrigé par la réponse du serveur en glissant — et jamais lancé à la position
 * du cache. Le vrai SWR, le vrai fournisseur, un IndexedDB en mémoire, un réseau tenu à la main.
 */

const TICKS = 10_000_000;
const movie = (id: string, minutes: number, playedAt: number) => ({
  id,
  name: `Film ${id}`,
  type: "Movie",
  progress: 10,
  positionTicks: minutes * 60 * TICKS,
  runtimeTicks: 120 * 60 * TICKS,
  imageTag: null,
  cinemaHref: null,
  lastPlayedAt: new Date(Date.UTC(2026, 9, playedAt)).toISOString(),
});

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };
let network: Map<string, Deferred>;
let posted: Record<string, unknown>[];
let animations: { key: string; frames: Keyframe[] }[];
let reducedMotion: boolean;

function answer(url: string): Deferred {
  let d = network.get(url);
  if (!d) {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Un rejet posé avant que la requête ne parte n'a encore personne pour l'écouter.
    promise.catch(() => {});
    d = { promise, resolve, reject };
    network.set(url, d);
  }
  return d;
}

beforeEach(() => {
  resetPersistentCacheForTests();
  network = new Map();
  posted = [];
  animations = [];
  reducedMotion = false;
  vi.stubGlobal("indexedDB", fakeIndexedDb());
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/api/startup-timing") {
        posted.push(JSON.parse(init?.body ?? "{}"));
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
      return answer(url).promise.then((data) => ({ ok: true, status: 200, json: async () => data }));
    })
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce") ? reducedMotion : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom ne met rien en page : chaque carte porte sa position dans `data-x`.
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return Number(this.dataset.x ?? 0); } });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return 0; } });
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
    animations.push({ key: this.dataset.key ?? "", frames });
    return {} as Animation;
  }) as unknown as HTMLElement["animate"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Comme `useResumeCache` : monté par la page avant que le cinéma n'attende le cache. */
function Follower() {
  useSWR(RESUME_KEY, fetcher, followOnlyOptions);
  useSWR(NEXT_UP_KEY, fetcher, followOnlyOptions);
  return null;
}

function Row({ onPlay }: { onPlay: (start: FeedStart) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const row = useContinueRow(track);
  return (
    <div>
      {row.pending && <p data-testid="squelette" />}
      <div ref={track} data-testid="rangée">
        {row.shown.map((entry, i) => (
          <button
            key={entry.key}
            data-key={entry.key}
            data-x={i * 100}
            className={entry.leaving ? "continue-leaving" : ""}
            onClick={() =>
              row.playWhenFresh((feeds) =>
                onPlay(entry.kind === "movie" ? movieStartFrom(feeds, entry.item.id, entry.item.name) : episodeStartFrom(feeds, entry.item))
              )
            }
          >
            {entry.key}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Comme la page du cinéma : ne se monte qu'une fois le cache relu. `catalogueCacheReady` n'est résolu
 * qu'une fois par module — par le premier test —, d'où la marge : le faux IndexedDB répond en
 * quelques tours.
 */
function Gate({ onPlay }: { onPlay: (start: FeedStart) => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void catalogueCacheReady(2000)
      .then(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .then(() => setReady(true));
  }, []);
  return ready ? <Row onPlay={onPlay} /> : null;
}

function app(account: string, onPlay: (start: FeedStart) => void = () => {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <SWRProvider account={account}>
        <Follower />
        <Gate onPlay={onPlay} />
      </SWRProvider>
    </SWRConfig>
  );
}

const shownKeys = () => Array.from(screen.getByTestId("rangée").querySelectorAll("button")).map((b) => b.dataset.key);

async function cached(account: string, resumeItems: unknown[], nextUpItems: unknown[] = []) {
  const savedAt = Date.now();
  await writeEntries([
    { account, key: RESUME_KEY, savedAt, schema: PERSISTED_CACHE_SCHEMA, data: { items: resumeItems } },
    { account, key: NEXT_UP_KEY, savedAt, schema: PERSISTED_CACHE_SCHEMA, data: { items: nextUpItems } },
  ]);
}

describe("« Reprendre » à l'ouverture", () => {
  it("se dessine tout de suite depuis le cache, même quand un crochet qui ne demande rien suit déjà la clé", async () => {
    await cached("louis", [movie("a", 30, 3), movie("b", 20, 2)]);
    app("louis");
    await waitFor(() => expect(shownKeys()).toEqual(["a", "b"]));
    expect(screen.queryByTestId("squelette")).toBeNull();
    // Et la réponse fraîche est demandée aussitôt — rien n'en est encore revenu.
    await waitFor(() => expect(network.get(RESUME_KEY)).toBeDefined());
    expect(shownKeys()).toEqual(["a", "b"]);
  });

  it("une entrée que SWR a seulement inscrite n'empêche pas l'hydratation ; une requête en vol, si", () => {
    expect(swrEntryHolds(undefined)).toBe(false);
    expect(swrEntryHolds({ _k: RESUME_KEY })).toBe(false);
    expect(swrEntryHolds({ isValidating: true })).toBe(true);
    expect(swrEntryHolds({ data: { items: [] } })).toBe(true);
    expect(swrEntryHolds({ error: new Error("x") })).toBe(true);
  });

  it("ne montre jamais le cache d'un autre compte", async () => {
    await cached("lucas", [movie("chez-lucas", 30, 3)]);
    app("louis");
    await waitFor(() => expect(network.get(RESUME_KEY)).toBeDefined());
    expect(shownKeys()).toEqual([]);
    expect(screen.getByTestId("squelette")).toBeTruthy();
    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).resolve({ items: [movie("chez-louis", 5, 1)] });
    });
    await waitFor(() => expect(shownKeys()).toEqual(["chez-louis"]));
  });

  it("se corrige à la réponse fraîche : déplacement et arrivée animés, départ effacé puis retiré, et le compte rendu part avec la ligne d'ouverture", async () => {
    await cached("louis", [movie("a", 30, 3), movie("b", 20, 2), movie("c", 10, 1)]);
    app("louis");
    await waitFor(() => expect(shownKeys()).toEqual(["a", "b", "c"]));
    expect(animations).toEqual([]);

    // Sur la télé hier soir : « c » repris (il remonte, sa barre avance), « b » fini, « d » commencé.
    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).resolve({ items: [movie("c", 45, 5), movie("a", 30, 3), movie("d", 5, 2)] });
    });
    // « b » reste le temps de s'effacer, à sa place d'avant (après « a »), et ne répond plus.
    await waitFor(() => expect(shownKeys()).toEqual(["c", "a", "b", "d"]));
    const leaving = screen.getByText("b");
    expect(leaving.className).toContain("continue-leaving");
    // « c » et « a » glissent, « d » se pose (« b », qui s'efface, suit sa place pendant ce temps).
    await waitFor(() => expect(animations.map((a) => a.key)).toEqual(expect.arrayContaining(["a", "c", "d"])));
    const firstWave = animations.length;
    expect(animations.find((a) => a.key === "d")?.frames[0]).toMatchObject({ opacity: 0 });
    expect(animations.find((a) => a.key === "c")?.frames[0]).toMatchObject({ transform: expect.stringContaining("translate") });

    // Puis il part, et ses voisines glissent dans le trou.
    await waitFor(() => expect(shownKeys()).toEqual(["c", "a", "d"]), { timeout: LEAVE_MS + 1000 });
    await waitFor(() => expect(animations.slice(firstWave).map((a) => a.key)).toEqual(["d"]));
    expect(animations[animations.length - 1].frames[0]).toEqual({ transform: "translate(100px, 0px)" });

    // La ligne d'ouverture attend la correction, puis l'emporte — sans envoi de plus.
    act(() => noteResponse(MOVIES_CATALOGUE_KEY, { movies: [] }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ resumeFromCache: true, resumeAdded: 1, resumeRemoved: 1, resumeMoved: 2, resumeProgressed: 1 });
  });

  it("« Réduire les animations » : la rangée est remplacée, sans carte qui s'efface ni glissement", async () => {
    reducedMotion = true;
    await cached("louis", [movie("a", 30, 3), movie("b", 20, 2)]);
    app("louis");
    await waitFor(() => expect(shownKeys()).toEqual(["a", "b"]));
    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).resolve({ items: [movie("c", 5, 4), movie("a", 30, 3)] });
    });
    await waitFor(() => expect(shownKeys()).toEqual(["c", "a"]));
    expect(document.querySelector(".continue-leaving")).toBeNull();
    expect(animations).toEqual([]);
  });
});

describe("un appui sur une carte dessinée depuis le cache", () => {
  it("attend la réponse du serveur et part à la position fraîche — jamais à celle du cache", async () => {
    await cached("louis", [movie("a", 30, 3)]);
    const onPlay = vi.fn();
    app("louis", onPlay);
    await waitFor(() => expect(shownKeys()).toEqual(["a"]));
    fireEvent.click(screen.getByText("a"));
    expect(onPlay).not.toHaveBeenCalled();

    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).resolve({ items: [movie("a", 52, 6)] });
    });
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(onPlay).toHaveBeenCalledWith({ itemId: "a", title: "Film a", resumeAt: 52 * 60 });
  });

  it("un titre sorti de la liste fraîche part sans position : le serveur décide", async () => {
    await cached("louis", [movie("a", 30, 3)]);
    const onPlay = vi.fn();
    app("louis", onPlay);
    await waitFor(() => expect(shownKeys()).toEqual(["a"]));
    fireEvent.click(screen.getByText("a"));
    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).resolve({ items: [] });
    });
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(onPlay.mock.calls[0][0]).toEqual({ itemId: "a", title: "Film a", resumeAt: undefined });
  });

  it("une réponse qui échoue libère l'appui, sans position", async () => {
    await cached("louis", [movie("a", 30, 3)]);
    const onPlay = vi.fn();
    app("louis", onPlay);
    await waitFor(() => expect(shownKeys()).toEqual(["a"]));
    fireEvent.click(screen.getByText("a"));
    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).reject(new Error("hors ligne"));
    });
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(onPlay.mock.calls[0][0].resumeAt).toBeUndefined();
  });

  it("une fois la liste fraîche, part tout de suite", async () => {
    await cached("louis", [movie("a", 30, 3)]);
    const onPlay = vi.fn();
    app("louis", onPlay);
    await act(async () => {
      answer(NEXT_UP_KEY).resolve({ items: [] });
      answer(RESUME_KEY).resolve({ items: [movie("a", 31, 3)] });
    });
    // Les deux requêtes parties (SWR les lance à l'image suivante) et leurs réponses posées.
    const asked = () => (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0]);
    await waitFor(() => expect(asked()).toEqual(expect.arrayContaining([RESUME_KEY, NEXT_UP_KEY])));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    fireEvent.click(screen.getByText("a"));
    expect(onPlay).toHaveBeenCalledWith({ itemId: "a", title: "Film a", resumeAt: 31 * 60 });
  });
});

describe("les règles, à plat", () => {
  it("une carte partante reste après sa dernière voisine encore là", () => {
    const k = (...keys: string[]) => keys.map((key) => ({ key }));
    expect(withLeaving(k("a", "b", "c"), k("c", "a", "d")).map((e) => `${e.key}${e.leaving ? "-" : ""}`)).toEqual(["c", "a", "b-", "d"]);
    expect(withLeaving(k("x", "a"), k("a")).map((e) => `${e.key}${e.leaving ? "-" : ""}`)).toEqual(["x-", "a"]);
    expect(withLeaving(k("a"), k("a", "b")).map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("compte ajouts, retraits, déplacements et barres qui bougent", () => {
    const snap = (pairs: [string, number][]) => ({ keys: pairs.map(([k]) => k), progress: new Map(pairs) });
    expect(continueChanges(snap([["a", 1], ["b", 2], ["c", 3]]), snap([["c", 4], ["a", 1], ["d", 0]]))).toEqual({ added: 1, removed: 1, moved: 2, progressed: 1 });
    expect(continueChanges(snap([["a", 1]]), snap([["a", 1]]))).toEqual({ added: 0, removed: 0, moved: 0, progressed: 0 });
  });

  it("un épisode fini ailleurs : la liste fraîche nomme le suivant de la même série", () => {
    const ep = (id: string, sonarrId: number, minutes: number | null) => ({
      jellyfinItemId: id,
      title: `Série ${sonarrId}`,
      thumbnailUrl: null,
      seasonNumber: 1,
      episodeNumber: 1,
      resumeTicks: minutes === null ? null : minutes * 60 * TICKS,
      runtimeTicks: 40 * 60 * TICKS,
      sonarrId,
      lastPlayedAt: null,
    });
    const feeds = { resume: undefined, nextUp: { items: [ep("e4", 7, null)] } };
    expect(episodeStartFrom(feeds, ep("e3", 7, 12))).toEqual({ itemId: "e4", title: "Série 7", resumeAt: 0 });
    expect(episodeStartFrom(feeds, ep("x1", 9, 12))).toEqual({ itemId: "x1", title: "Série 9", resumeAt: undefined });
  });
});
