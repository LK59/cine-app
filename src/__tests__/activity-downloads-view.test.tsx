// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";

/**
 * La vue Téléchargements de l'Activité (19/10/2026) : les versions du serveur (état, taille, comptes,
 * expiration), les derniers gestes dits en une phrase, et l'effacement d'une version confirmé d'un
 * second appui. Le serveur est simulé ; les phrases sont celles du vrai dictionnaire français.
 */
const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => "fr" }));
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: () => {} }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ show: () => {}, success: () => {}, error: () => {} }) }));

import { ActivityDownloads } from "@/components/activity/views/ActivityDownloads";
import { describeLine } from "@/components/activity/parts";

const NOW = Date.parse("2026-10-19T20:00:00Z");
const READY = "a".repeat(32);
const RUNNING = "b".repeat(32);
const base = { itemId: "f".repeat(32), fileVersion: "v1", audioIndex: 1, codec: "hevc", generation: 1, runtimeSeconds: 3600, error: null, createdAt: NOW - 7200_000 };
let copies: Record<string, unknown>[];
let calls: { url: string; method: string }[];

beforeEach(() => {
  copies = [
    { ...base, id: RUNNING, title: "Ted Lasso — S01E02", audio: "Anglais", quality: "standard", status: "running", bytes: 250_000_000, expectedBytes: 1_000_000_000, startedAt: NOW - 60_000, finishedAt: null, accessedAt: NOW, expiresAt: null, accounts: ["mathis"] },
    { ...base, id: READY, title: "1917", audio: "Français", quality: "high", status: "done", bytes: 1_800_000_000, expectedBytes: 1_900_000_000, startedAt: NOW - 3600_000, finishedAt: NOW - 3000_000, accessedAt: NOW - 600_000, expiresAt: NOW + 3 * 86400_000, accounts: ["louis", "lucas"] },
  ];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "DELETE") {
        copies = copies.filter((c) => !url.endsWith(String(c.id)));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = {
        now: NOW,
        keepDays: 3,
        eventsDays: 14,
        copies,
        totals: { ready: 1, preparing: 1, queued: 0, failed: 0, usedBytes: 2_050_000_000, freeBytes: 500_000_000_000 },
        events: [
          { timestamp: "", level: "info", scope: "offline", event: "ready", title: "1917", quality: "high", bytes: 1_800_000_000, durationMs: 600_000, speed: 9.5, accounts: ["louis", "lucas"], _file: "server.log", _line: 2, _t: NOW - 3000_000 },
          { timestamp: "", level: "info", scope: "offline", event: "requested", user: "louis", title: "1917", quality: "high", copy: "new", _file: "server.log", _line: 1, _t: NOW - 3600_000 },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ActivityDownloads />
    </SWRConfig>
  );
}

describe("ActivityDownloads", () => {
  it("montre les versions du serveur et les derniers gestes", async () => {
    mount();
    expect(await screen.findByText("Ted Lasso — S01E02")).toBeInTheDocument();
    const rows = screen.getAllByTestId("offline-copy");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("En préparation");
    expect(rows[0].textContent).toContain("25 %");
    expect(rows[0].textContent).toContain("pour mathis");
    expect(rows[1].textContent).toContain("Prête");
    expect(rows[1].textContent).toContain("pour louis, lucas");
    expect(rows[1].textContent).toContain("effacée le");
    const events = screen.getAllByTestId("download-event").map((e) => e.textContent);
    expect(events[0]).toContain("Prêt · 1917 · Haute");
    expect(events[0]).toContain("×9.5");
    expect(events[1]).toContain("louis");
    expect(events[1]).toContain("Demandé · 1917 · Haute · nouvelle version");
  });

  it("effacer une version demande un second appui, puis l'efface du serveur", async () => {
    mount();
    await screen.findByText("1917");
    fireEvent.click(screen.getAllByRole("button", { name: "Effacer" })[1]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Effacer du serveur/ }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/api/admin/offline/${READY}`, method: "DELETE" }));
    await waitFor(() => expect(screen.queryByText("1917")).toBeNull());
  });
});

describe("describeLine — téléchargements", () => {
  it("dit chaque geste dans la langue de l'écran, sans morceau vide", () => {
    expect(describeLine({ scope: "offline", event: "failed", level: "error", title: "Dune", quality: "standard", reason: "Jellyfin ne répond plus", accounts: ["lucas"] }, t)).toBe(
      "Préparation échouée · Dune · Standard · Jellyfin ne répond plus · pour lucas"
    );
    expect(describeLine({ scope: "offline", event: "cancelled", user: "lucas", title: "Dune", quality: "high", stopped: true }, t)).toBe("Annulé · Dune · Haute · préparation arrêtée");
    expect(describeLine({ scope: "offline", event: "expired", title: "Dune", quality: "high", accounts: ["lucas"] }, t)).toBe("Effacé du serveur (expiré) · Dune · Haute · pour lucas");
    expect(describeLine({ scope: "download", title: "Dune", sizeBytes: 0 }, t)).toBe("Fichier d'origine téléchargé · Dune");
  });
});
