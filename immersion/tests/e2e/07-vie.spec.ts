import { expect, test, type Page } from "@playwright/test";
import { enterWorld, position, state, watchErrors } from "../helpers";

type Handle = {
  rig: { position: { clone(): { set(x: number, y: number, z: number): void } }; teleport: unknown; yaw: number; pitch: number };
  emit(intent: string): void;
  playTestClip(url: string): Promise<void>;
  dispatch(command: { type: "stop" }): void;
  musicLevels(): { id: string; reach: number; master: number; playing: boolean }[];
};

/** Pose le visiteur, les yeux tournés vers un point : c'est ce que demande une chose pour répondre. */
async function lookAt(page: Page, from: [number, number, number], target: [number, number, number]) {
  await page.evaluate(
    ([f, t]) => {
      const { rig } = (window as unknown as { __immersion: Handle }).__immersion;
      const feet = rig.position.clone();
      feet.set(f[0], f[1], f[2]);
      rig.teleport = feet;
      const dx = t[0] - f[0];
      const dy = t[1] - (f[1] + 1.64);
      const dz = t[2] - f[2];
      rig.yaw = Math.atan2(-dx, -dz);
      rig.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    },
    [from, target] as const
  );
  await page.waitForTimeout(700);
}
const emit = (page: Page, intent: string) => page.evaluate((i) => (window as unknown as { __immersion: Handle }).__immersion.emit(i), intent);
const music = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.musicLevels());

/**
 * Ce qu'on peut faire dans le chalet : les lampes, le feu, la porte-fenêtre et la terrasse, le bain,
 * le lit, le chat, la chaîne hi-fi — par les mêmes intentions que le clavier.
 */
test("les lampes, le feu, la porte, la terrasse, le bain, le lit, le chat, la musique", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await enterWorld(page);

  // Un lampadaire du salon : le regarder de près, « agir », les lampes du salon s'éteignent — puis se rallument.
  const lamps = await page.evaluate(() => (window as unknown as { __immersion: { store: { getState(): { lamps: Record<string, boolean> } } } }).__immersion.store.getState().lamps);
  expect(lamps).toEqual({ salon: true, sud: true, nuit: true });
  const things = await page.evaluate(() => (window as unknown as { __immersion: { things: { id: string; at: [number, number, number] }[] } }).__immersion.things);
  const at = (id: string) => things.find((t) => t.id === id)!.at;
  const lamp = at("lamp-salon-0");
  await lookAt(page, [lamp[0] + 1.1, 0, lamp[2] + 0.3], lamp);
  expect(await state(page, "nearThing")).toBe("lamp-salon-0");
  await expect(page.getByTestId("hint-thing")).toBeVisible();
  await emit(page, "interact");
  expect((await state<Record<string, boolean>>(page, "lamps")).salon).toBe(false);
  await emit(page, "interact");
  expect((await state<Record<string, boolean>>(page, "lamps")).salon).toBe(true);

  // Le feu.
  const fire = at("fire");
  await lookAt(page, [fire[0] - 1.6, 0, fire[2]], fire);
  expect(await state(page, "nearThing")).toBe("fire");
  await emit(page, "interact");
  expect(await state(page, "fire")).toBe(false);
  await emit(page, "interact");
  expect(await state(page, "fire")).toBe(true);

  // Le chat.
  const cat = at("cat");
  await lookAt(page, [cat[0] - 0.9, 0, cat[2] + 0.5], cat);
  expect(await state(page, "nearThing")).toBe("cat");
  await emit(page, "interact");
  expect(await state<number>(page, "petAt")).toBeGreaterThan(0);

  // La porte-fenêtre : fermée, elle arrête ; ouverte, on sort sur la terrasse.
  const door = at("door");
  await lookAt(page, [door[0], 0, door[2] + 1.3], door);
  expect(await state(page, "nearThing")).toBe("door");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(1500);
  await page.keyboard.up("KeyW");
  expect((await position(page)).z).toBeGreaterThan(door[2]);
  await lookAt(page, [door[0], 0, door[2] + 1.3], door);
  await emit(page, "interact");
  expect(await state(page, "door")).toBe(true);
  await page.waitForTimeout(1200);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2600);
  await page.keyboard.up("KeyW");
  expect((await position(page)).z).toBeLessThan(door[2] - 0.8);
  expect(await state(page, "room")).toBe("terrasse");

  // Le bain : on s'y installe, on en sort.
  const seats = await page.evaluate(() => (window as unknown as { __immersion: { seats: Record<string, { stand: [number, number, number] }> } }).__immersion.seats);
  await lookAt(page, seats.tub.stand, [seats.tub.stand[0], 1, seats.tub.stand[2] - 2]);
  expect(await state(page, "nearSeat")).toBe("tub");
  await emit(page, "sit");
  expect(await state(page, "seated")).toBe(true);
  expect(await state(page, "seatSpot")).toBe("tub");
  await emit(page, "sit");
  expect(await state(page, "seated")).toBe(false);

  // Le lit de la chambre.
  await lookAt(page, seats.bed.stand, [seats.bed.stand[0] + 2, 1, seats.bed.stand[2] - 1]);
  expect(await state(page, "room")).toBe("chambre");
  expect(await state(page, "nearSeat")).toBe("bed");
  await emit(page, "sit");
  expect(await state(page, "seatSpot")).toBe("bed");
  await emit(page, "sit");

  // La chaîne hi-fi : la platine de la chambre lance la musique, qui sort des enceintes ; un film la fait
  // taire, son arrêt la rend.
  const deck = at("hifi-chambre");
  await lookAt(page, [deck[0] - 1.2, 0, deck[2] + 0.2], deck);
  expect(await state(page, "nearThing")).toBe("hifi-chambre");
  await emit(page, "interact");
  expect(await state(page, "music")).toBe(true);
  await expect.poll(async () => (await music(page))[0]?.master ?? 0, { timeout: 15_000 }).toBeGreaterThan(0.3);
  const levels = await music(page);
  expect(levels.map((l) => l.id).sort()).toEqual(["chambre", "cuisine", "mezzanine", "salon"]);
  expect(levels.every((l) => l.playing)).toBe(true);
  // De la chambre : son enceinte à plein, celle du salon hors de portée.
  expect(levels.find((l) => l.id === "chambre")!.reach).toBeGreaterThan(0.9);
  expect(levels.find((l) => l.id === "salon")!.reach).toBeLessThan(0.05);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.playTestClip("/api/immersion/mire.webm"));
  await expect.poll(async () => (await music(page))[0].master, { timeout: 15_000 }).toBeLessThan(0.02);
  await expect.poll(async () => (await music(page))[0].playing, { timeout: 10_000 }).toBe(false);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  await expect.poll(async () => (await music(page))[0].master, { timeout: 15_000 }).toBeGreaterThan(0.3);
  expect(errors).toEqual([]);
});
