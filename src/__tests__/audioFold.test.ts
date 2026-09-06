import { describe, it, expect } from "vitest";
import { fold } from "@/lib/webcodecs/audioTranscode";

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
