import { describe, it, expect } from "vitest";
import { dolbyVisionCodecString } from "@/lib/webcodecs/codecConfig";

/**
 * La chaîne de codec Dolby Vision, construite depuis l'enregistrement du conteneur.
 *
 * La disposition des bits a été relevée sur un vrai fichier de cette bibliothèque puis confrontée
 * à ce qu'en dit ffprobe, plutôt que lue dans une spécification — c'est la méthode qui a tranché
 * quatre fois dans la journée du 19/09/2026, là où le raisonnement s'était trompé deux fois.
 *
 *     01 00 10 35 …  →  version 1.0, profil 8, niveau 6, rpu=1 el=0 bl=1
 */
const REEL = new Uint8Array([
  0x01, 0x00, 0x10, 0x35, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

describe("dolbyVisionCodecString", () => {
  it("lit le profil et le niveau de « Retour vers le futur II »", () => {
    // ffprobe dit de ce fichier : dv_profile=8, dv_level=6. La chaîne doit dire la même chose.
    expect(dolbyVisionCodecString(REEL)).toBe("dvh1.08.06");
  });

  // Deux chiffres, zéro devant compris : aucun navigateur ne reconnaît `dvh1.8.6`.
  it("garde les deux chiffres, zéro devant compris", () => {
    const profil5 = new Uint8Array([0x01, 0x00, (5 << 1) | 0x00, (6 << 3) | 0b101, ...new Array(20).fill(0)]);
    expect(dolbyVisionCodecString(profil5)).toBe("dvh1.05.06");
  });

  // Un enregistrement tronqué ou vide ne doit pas produire une chaîne que personne ne reconnaîtra
  // — mieux vaut ne rien proposer que proposer `dvh1.00.00`.
  it("ne fabrique rien d'un enregistrement inutilisable", () => {
    expect(dolbyVisionCodecString(new Uint8Array([0x01, 0x00]))).toBeNull();
    expect(dolbyVisionCodecString(new Uint8Array(24))).toBeNull();
  });
});
