// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La vue Journaux de l'Activité (14/10/2026) : « Actualiser », le rafraîchissement automatique
 * toutes les 20 s quand la page est visible, les lignes neuves ajoutées en tête sans perdre les
 * pages déjà chargées, l'heure à la seconde, la chronologie d'un incident et le JSON replié à la
 * largeur. Le serveur est simulé : un journal (le plus ancien d'abord), des pages de deux lignes,
 * un curseur absolu comme celui de la vraie route (une ligne ajoutée ne décale pas les suivantes).
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join(",")}` : k),
  useLocale: () => "fr",
}));
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: () => {} }));

import { ActivityLogs, freshLines } from "@/components/activity/views/ActivityLogs";

const NOW = Date.parse("2026-10-14T08:12:50Z");
const PAGE = 2;
let log: Record<string, unknown>[];
let calls: string[];

const line = (n: number, extra: Record<string, unknown> = {}) => ({ timestamp: new Date(NOW - (100 - n) * 1000).toISOString(), kind: "seek", title: `L${n}`, user: "lucas", ...extra, _file: "player.log", _line: n, _t: NOW - (100 - n) * 1000 });

function page(url: URL) {
  const cursor = url.searchParams.get("cursor");
  const end = cursor ? Number(cursor) : log.length;
  const items = log.slice(Math.max(0, end - PAGE), end).reverse();
  const withFacets = !cursor && url.searchParams.get("facets") !== "0";
  return {
    source: url.searchParams.get("source"),
    generations: 1,
    items,
    nextCursor: end - PAGE > 0 ? String(end - PAGE) : null,
    ...(withFacets && { facets: { users: ["lucas"], types: [{ name: "seek", count: log.length }], recentLines: log.length, partial: false } }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  log = [1, 2, 3, 4, 5].map((n) => line(n));
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw: string) => {
      calls.push(raw);
      const url = new URL(raw, "https://cine.example");
      const body = url.pathname.endsWith("/logs/line")
        ? { ...log[Number(url.searchParams.get("line")) - 1], timeline: "0,10.0,2.1,8.5,0,P;5000,15.0,0.4,1.2,0,A" }
        : page(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ActivityLogs preset={{ source: "player" }} />
    </SWRConfig>
  );
}

const titles = () => screen.queryAllByText(/^L\d+$/).map((el) => el.textContent);
const headPolls = () => calls.filter((c) => c.includes("facets=0")).length;

describe("freshLines", () => {
  const a = line(10);
  const b = line(11);
  const c = line(12);
  it("les lignes plus récentes que la première affichée, jusqu'à la couture", () => {
    expect(freshLines([c, b, a], a, false)).toEqual({ lines: [c, b], gap: false });
    expect(freshLines([a], a, false).lines).toEqual([]);
  });
  it("reconnaît une ligne par son instant et son rang, pas par son fichier (une rotation renomme)", () => {
    expect(freshLines([c, { ...a, _file: "player.log.1" }], a, false).lines).toEqual([c]);
  });
  it("une page entièrement neuve avec d'autres lignes derrière : un trou", () => {
    expect(freshLines([c, b], a, true)).toEqual({ lines: [c, b], gap: true });
  });
  it("une liste vide au chargement : tout est neuf", () => {
    expect(freshLines([c], undefined, false).lines).toEqual([c]);
  });
});

describe("ActivityLogs — rafraîchissement", () => {
  it("toutes les 20 s, les lignes arrivées s'ajoutent en tête sans perdre les pages chargées", async () => {
    mount();
    await flush();
    expect(titles()).toEqual(["L5", "L4"]);
    fireEvent.click(screen.getByText("activity.logs.more"));
    await flush();
    expect(titles()).toEqual(["L5", "L4", "L3", "L2"]);

    // Rien au montage : la liste vient d'être chargée.
    expect(headPolls()).toBe(0);
    log.push(line(6), line(7));
    await flush(20_000);
    expect(headPolls()).toBe(1);
    expect(titles()).toEqual(["L7", "L6", "L5", "L4", "L3", "L2"]);
    // Les pages déjà chargées n'ont pas été relues pour autant.
    expect(calls.filter((c) => c.includes("cursor=")).length).toBe(1);

    // Au tour suivant sans nouveauté, rien ne double.
    await flush(20_000);
    expect(titles()).toEqual(["L7", "L6", "L5", "L4", "L3", "L2"]);
  });

  it("page cachée : pas de relecture", async () => {
    mount();
    await flush();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    log.push(line(6));
    await flush(60_000);
    expect(headPolls()).toBe(0);
    expect(titles()).toEqual(["L5", "L4"]);
  });

  it("« Actualiser » relit la liste depuis la plus récente", async () => {
    mount();
    await flush();
    const firstPages = calls.filter((c) => !c.includes("cursor=") && !c.includes("facets=0")).length;
    log.push(line(6));
    fireEvent.click(screen.getByRole("button", { name: "activity.logs.refresh" }));
    await flush();
    expect(calls.filter((c) => !c.includes("cursor=") && !c.includes("facets=0")).length).toBe(firstPages + 1);
    expect(titles()).toEqual(["L6", "L5"]);
  });

  it("le journal des ouvertures est une source", async () => {
    mount();
    await flush();
    fireEvent.click(screen.getByText("activity.logs.sources.startup"));
    await flush();
    expect(calls.some((c) => c.includes("source=startup"))).toBe(true);
  });
});

describe("ActivityLogs — une ligne", () => {
  it("l'heure à la seconde ; dépliée, sa chronologie en tableau et son JSON replié à la largeur", async () => {
    mount();
    await flush();
    const row = screen.getByText("L5").closest("button")!;
    expect(row.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    fireEvent.click(row);
    await flush();
    expect(screen.getByText("activity.seance.ring.title")).toBeTruthy();
    const pre = document.querySelector("pre")!;
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.className).not.toMatch(/(^|\s)overflow-auto(\s|$)/);
    // La chronologie a son tableau : elle ne se répète pas en une chaîne dans le JSON.
    expect(pre.textContent).not.toContain("timeline");
  });
});
