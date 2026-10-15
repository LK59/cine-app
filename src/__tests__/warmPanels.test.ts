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

  it("couvre chaque écran que la coquille charge à la demande, sauf l'activité (administrateur)", () => {
    const shell = readFileSync(join(process.cwd(), "src/components/player/PlayerShell.tsx"), "utf8");
    const warm = readFileSync(join(process.cwd(), "src/lib/warmPanels.ts"), "utf8");
    const lazy = [...shell.matchAll(/dynamic\(\(\) => import\("\.\/(\w+)"\)/g)].map((m) => m[1]);
    expect(lazy.length).toBeGreaterThan(5);
    for (const name of lazy) {
      // L'activité : administrateur seul. Les décodeurs et l'accueil « Bienvenue » : ils tirent le
      // décodeur FLAC, qu'un `import()` hors de `next/dynamic` ferait entrer dans le rendu serveur.
      if (name === "PlayerActivityPanel" || name === "DecoderWarmup" || name === "PlayerOnboarding") continue;
      expect(warm, name).toContain(`import("@/components/player/${name}")`);
    }
    expect(shell).toContain("scheduleWarmPanels()");
  });
});
