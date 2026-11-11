import { expect, test } from "@playwright/test";
import { enterWorld, readPng, watchErrors } from "../helpers";

type Handle = {
  store: { getState(): { setSeated(seated: boolean, spot?: string): void } };
  rig: { position: { clone(): { set(x: number, y: number, z: number): void } }; teleport: unknown; yaw: number; pitch: number };
  view: { zoom: number };
  playTestClip(source: MediaStream): Promise<void>;
};

/**
 * Le film est montré avec ses couleurs. Quatre aplats de valeur connue passent sur l'écran du salon ; vus du
 * canapé, l'image cadrée plein écran, ils doivent ressortir tels quels. L'image avait été convertie une
 * seconde fois vers l'espace de l'écran : un gris de 128 sortait à 187, un noir de 40 à 110 — des films délavés.
 */
test("les couleurs de la vidéo sont celles du film", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const patches: [number, number, number][] = [
    [128, 128, 128],
    [200, 120, 90],
    [40, 40, 40],
    [60, 90, 200],
  ];
  await enterWorld(page);
  await page.evaluate(async (colors) => {
    const h = (window as unknown as { __immersion: Handle }).__immersion;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const c = canvas.getContext("2d")!;
    const paint = () =>
      colors.forEach(([r, g, b], i) => {
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.fillRect(i * 320, 0, 320, 720);
      });
    paint();
    setInterval(paint, 100);
    await h.playTestClip(canvas.captureStream(15));
    const feet = h.rig.position.clone();
    feet.set(-1.08, 0, -1.5);
    h.rig.teleport = feet;
    h.rig.yaw = -Math.PI / 2;
    h.rig.pitch = 0.11;
    h.store.getState().setSeated(true, "sofa");
    h.view.zoom = 1;
  }, patches);
  await page.waitForTimeout(6000);
  await page.addStyleTag({ content: ".reticle,.hints,.hud{display:none!important}" });
  const shot = readPng(await page.screenshot({ type: "png" }));
  const y = Math.round(shot.height * 0.49);
  for (const [i, expected] of patches.entries()) {
    const seen = shot.at(Math.round(shot.width * (0.19 + 0.21 * i)), y);
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(seen[channel] - expected[channel]), `aplat ${i + 1}, canal ${channel} : vu ${seen}, attendu ${expected}`).toBeLessThanOrEqual(8);
  }
  expect(errors).toEqual([]);
});
