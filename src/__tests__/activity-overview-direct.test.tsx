// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { buildSeances } from "@/lib/activity/seances";
import type { LogRecord } from "@/lib/activity/logReader";

/**
 * Le direct de l'Activité, la page ouverte (13/10/2026).
 *
 * La règle de Louis en accélérant l'ouverture du panneau : ce qui vit — les lectures en cours, les
 * séances récentes, la présence — reste en temps réel, sans recharger. Ce test ouvre la vue
 * d'ensemble, puis fait démarrer et s'arrêter une séance côté serveur : chacune des deux doit
 * apparaître à la relecture suivante (vingt secondes), la page restée ouverte. Il passait avant le
 * cache des appareils Jellyfin et passe après — c'est le contrat qui ne devait pas bouger.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join(",")}` : k),
  useLocale: () => "fr",
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ show: () => {}, success: () => {}, error: () => {} }) }));
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: () => {} }));

import { ActivityOverview } from "@/components/activity/views/ActivityOverview";

const NOW = Date.parse("2026-10-13T20:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

const zeroWeek = {
  since: NOW - 7 * 864e5, seances: 0, viewers: 0, watchedSeconds: 0, waits: 0, waitedMs: 0, slowSeeks: 0, seeks: 0,
  stalls: 0, rebuilds: 0, fallbacks: 0, errors: 0, lost: 0, audioSwitches: 0, clientErrors: 0, staleReloads: 0,
  tokenRefusals: 0, serverErrors: [], rebuildReasons: [], perDay: [],
};
const household = {
  days: 30,
  devices: [],
  habits: { heatmap: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)), topTitles: [] },
  diagnosis: [],
  logins: { ok: 0, failed: 0, recentFailures: [] },
  notifications: { sent: 0, delivered: 0, failed: 0, byCategory: [] },
};

function account(nowPlaying: Record<string, unknown> | null) {
  return {
    id: "lucas-id",
    name: "Lucas",
    admin: false,
    disabled: false,
    presence: { state: nowPlaying ? "playing" : "away", lastSeen: null, devices: [] },
    nowPlaying,
    app: { sessions: 1, lastSeen: NOW - 60_000 },
    jellyfin: { lastActivity: NOW - 60_000, lastLogin: null },
    alerts: [],
    week: { seances: 0, watchedSeconds: 0, problems: 0 },
  };
}

const rec = (line: number, t: number, fields: Record<string, unknown>): LogRecord =>
  ({ timestamp: iso(t), user: "Lucas", session: "s1", itemId: "ted", title: "Ted Lasso — S01E01 · Pilot", ...fields, _file: "player.log", _line: line, _t: t }) as LogRecord;

/** Ce que le serveur répond en ce moment — changé par le test entre deux relectures. */
let overview: Record<string, unknown>;
const serve = (nowPlaying: Record<string, unknown> | null, recent: unknown[]) => {
  overview = { now: NOW, accounts: [account(nowPlaying)], signals: zeroWeek, recent, household, alertsClearedAt: 0 };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("reports") ? { reports: [], unread: 0 } : url.startsWith("/api/admin/activity") ? overview : null;
      return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Activité — le direct se met à jour sans recharger", () => {
  it("une séance qui démarre puis s'arrête apparaît à la relecture suivante", async () => {
    serve(null, []);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ActivityOverview />
      </SWRConfig>
    );
    await flush();
    expect(screen.getByText("activity.live.nobody")).toBeTruthy();
    expect(screen.queryByText(/Ted Lasso/)).toBeNull();

    // La séance démarre : Jellyfin la voit en cours, le journal du lecteur a son `start`.
    const started = buildSeances([rec(0, NOW - 30_000, { kind: "start", openedMs: 900 })]);
    serve({ itemId: "ted", title: "Ted Lasso — S01E01 · Pilot", positionSeconds: 30, runtimeSeconds: 1800, paused: false, device: "iPhone", client: "CineApp", method: "DirectPlay" }, started);
    await flush(20_000);
    expect(screen.queryByText("activity.live.nobody")).toBeNull();
    // Dans « En direct » et dans le fil des séances.
    expect(screen.getAllByText(/Ted Lasso/).length).toBeGreaterThanOrEqual(2);

    // Elle s'arrête : plus personne en direct, la séance reste dans le fil, close.
    const stopped = buildSeances([
      rec(0, NOW - 30_000, { kind: "start", openedMs: 900 }),
      rec(1, NOW + 10_000, { kind: "stop", why: "close", watched: 40 }),
    ]);
    serve(null, stopped);
    await flush(20_000);
    expect(screen.getByText("activity.live.nobody")).toBeTruthy();
    expect(screen.getAllByText(/Ted Lasso/).length).toBeGreaterThanOrEqual(1);
  });
});
