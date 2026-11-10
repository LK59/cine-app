import { expect, test, type Page } from "@playwright/test";
import { enterWorld, place, watchErrors } from "../helpers";

type Levels = Record<string, { reach: number; cutoff: number }>;

/** Ce que chaque haut-parleur laisse passer, une fois le visiteur posé (les gains glissent : on attend qu'ils se posent). */
async function levelsAt(page: Page, x: number, z: number, y = 0): Promise<Levels> {
  await place(page, x, z, 0, 0, y);
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const list = (window as unknown as { __immersion: { speakerLevels(): { id: string; reach: number; cutoff: number }[] } }).__immersion.speakerLevels();
    return Object.fromEntries(list.map((s) => [s.id, { reach: s.reach, cutoff: s.cutoff }]));
  });
}

/**
 * Le son sort de chaque télévision, jusqu'à sa portée et pas au-delà ; par endroits on en entend deux.
 * Vérifié sur le graphe audio lui-même : le gain de portée et le filtre de chaque haut-parleur.
 */
test("chaque télévision a sa portée, et les portées se recouvrent", async ({ page }) => {
  const errors = watchErrors(page);
  await enterWorld(page);
  // Une vidéo joue : sans source, les haut-parleurs ne sont pas dans le graphe et leurs gains ne vivent pas.
  await page.evaluate(() => (window as unknown as { __immersion: { playTestClip(url: string): Promise<void> } }).__immersion.playTestClip("/api/immersion/mire.webm"));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __immersion: { store: { getState(): { playback: { status: string } } } } }).__immersion.store.getState().playback.status), { timeout: 30_000 })
    .toBe("playing");

  // Sur le canapé : le salon à plein, la chambre hors de portée.
  const sofa = await levelsAt(page, -1.9, -1.5);
  expect(Object.keys(sofa).sort()).toEqual(["chambre", "cuisine", "salon"]);
  expect(sofa.salon.reach).toBeGreaterThan(0.98);
  expect(sofa.salon.cutoff).toBeGreaterThan(15000);
  expect(sofa.chambre.reach).toBeLessThan(0.02);

  // Dans la cuisine, devant son écran : le sien à plein, et celui du salon encore là — deux à la fois.
  const kitchen = await levelsAt(page, 3.5, 7.3);
  expect(kitchen.cuisine.reach).toBeGreaterThan(0.98);
  expect(kitchen.salon.reach).toBeGreaterThan(0.5);
  expect(kitchen.chambre.reach).toBeLessThan(0.02);

  // Au bout est du couloir : la cuisine et la chambre ensemble, étouffées par les murs ; le salon, en fin
  // de portée (13 m sur 14), n'est plus qu'un reste.
  const hall = await levelsAt(page, 0.5, 10.9);
  expect(hall.cuisine.reach).toBeGreaterThan(0.5);
  expect(hall.chambre.reach).toBeGreaterThan(0.9);
  expect(hall.salon.reach).toBeLessThan(0.2);
  expect(hall.cuisine.cutoff).toBeLessThan(2500);

  // Dans la chambre, au pied du lit : son écran seul.
  const bedroom = await levelsAt(page, -3.4, 14.3);
  expect(bedroom.chambre.reach).toBeGreaterThan(0.98);
  expect(bedroom.chambre.cutoff).toBeGreaterThan(15000);
  expect(bedroom.cuisine.reach).toBeLessThan(0.02);
  expect(bedroom.salon.reach).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});
