import { describe, expect, it } from "vitest";
import {
  appleCloseMotion,
  cardRiseTrack,
  closePoses,
  closeResponse,
  closeStartVelocity,
  fingerCarry,
  morphTracks,
  sampleMotion,
  shiftPose,
  sourcePose,
  uniformCorners,
  IDENTITY,
  type Box,
  type Pose,
} from "@/lib/sheetMorph/motion";

// La fermeture au doigt, lâchée vite (Louis, iPhone, 10/10/2026 : « un mini décrochement de l'image
// bannière par rapport à la fiche dans une redescente rapide »). L'image vole vers son affiche, la
// carte redescend sous l'écran : leurs chemins divergent par construction — mais à l'instant du
// lâcher, toutes deux doivent quitter le doigt *ensemble*, à sa vitesse.

const stage = { W: 390, H: 844 };
// La bannière 16:9 tirée de 120 px vers le bas ; l'affiche d'origine, plus haut dans une rangée.
const banner: Box = { x: 0, y: 120, w: 390, h: 219 };
const poster: Box = { x: 16, y: 40, w: 112, h: 168 };
const cur: Pose = { box: banner, corners: [16, 16, 0, 0], bd: IDENTITY, poster: IDENTITY, bdOpacity: 1, posterOpacity: 0 };
const to = sourcePose(poster, uniformCorners(8), banner);
const shellFrom = 120;
const shellTo = 120 + 600;
const FINGER = 3000; // px/s vers le bas : un geste rapide

/** Le haut de l'image et celui de la carte, image clé par image clé. */
function tracks(withCarry: boolean) {
  const carry = withCarry ? fingerCarry(FINGER, closeResponse(banner, poster, stage, "phone")) : undefined;
  const v0 = carry ? 0 : closeStartVelocity(banner, poster, null, FINGER);
  const motion = appleCloseMotion(banner, poster, stage, "phone", v0);
  const samples = sampleMotion(motion, carry);
  const poseAt = closePoses(cur, to);
  const image = samples.map(({ q, dy }) => shiftPose(poseAt(q), dy ?? 0).box.y);
  const card = cardRiseTrack(samples, shellFrom, shellTo).map((k) => Number(/translateY\((-?[\d.]+)px\)/.exec(String(k.transform))![1]));
  return { motion, samples, image, card };
}

describe("fermeture au doigt — l'élan porté (`fingerCarry`)", () => {
  it("part exactement à la vitesse du doigt, et s'éteint à l'arrivée", () => {
    const carry = fingerCarry(FINGER, 0.2)!;
    expect(carry(0)).toBe(0);
    // Vitesse au départ : la pente sur le premier dixième de milliseconde.
    expect(Math.abs(carry(0.1) / 0.0001 - FINGER)).toBeLessThan(FINGER * 0.005);
    const motion = appleCloseMotion(banner, poster, stage, "phone", 0);
    const samples = sampleMotion(motion, carry);
    expect(samples[samples.length - 1].dy).toBe(0);
    expect(Math.abs(samples[samples.length - 2].dy ?? 0)).toBeLessThan(1);
  });

  it("l'image et la carte quittent le doigt ensemble, vers le bas, à sa vitesse", () => {
    // Leurs chemins divergent ensuite par construction (l'image regagne son affiche, la carte sort de
    // l'écran) ; ce qui se voyait, c'était le départ.
    const { motion, samples, image, card } = tracks(true);
    // Les images des 25 premières millisecondes (trois à 120 Hz).
    const early = samples.filter((s) => s.offset * motion.duration <= 25);
    expect(early.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < early.length; i++) {
      expect(image[i] - image[0]).toBeGreaterThan(0);
      expect(card[i] - card[0]).toBeGreaterThan(0);
    }
    // La vitesse de départ de l'une et de l'autre, à la première image : celle du doigt, à 25 % près
    // (le retour, parti à vitesse nulle, n'y ajoute que son accélération).
    const dt = (samples[1].offset * motion.duration) / 1000;
    const imageV = (image[1] - image[0]) / dt;
    const cardV = (card[1] - card[0]) / dt;
    expect(imageV).toBeGreaterThan(FINGER * 0.5);
    expect(cardV).toBeGreaterThan(FINGER * 0.75);
    // Et jamais la carte ne remonte sous le doigt qui l'a jetée.
    for (let i = 1; i < card.length; i++) expect(card[i]).toBeGreaterThanOrEqual(card[i - 1] - 0.01);
  });

  it("l'ancienne projection sur le seul chemin de l'image jetait la carte vers le haut au lâcher", () => {
    // Le témoin du défaut : sans élan porté, l'affiche au-dessus de la bannière, la carte remontait de
    // plusieurs dizaines de pixels dès la première image pendant que l'image descendait.
    const { image, card } = tracks(false);
    expect(card[1] - card[0]).toBeLessThan(-10);
    expect(image[1] - image[0]).toBeGreaterThan(0);
  });

  it("à l'instant du relais, l'image est dans la carte, à la place où le doigt l'a laissée", () => {
    const { image, card } = tracks(true);
    expect(image[0]).toBe(banner.y);
    expect(card[0]).toBe(shellFrom);
  });

  it("les pistes de la fenêtre portent l'élan : la fenêtre descend avec la carte au départ", () => {
    const carry = fingerCarry(FINGER, closeResponse(banner, poster, stage, "phone"));
    const motion = appleCloseMotion(banner, poster, stage, "phone", 0);
    const samples = sampleMotion(motion, carry);
    const win = morphTracks(closePoses(cur, to), samples, banner, stage).win;
    const ty = (k: Keyframe) => Number(/translate\(-?[\d.]+px, (-?[\d.]+)px\)/.exec(String(k.transform))![1]);
    expect(ty(win[0])).toBeCloseTo(0, 5);
    expect(ty(win[1])).toBeGreaterThan(0);
  });

  it("sans élan (fermeture à la croix), rien ne change", () => {
    expect(fingerCarry(0, 0.2)).toBeUndefined();
    const motion = appleCloseMotion(banner, poster, stage, "phone", 0);
    expect(sampleMotion(motion).every((s) => s.dy === undefined)).toBe(true);
  });
});
