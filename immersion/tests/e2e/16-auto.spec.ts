import { expect, test, type Page } from "@playwright/test";
import { enterWorld, state, watchErrors } from "../helpers";
import { decide, freshMemory, type AutoWindow } from "../../src/world/autoDecision";

type Handle = { store: { getState(): { updateSettings(patch: { quality: string }): void } } };
const level = (page: Page) => state<number>(page, "autoLevel");

/** Une fenêtre de 2,5 s fabriquée : dix tranches à cette cadence, et tant d'images longues. */
const win = (fps: number, over50 = 0, over33 = over50): AutoWindow => ({ samples: Array(10).fill(fps), over33, over50, refresh: 60 });
const LAST = 8;

/**
 * La décision d'« Auto », sur des cadences fabriquées : la machine de test (sans écran, puce graphique du serveur)
 * ne sait pas tenir 60 images/s régulières, elle ne pourrait jamais justifier une remontée.
 */
test.describe("la décision d'Auto", () => {
  test("descend sur une cadence basse, et sur des à-coups même quand la moyenne est bonne", () => {
    expect(decide(win(40), 0, LAST, 0, freshMemory())).toEqual({ to: 1, why: "fps" });
    expect(decide(win(59, 3), 2, LAST, 0, freshMemory())).toEqual({ to: 3, why: "acoups" });
    // Deux images longues seulement : rien.
    expect(decide(win(59, 2), 2, LAST, 0, freshMemory())).toBeNull();
    // Déjà au plus bas : rien.
    expect(decide(win(20, 9), LAST, LAST, 0, freshMemory())).toBeNull();
  });

  test("remonte avec de la marge et sans image longue, pas dans les 10 s qui suivent une descente", () => {
    const memory = freshMemory();
    expect(decide(win(30), 1, LAST, 0, memory)).toEqual({ to: 2, why: "fps" });
    expect(decide(win(60), 2, LAST, 5_000, memory)).toBeNull();
    expect(decide(win(60), 2, LAST, 10_000, memory)).toEqual({ to: 1, why: "marge" });
    // Une seule image de plus de 33 ms dans la fenêtre : pas de remontée.
    expect(decide(win(60, 0, 1), 1, LAST, 40_000, freshMemory())).toBeNull();
  });

  test("un aller-retour interdit de remonter 60 s, puis le double ; jamais de gel définitif", () => {
    const memory = freshMemory();
    let t = 0;
    let lvl = 0;
    const step = (fps: number) => {
      const s = decide(win(fps), lvl, LAST, t, memory);
      if (s) lvl = s.to;
      return s;
    };
    expect(step(30)?.why).toBe("fps"); // 0 → 1
    t += 10_000;
    expect(step(60)?.why).toBe("marge"); // 1 → 0
    t += 5_000;
    expect(step(30)?.why).toBe("fps"); // aller-retour : 60 s sans remonter
    t += 50_000;
    expect(step(60)).toBeNull();
    t += 11_000;
    expect(step(60)?.why).toBe("marge");
    t += 5_000;
    expect(step(30)?.why).toBe("fps"); // second aller-retour : 120 s
    t += 100_000;
    expect(step(60)).toBeNull();
    t += 21_000;
    expect(step(60)?.why).toBe("marge");
    // Douze changements plus tard, il bouge toujours (l'ancien moniteur se figeait au cinquième).
    for (let i = 0; i < 12; i++) {
      t += 400_000;
      expect(step(i % 2 ? 60 : 30)).not.toBeNull();
    }
  });
});

/**
 * Dans le navigateur : un rendu freiné à la main (une attente active dans chaque image) fait descendre « Auto », et
 * la visite laisse en partant une ligne `immersion-auto` qui le dit.
 */
test("Auto descend quand la machine peine, et le dit au journal en partant", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  const lines: Record<string, unknown>[] = [];
  await page.route("**/api/viewport-diag", async (route) => {
    lines.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await enterWorld(page);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().updateSettings({ quality: "auto" }));
  const start = await level(page);

  // Le frein : chaque image attend 40 ms de plus — moins de 25 images par seconde.
  await page.evaluate(() => {
    const tick = () => {
      const until = performance.now() + 40;
      while (performance.now() < until) {
        // attente active
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await expect.poll(() => level(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(start + 2);

  // En partant, la ligne de la visite. (L'évènement que le navigateur émet en quittant la page, émis à la main : une
  // requête partie d'une page qui se décharge échappe à l'interception de Playwright.)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => lines.find((l) => l.kind === "immersion-auto"), { timeout: 10_000 }).toBeTruthy();
  const line = lines.find((l) => l.kind === "immersion-auto")!;
  expect(line.startLevel).toBe(start);
  expect(line.worst).toBeGreaterThanOrEqual(start + 2);
  expect(line.count).toBeGreaterThanOrEqual(2);
  expect(String(line.changes)).toMatch(/^\d+:\d+>\d+[fa](;\d+:\d+>\d+[fam])+$/);
  expect(errors).toEqual([]);
});
