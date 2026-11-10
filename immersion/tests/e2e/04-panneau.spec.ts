import { expect, test, type Locator } from "@playwright/test";
import { enterWorld, place, state, watchErrors } from "../helpers";

type Handle = { openPanel(): void; dispatch(command: { type: "stop" }): void };

/**
 * Le panneau est du HTML posé dans la scène, transformé en 3D : un clic « au pixel » dépendrait de
 * l'angle de la caméra. Le clic part donc de l'élément lui-même — c'est le même gestionnaire.
 */
const press = (target: Locator) => target.evaluate((el) => (el as HTMLElement).click());

/**
 * Le panneau Laterna dans le monde, avec le compte de test sur l'instance jetable : il s'ouvre devant
 * l'écran, montre la bibliothèque du compte, cherche, ouvre une fiche et lance le film sur la télévision.
 */
test("le panneau : bibliothèque, recherche, fiche, lecture", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await enterWorld(page);
  await place(page, 1.6, -1.6, -Math.PI / 2);
  // « Ouvrir Laterna » n'est proposé qu'une fois la proximité de l'écran recalculée (une image après le déplacement).
  await expect.poll(() => state(page, "nearScreen"), { timeout: 15_000 }).toBe("salon");
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.openPanel());
  const panel = page.getByTestId("panel");
  await expect(panel).toBeVisible();
  expect(await state(page, "mode")).toBe("panel");

  // La bibliothèque du compte : des affiches.
  const posters = panel.locator("button.poster");
  await expect.poll(() => posters.count(), { timeout: 60_000 }).toBeGreaterThan(3);

  // La recherche : le titre d'une affiche, tapé, la retrouve.
  const wanted = await page.evaluate(() => {
    const library = (window as unknown as { __immersion: { store: { getState(): { panel: { library: { movies: { title: string }[] } | null } } } } }).__immersion.store.getState().panel.library;
    return library?.movies.find((m) => m.title.length >= 6)?.title ?? null;
  });
  expect(wanted).not.toBeNull();
  await page.getByTestId("panel-search").fill(wanted!);
  const found = panel.locator(`button.poster[title="${wanted!.replace(/"/g, '\\"')}"]`).first();
  await expect(found).toBeAttached({ timeout: 20_000 });

  // La fiche, puis la lecture : le panneau se ferme, le film démarre sur l'écran.
  await press(found);
  const play = page.getByTestId("play");
  await expect(play).toBeAttached({ timeout: 20_000 });
  await press(play);
  await expect.poll(async () => (await state<{ status: string }>(page, "playback")).status, { timeout: 120_000 }).toBe("playing");
  expect(await state(page, "mode")).toBe("walk");
  expect((await state<{ title: string }>(page, "playback")).title).toBe(wanted);

  // On éteint : l'arrêt part, l'écran redevient noir.
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  await expect.poll(async () => (await state<{ status: string }>(page, "playback")).status).toBe("idle");
  expect(errors).toEqual([]);
});
