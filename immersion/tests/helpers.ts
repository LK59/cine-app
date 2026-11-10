import { expect, type ConsoleMessage, type Page } from "@playwright/test";

/** Les erreurs de console et de page d'un scénario — aucune n'est tolérée. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Le rendu logiciel de Chromium sans écran signale ses propres lenteurs : ce n'est pas la page.
    if (/GPU stall due to ReadPixels|Automatic fallback to software WebGL/i.test(text)) return;
    errors.push(text);
  };
  page.on("console", onConsole);
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

type Immersion = {
  store: { getState(): Record<string, unknown> & { setMode(mode: string): void; setSeated(seated: boolean): void } };
  rig: { position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void; clone(): unknown }; yaw: number; pitch: number; teleport: unknown };
};

/** L'état du mode, lu dans la page. */
export async function state<T = unknown>(page: Page, key: string): Promise<T> {
  return page.evaluate((k) => (window as unknown as { __immersion: Immersion }).__immersion.store.getState()[k] as never, key);
}

/** Ouvre la page, attend la fin du chargement, entre dans le monde. */
export async function enterWorld(page: Page): Promise<void> {
  await page.goto("/immersion");
  const enter = page.getByTestId("enter");
  // Large : sur une machine occupée, le chargement (textures, programmes) peut dépasser la minute.
  await expect(enter).toBeVisible({ timeout: 240_000 });
  await enter.click();
  await expect.poll(() => state(page, "phase"), { timeout: 15_000 }).toBe("world");
  // Sans écran, le verrou du pointeur peut être refusé : le monde s'ouvre alors en pause.
  await page.evaluate(() => {
    const handle = (window as unknown as { __immersion: Immersion & { debug: { skipCaptureCheck: boolean } } }).__immersion;
    handle.debug.skipCaptureCheck = true;
    handle.store.getState().setMode("walk");
  });
}

/** Pose le visiteur à un endroit, le regard dans une direction. */
export async function place(page: Page, x: number, z: number, yaw: number, pitch = 0, y = 0): Promise<void> {
  await page.evaluate(
    ([px, py, pz, pyaw, ppitch]) => {
      const { rig } = (window as unknown as { __immersion: Immersion }).__immersion;
      const target = rig.position.clone() as { set(x: number, y: number, z: number): void };
      target.set(px, py, pz);
      rig.teleport = target;
      rig.yaw = pyaw;
      rig.pitch = ppitch;
    },
    [x, y, z, yaw, pitch]
  );
  await page.waitForTimeout(400);
}

export async function position(page: Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => {
    const p = (window as unknown as { __immersion: Immersion }).__immersion.rig.position;
    return { x: p.x, y: p.y, z: p.z };
  });
}
