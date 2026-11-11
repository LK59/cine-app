import { inflateSync } from "node:zlib";
import { expect, type ConsoleMessage, type Page } from "@playwright/test";

/** Les erreurs de console et de page d'un scénario — aucune n'est tolérée. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Le rendu logiciel de Chromium sans écran signale ses propres lenteurs : ce n'est pas la page.
    if (/GPU stall due to ReadPixels|Automatic fallback to software WebGL/i.test(text)) return;
    // Sans application derrière l'aperçu (SANS_APPLICATION), ses routes répondent 502 : attendu, et seulement là.
    if (process.env.SANS_APPLICATION && /status of 502/.test(text)) return;
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
  await expect.poll(() => state(page, "phase"), { timeout: 90_000 }).toBe("world");
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

/**
 * Lit un PNG (8 bits, RVB ou RVBA, non entrelacé — ce que rend `page.screenshot`) : de quoi vérifier une
 * couleur à l'écran sans dépendance de plus.
 */
export function readPng(png: Buffer): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      pixels[y * stride + x] = (value + predicted) & 255;
    }
  }
  return { width, height, at: (x, y) => [pixels[y * stride + x * channels], pixels[y * stride + x * channels + 1], pixels[y * stride + x * channels + 2]] };
}
