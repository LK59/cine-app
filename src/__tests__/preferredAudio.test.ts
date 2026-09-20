import { describe, it, expect } from "vitest";
import { preferredAudio } from "@/lib/webcodecs/remuxPlayback";
import { chooseAudioTrack } from "@/lib/trackPreferences";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

/**
 * Sur quelle piste on **ouvre** — et non sur laquelle on bascule ensuite.
 *
 * Le pipeline se construisait sur la piste par défaut du fichier, le film démarrait, puis la
 * préférence du compte était appliquée en défaisant ce travail. Mesuré le 20/09/2026 : 429 ms sur
 * un fichier copié tel quel, 1 784 ms sur du DTS, 7,9 s sur l'appareil le plus lent du foyer — et
 * cela arrivait sur les quatre films testés, donc à chaque lecture.
 *
 * Ce qui suit fixe l'ordre des règles, parce qu'il se lit mal dans le code : la langue voulue
 * gagne, mais jamais au prix d'une piste que ce chemin ne sait pas porter.
 */
const piste = (n: number, codecId: string, language: string | null, channels = 6, isDefault = false): MatroskaTrack =>
  ({
    number: n,
    type: "audio",
    codecId,
    language,
    name: null,
    isDefault,
    isForced: false,
    audio: { channels, sampleRate: 48000 },
  }) as unknown as MatroskaTrack;

const fichier = (tracks: MatroskaTrack[]) => ({ tracks }) as unknown as MatroskaFile;
const veut = (audioLanguage: string | null, playDefaultAudioTrack = false) =>
  ({ audioLanguage, playDefaultAudioTrack }) as never;

describe("preferredAudio", () => {
  it("ouvre sur la langue du compte plutôt que sur le défaut du fichier", () => {
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_AC3", "eng")]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(2);
  });

  it("garde le comportement d'avant quand aucune préférence n'est chargée", () => {
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_AC3", "eng")]);
    expect(preferredAudio(f, null)?.number).toBe(1);
    expect(preferredAudio(f)?.number).toBe(1);
  });

  it("respecte « piste par défaut » : c'est une préférence, pas une absence de préférence", () => {
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_AC3", "eng")]);
    expect(preferredAudio(f, veut("eng", true))?.number).toBe(1);
  });

  it("n'ouvre jamais sur une piste que ce chemin ne sait pas porter", () => {
    // Le TrueHD dans la langue voulue ne doit pas faire refuser un fichier qui joue très bien sur
    // la piste d'à côté : c'est tout le sens de « parmi les jouables ».
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_TRUEHD", "eng", 8)]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(1);
  });

  /**
   * Le contrat qui fait tout tenir, et le seul qui doive être vérifié par un test.
   *
   * L'écran applique `chooseAudioTrack` dès que le film démarre et bascule si la piste ouverte
   * n'est pas la sienne. Ouvrir sur un autre choix ne supprimerait donc pas le changement qu'on
   * cherche à éviter. Les deux **doivent** tomber d'accord, quoi qu'on pense par ailleurs du
   * classement — ici la stéréo anglaise passe devant la 5.1 anglaise parce que `rank` ne compte
   * pas les canaux, et c'est déjà ce qui arrivait une seconde après le démarrage.
   */
  it("ouvre exactement sur ce que l'écran aurait choisi, sinon il bascule quand même", () => {
    const pistes = [piste(1, "A_AC3", "fra", 6, true), piste(2, "A_AC3", "eng", 2), piste(3, "A_EAC3", "eng", 6)];
    const prefs = veut("eng");
    expect(preferredAudio(fichier(pistes), prefs)?.number).toBe(chooseAudioTrack(pistes, prefs)?.number);
  });

  it("sans préférence, la plus riche de la langue du défaut gagne toujours", () => {
    // La règle d'avant, intacte là où elle s'applique encore.
    const f = fichier([piste(1, "A_AC3", "fra", 2, true), piste(2, "A_EAC3", "fra", 6), piste(3, "A_AC3", "eng")]);
    expect(preferredAudio(f, null)?.number).toBe(2);
  });

  it("retombe sur le défaut du fichier quand la langue voulue n'existe pas", () => {
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_AC3", "ita")]);
    expect(preferredAudio(f, veut("deu"))?.number).toBe(1);
  });

  it("rend quand même une piste quand aucune n'est jouable, pour que le refus nomme le vrai codec", () => {
    const f = fichier([piste(1, "A_TRUEHD", "fra", 8, true)]);
    expect(preferredAudio(f, veut("eng"))?.codecId).toBe("A_TRUEHD");
  });
});
