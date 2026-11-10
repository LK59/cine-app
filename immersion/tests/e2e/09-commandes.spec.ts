import { expect, test, type Page } from "@playwright/test";
import { enterWorld, place, state, watchErrors } from "../helpers";

type Playback = { status: string; wantPaused: boolean; muted: boolean; duration: number; seek: { to: number } | null };
type Handle = {
  store: { getState(): { playback: Playback; settings: { volume: number; fov: number }; setSeated(seated: boolean, spot?: string): void } };
  view: { zoom: number; scale: number };
  playTestClip(url: string): Promise<void>;
  openPanel(screen?: string): void;
  dispatch(command: { type: "stop" }): void;
};
const handle = <T>(page: Page, read: (h: Handle) => T) => page.evaluate(read as never) as Promise<T>;
const playback = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().playback);
const view = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __immersion: Handle }).__immersion.view }));

/**
 * Installé, la molette rapproche l'image jusqu'à la télévision ; debout, la vue revient. Et le panneau
 * commande ce qui joue à la souris : pause, saut par la barre, son.
 */
test("la molette cadre la télévision depuis le canapé ; le panneau commande la lecture", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await enterWorld(page);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.playTestClip("/api/immersion/mire.webm"));
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");

  // Debout, la molette ne fait rien.
  await place(page, -1.9, -1.5, -Math.PI / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(600);
  expect((await view(page)).scale).toBe(1);

  // Assis : chaque cran rapproche, jusqu'à la butée ; le regard ralentit d'autant.
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().setSeated(true, "sofa"));
  await expect(page.getByTestId("hint-zoom")).toBeVisible();
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(0.1);
  const oneNotch = (await view(page)).zoom;
  expect(oneNotch).toBeLessThan(0.3);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await view(page)).zoom).toBe(1);
  await expect.poll(async () => (await view(page)).scale, { timeout: 10_000 }).toBeLessThan(0.75);
  const tight = (await view(page)).scale;
  // Jamais plus serré que la télévision entière : le champ reste au-dessus de 12°.
  expect(tight * (await state<{ fov: number }>(page, "settings")).fov).toBeGreaterThanOrEqual(12);
  // Dans l'autre sens, on revient.
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await view(page)).scale, { timeout: 10_000 }).toBe(1);

  // Se lever rend la vue normale, même rapprochée.
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await view(page)).scale, { timeout: 10_000 }).toBeLessThan(0.95);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().setSeated(false));
  await expect.poll(async () => (await view(page)).scale, { timeout: 10_000 }).toBe(1);

  // Le panneau : ce qui joue, et de quoi le commander.
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.openPanel("salon"));
  const now = page.getByTestId("now");
  await expect(now).toBeVisible();
  await page.getByTestId("now-toggle").click();
  expect((await playback(page)).wantPaused).toBe(true);
  await expect.poll(async () => (await playback(page)).status).toBe("paused");
  await page.getByTestId("now-toggle").click();
  await expect.poll(async () => (await playback(page)).status).toBe("playing");

  // La barre : un clic au milieu mène au milieu.
  const duration = (await playback(page)).duration;
  expect(duration).toBeGreaterThan(5);
  const bar = await page.getByTestId("now-bar").boundingBox();
  await page.mouse.click(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2);
  const asked = (await playback(page)).seek;
  expect(asked).not.toBeNull();
  expect(Math.abs(asked!.to - duration / 2)).toBeLessThan(0.5);

  // Le son : coupé, remis ; le volume suit le curseur.
  await page.getByTestId("now-mute").click();
  expect((await playback(page)).muted).toBe(true);
  await page.getByTestId("now-mute").click();
  expect((await playback(page)).muted).toBe(false);
  await page.getByTestId("now-volume").fill("0.35");
  expect((await state<{ volume: number }>(page, "settings")).volume).toBeCloseTo(0.35, 2);

  await handle(page, () => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  expect(errors).toEqual([]);
});
