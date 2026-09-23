import { describe, it, expect } from "vitest";
import { frameFit, TOUCH_MARGIN, type PictureFrame } from "@/lib/frameFit";

const frame = (over: Partial<PictureFrame>): PictureFrame => ({ left: 0, top: 0, right: 1, bottom: 1, aspect: 16 / 9, samples: 100, ...over });
/** Un iPhone en paysage : plus large que 16:9. */
const PHONE = { width: 844, height: 390 };

/** La taille de l'image une fois agrandie : elle doit tenir dans l'écran, sinon on en coupe. */
function shown(f: PictureFrame, screen: { width: number; height: number }) {
  const fit = frameFit(f, screen)!;
  const w = Math.min(screen.width, screen.height * f.aspect);
  const h = w / f.aspect;
  return { width: w * (f.right - f.left) * fit.scale, height: h * (f.bottom - f.top) * fit.scale, fit };
}

describe("frameFit", () => {
  // The Kissing Booth sur iPhone : un cadre 16:9 avec 2,20:1 d'image dedans.
  it("brings a letterboxed picture to the nearest edge of the screen", () => {
    const f = frame({ top: 0.0889, bottom: 0.9167 });
    const { width, height, fit } = shown(f, PHONE);
    expect(fit.scale).toBeGreaterThan(1.2);
    expect(height).toBeCloseTo(PHONE.height, 0);
    expect(width).toBeLessThanOrEqual(PHONE.width + 0.01);
  });

  it("never cuts the picture, whatever the screen", () => {
    const f = frame({ top: 0.12, bottom: 0.88, left: 0.05, right: 0.95 });
    for (const screen of [PHONE, { width: 390, height: 844 }, { width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 3440, height: 1440 }]) {
      const fit = frameFit(f, screen);
      if (!fit) continue;
      const { width, height } = shown(f, screen);
      expect(width).toBeLessThanOrEqual(screen.width + 0.01);
      expect(height).toBeLessThanOrEqual(screen.height + 0.01);
    }
  });

  // Un 4:3 dans un cadre 16:9 sur un écran 16:9 : ses bandes latérales sont déjà la bonne réponse.
  it("leaves alone a picture that already touches an edge", () => {
    expect(frameFit(frame({ left: 0.125, right: 0.875 }), { width: 1920, height: 1080 })).toBeNull();
  });

  it("leaves alone a file with no bars", () => {
    expect(frameFit(frame({}), PHONE)).toBeNull();
  });

  // Des bandes inégales : c'est le centre de l'image qui va au milieu de l'écran.
  it("centres the picture, not the frame", () => {
    const fit = frameFit(frame({ top: 0.05, bottom: 0.85 }), PHONE)!;
    expect(fit.y).toBeGreaterThan(0);
    expect(fit.x).toBeCloseTo(0, 5);
  });

  it("says nothing before the screen has a size", () => {
    expect(frameFit(frame({ top: 0.1, bottom: 0.9 }), { width: 0, height: 0 })).toBeNull();
  });

  // Les coins arrondis d'un téléphone : l'image s'arrête un peu avant le bord (24/09/2026).
  it("leaves a margin on a touch screen, and only asked for", () => {
    const f = frame({ top: 0.0889, bottom: 0.9167 });
    const exact = frameFit(f, PHONE)!;
    const touch = frameFit(f, PHONE, TOUCH_MARGIN)!;
    expect(touch.scale).toBeCloseTo(exact.scale * (1 - TOUCH_MARGIN), 5);
    const h = PHONE.height * (f.bottom - f.top) * touch.scale;
    expect(h).toBeCloseTo(PHONE.height * (1 - TOUCH_MARGIN), 0);
  });
});
