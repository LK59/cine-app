import { describe, it, expect } from "vitest";
import { activityDigest, liveAccounts, pendingReports } from "@/lib/activity/summary";
import type { AccountSummary, WeekSignals } from "@/lib/activity/accounts";
import type { ReportSummary } from "@/lib/reports";

/**
 * Le résumé de l'Activité sur l'accueil de la gestion (DECISIONS.md §81) compte exactement ce que
 * le panneau Activité compte : une seule règle pour « présent », « regarde », « en attente ».
 */
const account = (id: string, state: string, playing = false) =>
  ({ id, name: id, presence: { state }, nowPlaying: playing ? { title: "x" } : null }) as unknown as AccountSummary;

const signals = (over: Partial<WeekSignals> = {}) =>
  ({ errors: 2, clientErrors: 3, serverErrors: [{ scope: "api", count: 4 }, { scope: "cron", count: 1 }, { scope: "a", count: 2 }, { scope: "b", count: 7 }], ...over }) as unknown as WeekSignals;

describe("le résumé de l'Activité", () => {
  it("compte présents et séances comme la vue en direct", () => {
    const accounts = [account("a", "away"), account("b", "app"), account("c", "playing"), account("d", "away", true)];
    const { live, playing } = liveAccounts(accounts);
    expect(live.map((a) => a.id)).toEqual(["b", "c", "d"]);
    expect(playing).toBe(2);
  });

  it("n'attend que les signalements ouverts ou en cours", () => {
    const reports = ["open", "in_progress", "resolved", "closed"].map((status, id) => ({ id, status }) as unknown as ReportSummary);
    expect(pendingReports(reports).map((r) => r.id)).toEqual([0, 1]);
  });

  it("additionne les erreurs de la semaine et garde les trois portées les plus fréquentes", () => {
    const d = activityDigest({ accounts: [account("b", "app")], signals: signals() }, null);
    expect(d.active).toBe(1);
    expect(d.pendingReports).toBeNull();
    expect(d.errors).toEqual({ server: 14, client: 3, player: 2 });
    expect(d.topServerErrors.map((e) => e.scope)).toEqual(["b", "api", "a"]);
  });
});
