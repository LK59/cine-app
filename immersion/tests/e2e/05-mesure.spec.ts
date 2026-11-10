import { expect, test } from "@playwright/test";
import { enterWorld, state, watchErrors } from "../helpers";

/**
 * « Mesurer » : chaque préréglage est joué écrans éteints puis avec la mire, un résultat par passage
 * s'affiche, et chacun part au journal (`kind: "immersion-bench"`). Les passages sont raccourcis :
 * c'est le déroulé qui est vérifié ici, pas les chiffres.
 */
test("la mesure parcourt les préréglages, affiche ses résultats et les envoie", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/viewport-diag")) return;
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.kind === "immersion-bench") sent.push(body);
  });
  await enterWorld(page);
  await page.evaluate(() => {
    const handle = (window as unknown as { __immersion: { benchTiming: { seconds: number; settleMs: number }; emit(intent: string): void } }).__immersion;
    handle.benchTiming.seconds = 1.2;
    handle.benchTiming.settleMs = 500;
    handle.emit("menu");
  });
  await page.getByTestId("open-settings").click();
  const before = await state<{ quality: string }>(page, "settings");
  await page.getByTestId("bench-run").click();
  await expect(page.getByTestId("bench-overlay")).toBeVisible();
  // Pendant la mesure, le menu s'efface ; à la fin il revient, avec le tableau.
  await expect(page.getByTestId("pause")).toBeHidden();
  await expect(page.getByTestId("bench-results")).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(8);
  expect(sent.map((line) => `${line.preset}/${line.video}`)).toEqual(["ultra/false", "high/false", "medium/false", "low/false", "ultra/true", "high/true", "medium/true", "low/true"]);
  for (const line of sent) {
    expect(line.fps as number).toBeGreaterThan(0);
    expect(line.low1 as number).toBeGreaterThan(0);
    expect(line.low1 as number).toBeLessThanOrEqual((line.fps as number) + 0.01);
    expect(line.width as number).toBeGreaterThan(0);
    expect(typeof line.renderer).toBe("string");
  }
  // La mire a bien joué pendant les passages « avec vidéo », et les écrans sont éteints après.
  expect(sent[4].videoSource).toBe("mire");
  expect(sent[4].videoHeight).toBe(1080);
  expect((await state<{ status: string }>(page, "playback")).status).toBe("idle");
  // Les réglages gardés n'ont pas bougé : la mesure ne fait qu'emprunter les préréglages.
  expect((await state<{ quality: string }>(page, "settings")).quality).toBe(before.quality);
  expect(errors).toEqual([]);
});
