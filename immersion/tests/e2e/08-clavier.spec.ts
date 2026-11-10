import { expect, test, type Page } from "@playwright/test";
import { enterWorld, place, position, state, watchErrors } from "../helpers";

/** Une touche telle qu'un clavier donné l'envoie : sa position (`code`) et la lettre gravée dessus (`key`). */
const key = (page: Page, type: "keydown" | "keyup", code: string, letter: string) =>
  page.evaluate(([t, c, k]) => void window.dispatchEvent(new KeyboardEvent(t, { code: c, key: k, bubbles: true })), [type, code, letter] as const);

async function walked(page: Page, code: string, letter: string): Promise<number> {
  // Toujours du même endroit dégagé (derrière le canapé, face à la baie) : un meuble n'est pas une touche morte.
  await place(page, -3.7, 3.0, 0);
  const before = await position(page);
  await key(page, "keydown", code, letter);
  await page.waitForTimeout(900);
  await key(page, "keyup", code, letter);
  await page.waitForTimeout(250);
  const after = await position(page);
  return Math.hypot(after.x - before.x, after.z - before.z);
}

const muted = (page: Page) => state<{ muted: boolean }>(page, "playback").then((p) => p.muted);
const setKeyboard = (page: Page, keyboard: string) =>
  page.evaluate((k) => (window as unknown as { __immersion: { store: { getState(): { updateSettings(patch: { keyboard: string }): void } } } }).__immersion.store.getState().updateSettings({ keyboard: k }), keyboard);

/**
 * Les trois dispositions : en automatique on se déplace par la position des touches (la croix de gauche),
 * les initiales E / F / M suivent leur lettre, et la disposition est reconnue à la première touche.
 */
test("AZERTY, QWERTY, QWERTZ : déplacement par position, initiales par lettre, disposition forcée", async ({ page }) => {
  const errors = watchErrors(page);
  await enterWorld(page);

  // Un clavier AZERTY : la touche du haut de la croix (position W) porte « Z ». On avance, et le libellé suit.
  expect(await walked(page, "KeyW", "z")).toBeGreaterThan(0.6);
  expect(await state(page, "keysSeen")).toBe("ZQSD");
  // Sur ce clavier, la touche « M » est à la place du point-virgule américain : c'est elle qui coupe le son —
  // et pas la virgule, qui est à la place du M américain.
  expect(await muted(page)).toBe(false);
  await key(page, "keydown", "Semicolon", "m");
  expect(await muted(page)).toBe(true);
  await key(page, "keydown", "KeyM", ",");
  expect(await muted(page)).toBe(true);
  await key(page, "keydown", "Semicolon", "m");
  expect(await muted(page)).toBe(false);

  // Un clavier QWERTY ou QWERTZ : la même touche porte « W ». Le libellé se corrige.
  expect(await walked(page, "KeyW", "w")).toBeGreaterThan(0.6);
  expect(await state(page, "keysSeen")).toBe("WASD");

  // Disposition forcée « AZERTY » : c'est la lettre qui compte. « Z » avance où qu'elle soit ; « W » ne fait rien.
  await setKeyboard(page, "azerty");
  expect(await walked(page, "KeyY", "z")).toBeGreaterThan(0.6);
  expect(await walked(page, "KeyW", "w")).toBeLessThan(0.05);
  // Disposition forcée « QWERTZ » : W avance, Z (qui est à la place du Y) ne fait rien.
  await setKeyboard(page, "qwertz");
  expect(await walked(page, "KeyW", "w")).toBeGreaterThan(0.6);
  expect(await walked(page, "KeyY", "z")).toBeLessThan(0.05);
  await setKeyboard(page, "auto");
  expect(errors).toEqual([]);
});
