import { describe, it, expect } from "vitest";
import { fold, toCodecChannelOrder } from "@/lib/webcodecs/audioTranscode";

/** Un plan constant, pour lire d'un coup d'œil où le contenu a atterri. */
const plane = (value: number, frames = 4) => new Float32Array(frames).fill(value);
/** La valeur de chaque canal en sortie — L R C LFE Ls Rs Lrs Rrs. */
const channels = (planes: Float32Array[]) => planes.map((p) => Math.round(p[0] * 1000) / 1000);

describe("fold — compléter vers le haut", () => {
  /**
   * Le mono, et c'est le cas qui s'entendait.
   *
   * Complété comme les autres, l'unique plan devient l'avant gauche et rien d'autre. Le navigateur
   * replie ce 5.1 en stéréo — droite = R + 0,707·C + 0,707·Rs — et les trois termes sont nuls : le
   * film entier dans une seule oreille. C'est la piste française par défaut de « L'Exorciste ».
   */
  it("copie un mono dans les deux canaux avant, pas seulement à gauche", () => {
    expect(channels(fold([plane(1)], 6))).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it("le fait aussi vers la stéréo", () => {
    expect(channels(fold([plane(0.5)], 2))).toEqual([0.5, 0.5]);
  });

  it("un 5.1 porté en 7.1 garde ses six canaux et ajoute deux arrières muets", () => {
    const source = [plane(1), plane(2), plane(3), plane(4), plane(5), plane(6)];
    expect(channels(fold(source, 8))).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
  });

  it("ne touche à rien quand la disposition est déjà la bonne", () => {
    const source = [plane(1), plane(2)];
    expect(fold(source, 2)).toBe(source);
  });
});

describe("fold — replier vers le bas", () => {
  it("un 7.1 vers 5.1 somme les arrières dans l'ambiance à puissance conservée", () => {
    const source = [plane(1), plane(2), plane(3), plane(4), plane(5), plane(6), plane(7), plane(8)];
    const out = channels(fold(source, 6));
    expect(out.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(out[4]).toBeCloseTo(5 * 0.707 + 7 * 0.707, 3);
    expect(out[5]).toBeCloseTo(6 * 0.707 + 8 * 0.707, 3);
  });

  it("un 5.1 vers stéréo suit la matrice BS.775 et écarte la basse fréquence", () => {
    const source = [plane(1), plane(1), plane(1), plane(9), plane(1), plane(1)];
    const out = channels(fold(source, 2));
    // Gauche = L + 0,707·C + 0,707·Ls. Le canal LFE, à 9, ne doit apparaître nulle part.
    expect(out[0]).toBeCloseTo(1 + 0.707 + 0.707, 3);
    expect(out[1]).toBeCloseTo(1 + 0.707 + 0.707, 3);
  });

  it("garde les premiers canaux plutôt que d'inventer une matrice inconnue", () => {
    const source = [plane(1), plane(2), plane(3), plane(4), plane(5)];
    expect(channels(fold(source, 3))).toEqual([1, 2, 3]);
  });
});


/**
 * L'ordre des canaux entre le décodeur et l'encodeur.
 *
 * Le symptôme, rapporté au casque sur « Titanic » : les voix uniquement à droite, la musique à
 * gauche, sur les quatre pistes — toutes en 6 canaux. Les plans étaient entrelacés dans l'ordre
 * du décodeur et lus dans celui de l'AAC, donc chaque canal gardait son rang et changeait de
 * sens. Le centre, c'est-à-dire les dialogues, arrivait au rang du canal droit.
 */
/**
 * Ce que l'encodeur attend, mesuré plutôt que déduit.
 *
 * Ces tests figeaient une permutation vers l'ordre du *train binaire* AAC. Le raisonnement était
 * juste sur le format et faux sur l'interface : `AudioEncoder` ne reçoit pas un train binaire mais
 * un `AudioData`, déjà dans l'ordre standard de l'API Web Audio — L R C LFE Ls Rs —, et c'est lui
 * qui convertit. La permutation l'appliquait donc deux fois, et envoyait tout le dialogue dans
 * l'oreille gauche une fois replié en stéréo. Rapporté au casque sur Chrome, sur les deux pistes
 * d'un même film.
 *
 * La mesure qui tranche, plan par plan sur vingt secondes de dialogue : notre décodeur rend
 * exactement les mêmes niveaux que ffmpeg en ordre WAVE, à deux décimales, sur « Twilight » en
 * E-AC3 comme sur « Titanic » en AC-3. Le centre est au rang 2 de part et d'autre.
 */
describe("toCodecChannelOrder", () => {
  /** Les plans dans l'ordre du décodeur : L R C LFE Ls Rs. C'est aussi celui de l'encodeur. */
  const surround = [plane(1), plane(2), plane(3), plane(4), plane(5), plane(6)];

  it("laisse le 5.1 tel quel pour l'AAC : il est déjà dans le bon ordre", () => {
    expect(toCodecChannelOrder(surround, "mp4a.40.2")).toBe(surround);
  });

  it("laisse le 7.1 tel quel lui aussi", () => {
    const eight = [...surround, plane(7), plane(8)];
    expect(toCodecChannelOrder(eight, "mp4a.40.2")).toBe(eight);
  });

  // Le canal du centre vaut 3 à l'entrée : il doit rester au rang 2, celui que l'encodeur lit
  // comme le centre. Au rang 0, c'est le canal gauche — et c'était le défaut.
  it("laisse le dialogue au centre, et non dans l'oreille gauche", () => {
    const out = channels(toCodecChannelOrder(surround, "mp4a.40.2"));
    expect(out[2]).toBe(3);
    expect(out[0]).toBe(1);
  });

  it("ne touche pas à la stéréo, qui range pareil des deux côtés", () => {
    const stereo = [plane(1), plane(2)];
    expect(toCodecChannelOrder(stereo, "mp4a.40.2")).toBe(stereo);
  });

  /**
   * Opus garde la sienne, et l'asymétrie est volontaire.
   *
   * Le même raisonnement s'y applique, mais l'AAC a contre elle une mesure *et* deux rapports
   * d'usage quand Opus n'a ni l'une ni les autres — personne ici ne regarde depuis Firefox.
   * Retirer les deux sur la foi d'une seule mesure serait refaire l'erreur qu'on corrige.
   */
  it("garde la convention Vorbis pour Opus, faute de mesure de ce côté", () => {
    expect(channels(toCodecChannelOrder(surround, "opus"))).toEqual([1, 3, 2, 5, 6, 4]);
  });
});
