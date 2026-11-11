import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { place, position, state, watchErrors } from "../helpers";

// Un téléphone tenu en paysage : pas de pointeur fin, un écran qui sent les doigts.
test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

type Handle = {
  store: { getState(): { seated: boolean; setSeated(seated: boolean, spot?: string): void } };
  rig: { yaw: number };
  view: { zoom: number };
};
type Point = { x: number; y: number; id: number };
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", touchPoints: Point[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
const yaw = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.rig.yaw);

/**
 * Au doigt : on entre d'un toucher, le pouce gauche fait marcher, un doigt à droite tourne le regard, deux
 * doigts rapprochent l'image une fois assis, et les gestes du clavier sont des boutons. Le panneau se dessine
 * à plat, sur tout l'écran.
 */
test("un téléphone en paysage : manche, regard, boutons, panneau à plat", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await page.goto("/immersion");
  const enter = page.getByTestId("enter");
  await expect(enter).toBeVisible({ timeout: 240_000 });
  // Le bouton respire (un halo animé) : le toucher est envoyé sans attendre qu'il « se stabilise ».
  await enter.tap({ force: true });
  await expect.poll(() => state(page, "phase"), { timeout: 90_000 }).toBe("world");
  // Entré d'un toucher : le regard est tenu, sans pointeur à verrouiller — la visite commence, pas le menu.
  await expect.poll(() => state(page, "mode")).toBe("walk");
  await expect(page.getByTestId("touch")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);

  // Le manche : le pouce posé à gauche puis poussé vers le haut fait avancer ; relâché, on s'arrête.
  await place(page, -1.2, 3.1, 0);
  const before = await position(page);
  await touch(cdp, "touchStart", [{ x: 120, y: 260, id: 1 }]);
  await touch(cdp, "touchMove", [{ x: 120, y: 190, id: 1 }]);
  await page.waitForTimeout(900);
  await touch(cdp, "touchEnd", []);
  const after = await position(page);
  expect(before.z - after.z).toBeGreaterThan(0.8);
  await page.waitForTimeout(500);
  const rest = await position(page);
  await page.waitForTimeout(400);
  expect(Math.abs((await position(page)).z - rest.z)).toBeLessThan(0.05);

  // Le regard : un doigt qui glisse à droite de l'écran le fait tourner.
  const yaw0 = await yaw(page);
  await touch(cdp, "touchStart", [{ x: 600, y: 200, id: 2 }]);
  await touch(cdp, "touchMove", [{ x: 520, y: 200, id: 2 }]);
  await touch(cdp, "touchMove", [{ x: 440, y: 200, id: 2 }]);
  await touch(cdp, "touchEnd", []);
  expect(Math.abs((await yaw(page)) - yaw0)).toBeGreaterThan(0.5);

  // Près du canapé, le bouton « S'asseoir » ; assis, deux doigts qui s'écartent rapprochent l'image.
  await place(page, -1.9, -1.5, -Math.PI / 2);
  const sit = page.getByTestId("touch-sit");
  await expect(sit).toBeVisible();
  await sit.tap();
  await expect.poll(() => state(page, "seated")).toBe(true);
  // Un doigt de chaque côté de l'écran, comme on le fait naturellement : assis, il n'y a pas de manche — le
  // doigt de gauche ne fait pas se lever, les deux cadrent.
  await touch(cdp, "touchStart", [{ x: 300, y: 200, id: 3 }]);
  await touch(cdp, "touchStart", [
    { x: 300, y: 200, id: 3 },
    { x: 540, y: 200, id: 4 },
  ]);
  for (const spread of [40, 80, 120, 160])
    await touch(cdp, "touchMove", [
      { x: 300 - spread, y: 200, id: 3 },
      { x: 540 + spread, y: 200, id: 4 },
    ]);
  await touch(cdp, "touchEnd", []);
  expect(await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.view.zoom)).toBeGreaterThan(0.5);
  expect(await state(page, "seated")).toBe(true);
  await sit.tap();
  await expect.poll(() => state(page, "seated")).toBe(false);

  // Devant la télévision, le bouton d'action ouvre Laterna — à plat, sur tout l'écran ; on le referme d'un toucher.
  await place(page, 1.6, -1.5, -Math.PI / 2);
  const act = page.getByTestId("touch-act");
  await expect(act).toBeVisible();
  await act.tap();
  await expect.poll(() => state(page, "mode")).toBe("panel");
  const panel = page.getByTestId("panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBeGreaterThan(830);
  expect(box!.height).toBeGreaterThan(380);
  await page.getByTestId("panel-close").tap();
  await expect.poll(() => state(page, "mode")).toBe("walk");

  // Le menu, et le retour à la visite.
  await page.getByTestId("touch-menu").tap();
  await expect.poll(() => state(page, "mode")).toBe("paused");
  expect(errors).toEqual([]);
});
