// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";

/**
 * La vue « Changement d'adresse » de l'Activité (DECISIONS.md §119) : un statut lisible par compte,
 * ceux de l'ancienne adresse en tête, et rien du tout sans nouvelle adresse annoncée. Le serveur est
 * simulé ; les phrases sont celles du vrai dictionnaire français.
 */
const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => "fr" }));

import { AddressChangePanel } from "@/components/activity/AddressChange";

const NOW = Date.parse("2026-10-25T20:00:00Z");
const row = (user: string, status: string, extra: Record<string, unknown> = {}) => ({
  user,
  status,
  lastOld: null,
  lastNew: null,
  newInstalled: false,
  lastUnknown: null,
  passageRequested: null,
  passageReceived: null,
  ...extra,
});
let body: Record<string, unknown>;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AddressChangePanel />
    </SWRConfig>
  );

describe("AddressChangePanel", () => {
  it("dit où en est chaque compte, dans l'ordre reçu", async () => {
    body = {
      newHost: "app.example.org",
      since: new Date(2026, 9, 23).getTime(),
      now: NOW,
      rows: [
        row("Sarah", "old", { lastOld: NOW - 3600_000, passageRequested: NOW - 7200_000 }),
        row("Mathis", "never"),
        row("Raphael", "unknown", { lastUnknown: NOW - 86_400_000 }),
        row("Lucas", "moved", { lastNew: NOW - 60_000, passageReceived: NOW - 120_000 }),
        row("Louis", "movedInstalled", { lastNew: NOW - 60_000, newInstalled: true }),
      ],
    };
    mount();
    const list = await screen.findByTestId("address-change-rows");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Encore sur l'ancienne adresse"),
      expect.stringContaining("Jamais ouvert depuis le changement"),
      expect.stringContaining("Ouvert depuis, adresse inconnue"),
      expect.stringContaining("Passé, pas encore installé"),
      expect.stringContaining("Passé, app installée"),
    ]);
    expect(items[0].textContent).toContain("demandé il y a 2 h");
    expect(items[3].textContent).toContain("reçu il y a 2 min");
    expect(screen.getByText("2 sur 5 passés · 1 avec l'app installée")).toBeTruthy();
    expect(screen.getByText(/app\.example\.org/)).toBeTruthy();
  });

  it("ne montre rien sans nouvelle adresse annoncée", async () => {
    body = { newHost: null, since: 0, now: NOW, rows: [] };
    const { container } = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetch).toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
