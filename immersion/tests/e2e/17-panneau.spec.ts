import { expect, test, type Page } from "@playwright/test";
import { enterWorld, place, state, watchErrors } from "../helpers";

type Screen = { id: string; center: [number, number, number] };
type Handle = {
  screens: Record<string, Screen>;
  openPanel(id: string): void;
  closePanel(): void;
  store: { getState(): { setMode(mode: string): void } };
};

const SCREENS = ["salon", "cuisine", "chambre"] as const;
/** Devant le centre de l'écran (mètres) : 0,5 et 0,8 m sont les cas où le panneau ne pouvait plus reculer. */
const DISTANCES = [0.5, 0.8, 1.2, 2];
/** Décalage latéral, le long de l'écran. */
const OFFSETS = [-2.4, -1.4, -0.6, 0, 0.6, 1.4, 2.4];

/** Où est le bouton « Fermer », et ce que le navigateur trouve sous son centre. */
async function closeButton(page: Page) {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="panel-close"]');
    const panel = document.querySelector<HTMLElement>('[data-testid="panel"]');
    if (!button || !panel) return null;
    const box = button.getBoundingClientRect();
    const whole = panel.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      panel: { left: whole.left, top: whole.top, right: whole.right, bottom: whole.bottom },
      center: [Math.round(cx), Math.round(cy)],
      clickable: hit !== null && (hit === button || button.contains(hit)),
      window: [innerWidth, innerHeight],
    };
  });
}

/** Le panneau ouvert devant un écran, le visiteur posé à cette distance et ce décalage. */
async function openAt(page: Page, id: string, distance: number, offset: number): Promise<void> {
  await page.evaluate(() => {
    const handle = (window as unknown as { __immersion: Handle }).__immersion;
    handle.closePanel();
    handle.store.getState().setMode("walk");
  });
  const center = await page.evaluate((screen) => (window as unknown as { __immersion: Handle }).__immersion.screens[screen].center, id);
  // Les trois écrans regardent vers −x : le visiteur se tient de ce côté, le regard sur l'écran (yaw = −π/2).
  await place(page, center[0] - distance, center[2] + offset, -Math.PI / 2);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().setMode("walk"));
  await page.evaluate((screen) => (window as unknown as { __immersion: Handle }).__immersion.openPanel(screen), id);
  await expect.poll(() => state(page, "mode")).toBe("panel");
  // Le regard glisse vers le panneau (`rig.aim`) : le laisser arriver. ~700 ms d'ordinaire ; sur une machine chargée
  // (rendu lent juste après un changement de pièce), un peu plus — mesuré avant la fin du glissement, le panneau est
  // encore de biais et sort du champ quelle que soit sa taille.
  await page.waitForTimeout(700);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { rig } = (window as unknown as { __immersion: { rig: { yaw: number; pitch: number; aim: { yaw: number; pitch: number } | null } } }).__immersion;
        if (!rig.aim) return 0;
        return Math.abs(Math.atan2(Math.sin(rig.aim.yaw - rig.yaw), Math.cos(rig.aim.yaw - rig.yaw))) + Math.abs(rig.aim.pitch - rig.pitch);
      })
    )
    .toBeLessThan(0.01);
}

/**
 * Le panneau tient toujours dans le champ (`panelScale`). Ouvert à moins d'environ 1,2 m d'un écran, il ne pouvait
 * plus reculer et débordait : sur cette grille, 39 cas sur 84 laissaient le bouton « Fermer » hors de la fenêtre
 * (centre vers 1620, −35 en 1600 × 900), et un visiteur s'est cru bloqué. Le bouton doit être dans la fenêtre et
 * réellement cliquable (rien par-dessus), et le rappel « Échap pour fermer » à l'écran.
 */
test("le bouton « Fermer » du panneau reste dans la fenêtre et cliquable, près des murs aussi", async ({ page }) => {
  test.setTimeout(600_000);
  const errors = watchErrors(page);
  await page.route(/\/api\/(?!immersion\/)/, (route) => route.fulfill({ status: 502, body: "" }));
  await enterWorld(page);

  const failures: string[] = [];
  for (const id of SCREENS) {
    for (const distance of DISTANCES) {
      for (const offset of OFFSETS) {
        await openAt(page, id, distance, offset);
        const found = await closeButton(page);
        const where = `${id} d=${distance} z${offset >= 0 ? "+" : ""}${offset}`;
        if (!found) {
          failures.push(`${where} : pas de bouton`);
          continue;
        }
        const [w, h] = found.window;
        const inside = found.box.left >= 0 && found.box.top >= 0 && found.box.right <= w && found.box.bottom <= h;
        const panelInside = found.panel.left >= -1 && found.panel.top >= -1 && found.panel.right <= w + 1 && found.panel.bottom <= h + 1;
        if (!inside || !found.clickable || !panelInside) failures.push(`${where} : bouton ${found.center.join(",")}${inside ? "" : " hors fenêtre"}${found.clickable ? "" : " recouvert"}${panelInside ? "" : " panneau débordant"}`);
      }
    }
  }
  expect(failures).toEqual([]);

  // Le rappel, hors du panneau, pendant qu'il est ouvert ; et le bouton ferme vraiment.
  await expect(page.getByTestId("panel-escape")).toBeVisible();
  await expect(page.getByTestId("panel-escape")).toContainText(/Échap|Esc/); // la langue du navigateur de test
  await page.getByTestId("panel-close").click();
  await expect.poll(() => state(page, "mode")).not.toBe("panel");
  await expect(page.getByTestId("panel-escape")).toBeHidden();

  // Une fenêtre étroite (le moins que le mode accepte) : c'est la largeur qui manque, le panneau se réduit aussi.
  await page.setViewportSize({ width: 900, height: 900 });
  await openAt(page, "salon", 0.5, 0);
  const narrow = await closeButton(page);
  expect(narrow).not.toBeNull();
  expect(narrow!.clickable).toBe(true);
  expect(narrow!.box.right).toBeLessThanOrEqual(900);
  expect(narrow!.panel.left).toBeGreaterThanOrEqual(-1);
  // Échap ferme toujours (l'intention « retour »).
  await page.evaluate(() => (window as unknown as { __immersion: { emit(intent: string): void } }).__immersion.emit("back"));
  await expect.poll(() => state(page, "mode")).not.toBe("panel");
  expect(errors).toEqual([]);
});
