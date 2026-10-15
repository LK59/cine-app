// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleWarmPanels, WARM_PANELS_DELAY_MS } from "@/lib/warmPanels";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 15/10/2026 (passe de nuit, ROBUSTESSE-4) : hors ligne, ouvrir la Recherche, Ma liste ou le Compte
// pour la première fois remplaçait l'application par `offline.html` — leur code n'était pas encore
// sur l'appareil.
describe("le code des écrans chargés à la demande", () => {
  it("est demandé une fois l'accueil au repos, un écran après l'autre", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const loaders = ["recherche", "liste", "compte"].map((name) => async () => void order.push(name));
    scheduleWarmPanels({ loaders });
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(WARM_PANELS_DELAY_MS + 6_000);
    expect(order).toEqual(["recherche", "liste", "compte"]);
  });

  it("rien en économie de données, et rien après l'annulation", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
    scheduleWarmPanels({ loaders: [load] });
    await vi.advanceTimersByTimeAsync(WARM_PANELS_DELAY_MS + 6_000);
    expect(load).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    const cancel = scheduleWarmPanels({ loaders: [load] });
    cancel();
    await vi.advanceTimersByTimeAsync(WARM_PANELS_DELAY_MS + 6_000);
    expect(load).not.toHaveBeenCalled();
  });

  // Les mêmes chargeurs que `next/dynamic` : un `import()` écrit ailleurs donnait un autre morceau
  // (Turbopack découpe par endroit d'import), et la Recherche réclamait encore le sien hors ligne.
  it("garde, par les chargeurs mêmes de la coquille, chaque écran ouvert depuis la navigation", () => {
    const shell = readFileSync(join(process.cwd(), "src/components/player/PlayerShell.tsx"), "utf8");
    const warmCall = shell.slice(shell.indexOf("scheduleWarmPanels({"), shell.indexOf("scheduleWarmPanels({") + 400);
    for (const name of ["PlayerSearchPanel", "PlayerListPanel", "PlayerAccountPanel", "PlayerReportPanel", "PlayerNewsPanel", "PlayerDiscoverSheet", "PlayerPersonSheet"]) {
      expect(shell, name).toContain(`const ${name} = dynamic(load${name},`);
      expect(warmCall, name).toContain(`load${name}`);
    }
    // Jamais l'activité : administrateur seul.
    expect(warmCall).not.toContain("Activity");
    const warm = readFileSync(join(process.cwd(), "src/lib/warmPanels.ts"), "utf8");
    expect(warm).not.toMatch(/=>\s*import\(/);
  });
});
