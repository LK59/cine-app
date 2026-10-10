import { describe, it, expect } from "vitest";
import {
  GLASS_IN,
  REVEAL_AT,
  appleCloseMotion,
  appleOpenMotion,
  appleResponse,
  cardOpenPoses,
  cardRestPose,
  closeResponse,
  closePoses,
  closeStartVelocity,
  coverTf,
  criticalSpring,
  morphTracks,
  openPoses,
  sampleMotion,
  settledPose,
  sourcePose,
  timeAt,
  uniformCorners,
  type Box,
} from "@/lib/sheetMorph/motion";

/**
 * Le mouvement des fiches (DECISIONS.md §61), sans DOM : ce que la maquette du banc a réglé et que
 * les vraies fiches jouent. Chaque règle ici a coûté une passe sur l'iPhone.
 */
const stage = { W: 390, H: 844 };
const poster: Box = { x: 20, y: 500, w: 110, h: 165 };
const banner: Box = { x: 0, y: 40, w: 390, h: 220 };

describe("le ressort", () => {
  it("amorti critique : jamais au-delà de l'arrivée, l'essentiel du trajet tôt, posé à la fin", () => {
    const m = criticalSpring(0.3, 0, 600);
    let max = 0;
    for (let t = 0; t <= m.duration; t += 4) max = Math.max(max, m.q(t));
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(m.q(m.duration * 0.4)).toBeGreaterThan(0.85);
    expect(m.q(m.duration)).toBe(1);
  });

  it("la réponse suit la distance rapportée à l'écran, plus vive au bureau, la fermeture plus vive encore", () => {
    const far: Box = { x: 0, y: 0, w: 390, h: 844 };
    const near = appleResponse(banner, { ...banner, y: 60 }, stage, "phone");
    const long = appleResponse(poster, far, stage, "phone");
    expect(near).toBeLessThan(long);
    expect(appleResponse(poster, far, stage, "desktop")).toBeCloseTo(long * 0.8, 6);
    const open = appleOpenMotion(poster, banner, stage, "phone");
    const close = appleCloseMotion(banner, poster, stage, "phone");
    expect(close.duration).toBeLessThan(open.duration);
    // Une affiche à mi-écran : un ressort qui se pose en un demi-seconde au plus (huitième passe).
    expect(open.duration).toBeLessThan(520);
  });

  it("au moins 60 images clés, la dernière à l'arrivée exacte", () => {
    const s = sampleMotion(criticalSpring(0.22, 0, 100));
    expect(s.length).toBeGreaterThanOrEqual(61);
    expect(s.at(-1)).toEqual({ offset: 1, q: 1 });
  });

  it("le contenu part à 90 % du trajet, bien après l'essentiel du mouvement", () => {
    const m = appleOpenMotion(poster, banner, stage, "phone");
    const s = sampleMotion(m);
    expect(timeAt(s, m.duration, REVEAL_AT)).toBeGreaterThan(timeAt(s, m.duration, 0.6));
  });
});

describe("les poses", () => {
  it("l'aller part de la carte (affiche pleine, visuel éteint) et finit sur la bannière (l'inverse)", () => {
    const { at } = openPoses(poster, uniformCorners(8), banner, [16, 16, 0, 0]);
    expect(at(0).box).toEqual(poster);
    expect(at(0).posterOpacity).toBe(1);
    expect(at(0).bdOpacity).toBe(0);
    expect(at(1).box).toEqual(banner);
    expect(at(1).posterOpacity).toBe(0);
    expect(at(1).bdOpacity).toBe(1);
    // Le visuel commence réduit exactement à la carte, l'affiche finit agrandie exactement à la bannière.
    expect(at(0).bd).toEqual(coverTf(banner, poster));
    expect(at(1).poster).toEqual(coverTf(poster, banner));
  });

  it("le retour fait se chevaucher les deux images sur presque tout le chemin, depuis où elles en sont", () => {
    const back = closePoses(settledPose(banner, [16, 16, 0, 0], poster), sourcePose(poster, uniformCorners(8), banner));
    expect(back(0.1).posterOpacity).toBe(0);
    expect(back(0.5).posterOpacity).toBeGreaterThan(0);
    expect(back(0.5).bdOpacity).toBeGreaterThan(0);
    expect(back(1).posterOpacity).toBe(1);
    expect(back(1).bdOpacity).toBe(0);
  });

  it("la vitesse de départ d'un retour : contre l'aller interrompu, ou le doigt projeté sur le chemin", () => {
    // Un aller interrompu allait vers la fiche : le retour part un instant dans l'autre sens.
    expect(closeStartVelocity(banner, poster, { v: 5, span: 600 }, 0)).toBeLessThan(0);
    // Un doigt qui lâche vers le bas, l'affiche plus bas que la bannière : le retour part lancé.
    expect(closeStartVelocity(banner, poster, null, 1500)).toBeGreaterThan(0);
    expect(closeStartVelocity(banner, poster, null, 0)).toBe(0);
  });
});

describe("les images clés", () => {
  it("ne demandent que des transformations, des opacités, et un rayon sur sa propre piste", () => {
    const { at } = openPoses(poster, uniformCorners(8), banner, [16, 16, 0, 0]);
    const tracks = morphTracks(at, sampleMotion(appleOpenMotion(poster, banner, stage, "phone")), banner, stage);
    for (const k of [...tracks.win, ...tracks.inner]) expect(Object.keys(k).sort()).toEqual(["offset", "transform"]);
    for (const k of [...tracks.bd, ...tracks.poster]) expect(Object.keys(k).sort()).toEqual(["offset", "opacity", "transform"]);
    for (const k of tracks.radius) expect(Object.keys(k).sort()).toEqual(["borderRadius", "offset"]);
    // La fenêtre, posée sur la bannière, en part réduite à la carte et finit sans transformation.
    expect(tracks.win.at(-1)!.transform).toBe("translate(0.00px, 0.00px) scale(1.00000, 1.00000)");
  });
});

describe("la carte du téléphone, une seule pièce (le modèle des cartes d'iOS)", () => {
  // Avant : la bannière volait seule au-dessus d'un fond de carte qui montait à part. Pour la loger
  // dans la carte, sa cible glissait avec elle et l'image plongeait vers le bas avant de remonter
  // (y 282 → 626 → 8, audit du 10/10/2026). La carte entière grandit maintenant depuis l'affiche.
  const card: Box = { x: 0, y: 24, w: 390, h: 820 };
  const cardBanner: Box = { x: 0, y: 24, w: 390, h: 219 };

  it("la fenêtre ne s'éloigne jamais de son arrivée : son haut va de l'affiche à la carte, sans plonger", () => {
    const { at } = cardOpenPoses(poster, uniformCorners(8), card, cardBanner, uniformCorners(16));
    const m = appleOpenMotion(poster, card, stage, "phone");
    for (const { q } of sampleMotion(m)) {
      const y = at(q).box.y;
      expect(y).toBeLessThanOrEqual(Math.max(poster.y, card.y) + 1e-6);
      expect(y).toBeGreaterThanOrEqual(Math.min(poster.y, card.y) - 1e-6);
    }
    expect(at(0).box).toEqual(poster);
    expect(at(1).box).toEqual(card);
  });

  it("le visuel est posé sur la bannière en haut de la carte, l'affiche part exactement d'elle-même", () => {
    const { at } = cardOpenPoses(poster, uniformCorners(8), card, cardBanner, uniformCorners(16));
    expect(at(0).bd).toEqual(coverTf(cardBanner, poster));
    expect(at(0).poster).toEqual({ tx: 0, ty: 0, s: 1 });
    expect(at(1).bd).toEqual({ tx: 0, ty: 0, s: 1 });
    expect(at(1).bdOpacity).toBe(1);
    expect(at(1).posterOpacity).toBe(0);
  });

  it("le retour part de la carte tirée au doigt, d'un bloc", () => {
    const rest = cardRestPose(card, uniformCorners(16), cardBanner, poster, 60);
    expect(rest.box.y).toBe(card.y + 60);
    expect(rest.bd.ty).toBe(60);
    expect(rest.bdOpacity).toBe(1);
  });

  it("la fermeture au doigt est moins vive qu'au bureau, mais jamais plus lente que l'ouverture", () => {
    const open = appleResponse(card, poster, stage, "phone");
    const close = closeResponse(card, poster, stage, "phone");
    expect(close).toBeLessThan(open);
    expect(close).toBeGreaterThan(0.7 * open);
    expect(closeResponse(card, poster, stage, "desktop")).toBeCloseTo(0.7 * appleResponse(card, poster, stage, "desktop"), 6);
  });

  it("la croix paraît de 30 à 95 % du trajet, pas pleine sur une image encore en vol", () => {
    expect(GLASS_IN.from).toBeGreaterThan(0);
    expect(GLASS_IN.to).toBeLessThan(1);
    const m = appleOpenMotion(poster, banner, stage, "phone");
    expect(timeAt(sampleMotion(m), m.duration, GLASS_IN.from)).toBeGreaterThan(0);
  });
});

describe("la fermeture au doigt, une seule pièce lancée à la vitesse du doigt", () => {
  it("le ressort du retour part exactement à la vitesse du doigt projetée sur le chemin de la carte", () => {
    const card: Box = { x: 0, y: 84, w: 390, h: 760 };
    const v0 = closeStartVelocity(card, poster, null, 2400);
    // L'affiche est plus bas que le centre de la carte : un doigt jeté vers le bas lance le retour.
    expect(v0).toBeGreaterThan(0);
    const m = appleCloseMotion(card, poster, stage, "phone", v0);
    expect(m.v(0)).toBeCloseTo(v0, 6);
    // La carte entière suit ce même ressort : sa vitesse de départ, projetée, est celle du doigt.
    const dy = poster.y + poster.h / 2 - (card.y + card.h / 2);
    const dx = poster.x + poster.w / 2 - (card.x + card.w / 2);
    expect(m.v(0) * (dy * dy + dx * dx)).toBeCloseTo(2400 * dy, 3);
  });
});
