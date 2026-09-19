import { describe, it, expect } from "vitest";
import { dolbyVisionCodecString } from "@/lib/webcodecs/codecConfig";
import { planDolbyVision } from "@/lib/webcodecs/pathSelector";

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

/**
 * L'arbre de décision, éprouvé sans navigateur, sans fichier et sans appareil.
 *
 * Trois issues, dans l'ordre que le foyer a demandé : le Dolby Vision quand tout s'y prête, sa
 * couche de base sinon, et le lecteur serveur quand il n'y a pas de couche de base du tout.
 *
 * C'est la seule partie de ce chantier où une erreur de raisonnement ne se verrait pas à la
 * lecture — le reste est de la recopie d'octets, qui se vérifie à l'œil. D'où une fonction pure,
 * et d'où ces cas.
 */
describe("planDolbyVision", () => {
  const record = new Uint8Array([
    0x01, 0x00, 0x10, 0x35, 0x10, ...new Array(19).fill(0),
  ]);
  const profil5 = new Uint8Array([0x01, 0x00, (5 << 1), (6 << 3) | 0b101, 0x00, ...new Array(19).fill(0)]);
  const piste = (r: Uint8Array | null) => ({ dolbyVision: r ? { type: "dvvC", record: r } : undefined });
  const oui = () => true;
  const non = () => false;

  it("livre du Dolby Vision quand le navigateur l'accepte", () => {
    const plan = planDolbyVision(piste(record), "DOVIWithHDR10", oui);
    expect(plan.kind).toBe("dolby");
    if (plan.kind === "dolby") {
      expect(plan.codec).toBe("dvh1.08.06");
      // La boîte est celle du conteneur, transmise telle quelle — jamais reconstruite.
      expect(plan.box.record).toBe(record);
      expect(plan.box.type).toBe("dvvC");
    }
  });

  it("retombe sur la couche HDR10 quand le navigateur refuse", () => {
    expect(planDolbyVision(piste(record), "DOVIWithHDR10", non).kind).toBe("hdr10");
  });

  // Le cas de « Disclosure Day » : profil 5, aucune couche de base. Un refus n'a nulle part où
  // atterrir, et c'est exactement ce qui donnait des couleurs fausses avant qu'on le sache.
  it("demande le lecteur serveur quand il n'y a pas de couche de base", () => {
    const plan = planDolbyVision(piste(profil5), "DOVI", non);
    expect(plan.kind).toBe("server");
    if (plan.kind === "server") expect(plan.reason).toContain("couleurs fausses");
  });

  it("livre quand même le Dolby Vision d'un profil 5 si le navigateur l'accepte", () => {
    // C'est tout l'intérêt du chantier pour ces deux fichiers-là : ils redeviennent lisibles
    // nativement au lieu de coûter un ré-encodage 4K au serveur.
    expect(planDolbyVision(piste(profil5), "DOVI", oui).kind).toBe("dolby");
  });

  it("ne touche à rien pour un fichier sans Dolby Vision", () => {
    expect(planDolbyVision(piste(null), "HDR10", oui).kind).toBe("hdr10");
    expect(planDolbyVision(piste(null), "SDR", non).kind).toBe("hdr10");
  });

  /**
   * L'interrupteur, et ce qu'il garantit.
   *
   * Fermé, la sortie est celle d'avant à l'octet près : `hvc1`, HDR10, les 188 titres lus comme
   * ils l'ont toujours été. C'est ce qui permet de lever un doute en changeant un mot.
   */
  it("ne livre rien quand l'interrupteur est fermé", () => {
    expect(planDolbyVision(piste(record), "DOVIWithHDR10", oui, false).kind).toBe("hdr10");
    // Et le profil 5 repart au serveur, comme avant le chantier.
    expect(planDolbyVision(piste(profil5), "DOVI", oui, false).kind).toBe("server");
  });

  // Un enregistrement illisible n'est pas une raison de refuser un fichier qui a une couche de
  // base : on ne sait pas l'annoncer, donc on livre ce qu'on sait livrer.
  it("retombe proprement sur un enregistrement illisible", () => {
    const casse = new Uint8Array([0x01, 0x00]);
    expect(planDolbyVision(piste(casse), "DOVIWithHDR10", oui).kind).toBe("hdr10");
    expect(planDolbyVision(piste(casse), "DOVI", oui).kind).toBe("server");
  });
});
