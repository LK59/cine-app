import { expect, test } from "@playwright/test";
import { enterWorld, place, position, state, watchErrors } from "../helpers";

test.describe("le monde", () => {
  test("on entre, on marche, les murs arrêtent, Échap ouvre le menu, on quitte", async ({ page }) => {
    const errors = watchErrors(page);
    await enterWorld(page);
    expect(await state(page, "mode")).toBe("walk");

    // Avancer : le visiteur se déplace vers le nord (son regard de départ).
    const start = await position(page);
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(1200);
    await page.keyboard.up("KeyW");
    const walked = await position(page);
    expect(Math.hypot(walked.x - start.x, walked.z - start.z)).toBeGreaterThan(0.8);
    expect(Math.abs(walked.y - start.y)).toBeLessThan(0.05);

    // Foncer dans le mur ouest : on s'arrête contre lui, sans le traverser.
    await place(page, -4.5, 2, Math.PI / 2);
    await page.keyboard.down("ShiftLeft");
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(1500);
    await page.keyboard.up("KeyW");
    await page.keyboard.up("ShiftLeft");
    const stopped = await position(page);
    expect(stopped.x).toBeGreaterThan(-5.5);
    expect(stopped.x).toBeLessThan(-4.9);

    // Le menu pause (l'intention « menu », ce que vaut Échap), puis la sortie vers le cinéma.
    await page.evaluate(() => (window as unknown as { __immersion: { emit(intent: string): void } }).__immersion.emit("menu"));
    await expect(page.getByTestId("pause")).toBeVisible();
    await page.getByTestId("quit").click();
    // La page part vers le cinéma (`/`). Le serveur d'aperçu, lui, renvoie sa racine vers la page du mode.
    await page.waitForURL((url) => url.pathname === "/" || url.pathname === "/api/immersion/");
    expect(errors).toEqual([]);
  });
});
