import { describe, it, expect, vi, afterEach } from "vitest";
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
    expect(out[4]).toBeCloseTo((5 + 7) * Math.SQRT1_2, 3);
    expect(out[5]).toBeCloseTo((6 + 8) * Math.SQRT1_2, 3);
  });

  it("un 5.1 vers stéréo suit la matrice BS.775 et écarte la basse fréquence", () => {
    const source = [plane(1), plane(1), plane(1), plane(9), plane(1), plane(1)];
    const out = channels(fold(source, 2));
    // Gauche = L + 0,707·C + 0,707·Ls. Le canal LFE, à 9, ne doit apparaître nulle part.
    expect(out[0]).toBeCloseTo(1 + Math.SQRT1_2 + Math.SQRT1_2, 3);
    expect(out[1]).toBeCloseTo(1 + Math.SQRT1_2 + Math.SQRT1_2, 3);
  });

  it("garde les premiers canaux plutôt que d'inventer une matrice inconnue", () => {
    const source = [plane(1), plane(2), plane(3), plane(4), plane(5)];
    expect(channels(fold(source, 3))).toEqual([1, 2, 3]);
  });
});

/**
 * Les dispositions que le nombre de canaux ne suffit pas à nommer.
 *
 * Relevé sur cette bibliothèque le 19/09/2026, 1 462 pistes : 1 ch × 15, 2 ch × 208, 3 ch × 2,
 * **5 ch × 2**, 6 ch × 1 113, **7 ch × 2**, 8 ch × 120. Les six pistes à 5 et 7 canaux n'entrent
 * dans aucun modèle, et pour une raison de fond : cinq canaux, c'est un 5.0 — L R C Ls Rs, sans
 * caisson — chez « Mamma Mia! », et un 4.1 — L R C LFE Cs — chez « Point Break ». Le décodeur ne
 * rend que le compte, jamais la disposition.
 *
 * Lus aux rangs du 5.1, ces plans envoyaient l'ambiance *droite* dans l'ambiance gauche et
 * laissaient le côté droit sans la sienne.
 */
describe("fold — une disposition qu'on ne sait pas nommer", () => {
  /** 5.0 : L R C Ls Rs. Le rang 3 n'est pas un caisson, c'est déjà une ambiance. */
  const fiveOh = [plane(1), plane(2), plane(3), plane(4), plane(5)];

  it("ne range pas l'ambiance d'un 5.0 dans le caisson d'un 5.1", () => {
    // Les trois de devant à leur place, et rien d'inventé derrière : mieux vaut perdre l'ambiance
    // de deux pistes que la déplacer sur toutes.
    expect(channels(fold(fiveOh, 6))).toEqual([1, 2, 3, 0, 0, 0]);
  });

  it("replie un 5.0 en stéréo sans déséquilibrer les côtés", () => {
    const out = channels(fold(fiveOh, 2));
    // Gauche = L + 0,707·C ; droite = R + 0,707·C. Symétrique, ce que l'ancienne lecture n'était
    // pas : elle prenait le rang 4 pour l'ambiance gauche — c'est-à-dire l'ambiance droite — et
    // ne trouvait rien pour la droite.
    expect(out[0]).toBeCloseTo(1 + 3 * Math.SQRT1_2, 3);
    expect(out[1]).toBeCloseTo(2 + 3 * Math.SQRT1_2, 3);
  });

  /** 6.1 : L R C LFE Cs Ls Rs — le rang 4 est un arrière central, pas une ambiance. */
  it("ne lit pas l'arrière central d'un 6.1 comme une ambiance", () => {
    const sixOne = [plane(1), plane(2), plane(3), plane(4), plane(5), plane(6), plane(7)];
    expect(channels(fold(sixOne, 8))).toEqual([1, 2, 3, 0, 0, 0, 0, 0]);
    const stereo = channels(fold(sixOne, 2));
    expect(stereo[0]).toBeCloseTo(1 + 3 * Math.SQRT1_2, 3);
    expect(stereo[1]).toBeCloseTo(2 + 3 * Math.SQRT1_2, 3);
  });

  // Même compte en entrée et en sortie : l'Opus de Firefox accepte cinq canaux, et un 4.1 passé
  // tel quel y était lu en 5.0 — le caisson dans l'ambiance gauche (relu le 24/09/2026).
  it("applique sa règle même quand le nombre de canaux ne change pas", () => {
    expect(channels(fold(fiveOh, 5))).toEqual([1, 2, 3, 0, 0]);
  });

  // Trois canaux, eux, sont sûrs : les trois premiers rangs sont les mêmes partout.
  it("laisse passer un 3.0, dont les trois rangs sont ceux de tout le monde", () => {
    expect(channels(fold([plane(1), plane(2), plane(3)], 6))).toEqual([1, 2, 3, 0, 0, 0]);
  });
});


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
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
afterEach(() => vi.unstubAllGlobals());

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

  it("mais range le 5.1 dans l'ordre AAC pour l'encodeur d'Apple, qui ne convertit pas", () => {
    // « Titanic » sur iPhone le 07/09, Braveheart en VO 7.1 sur iPhone le 21/09 : les voix à
    // droite. WebKit ne transmet à l'encodeur d'Apple que le nombre de canaux ; celui-ci lit les
    // plans dans l'ordre du format, centre d'abord. Chrome, lui, convertit — le test d'au-dessus.
    vi.stubGlobal("navigator", { userAgent: IPHONE });
    expect(channels(toCodecChannelOrder(surround, "mp4a.40.2"))).toEqual([3, 1, 2, 5, 6, 4]);
    expect(channels(toCodecChannelOrder([plane(1), plane(2), plane(3)], "mp4a.40.2"))).toEqual([3, 1, 2]);
    // Chrome sur macOS : le même encodeur d'Apple, lu dans son code — la même table.
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" });
    expect(channels(toCodecChannelOrder(surround, "mp4a.40.2"))).toEqual([3, 1, 2, 5, 6, 4]);
    // Chrome sous Windows et sous Android : l'ordre standard.
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36" });
    expect(toCodecChannelOrder(surround, "mp4a.40.2")).toBe(surround);
    vi.stubGlobal("navigator", { userAgent: IPHONE });
    // La stéréo reste ce qu'elle est, partout.
    const stereo = [plane(1), plane(2)];
    expect(toCodecChannelOrder(stereo, "mp4a.40.2")).toBe(stereo);
  });

  it("ne touche pas à la stéréo, qui range pareil des deux côtés", () => {
    const stereo = [plane(1), plane(2)];
    expect(toCodecChannelOrder(stereo, "mp4a.40.2")).toBe(stereo);
  });

  /**
   * Opus : rien non plus, mesuré le 21/09/2026. Firefox a encodé un 5.1 et un 7.1 dont chaque
   * canal portait sa fréquence, ffmpeg les a décodés : avec la table Vorbis, le centre ressortait
   * à droite ; sans elle, tout revenait en place. libopus convertit depuis l'ordre standard.
   */
  it("laisse l'Opus dans l'ordre standard : l'encodeur convertit", () => {
    expect(toCodecChannelOrder(surround, "opus")).toBe(surround);
    const eight = [...surround, plane(7), plane(8)];
    expect(toCodecChannelOrder(eight, "opus")).toBe(eight);
  });
});
