import { describe, it, expect } from "vitest";
import { preferredAudio } from "@/lib/webcodecs/remuxPlayback";
import { chooseAudioTrack, isForcedTrack } from "@/lib/trackPreferences";
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

/**
 * Le cas « Le Mans 66 », décidé le 20/09/2026 : à langue égale, on prend la meilleure piste qui
 * **joue ici**.
 *
 * Le fichier porte trois pistes — DTS 5.1 française par défaut, TrueHD 7.1 anglaise, AC-3 5.1
 * anglaise. Le spectateur demandait la VO ; il recevait la TrueHD, que rien ne décode, et le
 * lecteur lui cédait la place au lecteur serveur. Six fois, relevé dans le journal. Il obtient
 * maintenant la VO sans quitter le lecteur natif, en 5.1 au lieu de 7.1.
 */
describe("à langue égale, la meilleure piste jouable", () => {
  const leMans = () =>
    fichier([
      piste(1, "A_DTS", "fra", 6, true),
      piste(2, "A_TRUEHD", "eng", 8),
      piste(3, "A_AC3", "eng", 6),
    ]);

  it("préfère l'AC-3 anglaise à la TrueHD anglaise", () => {
    expect(preferredAudio(leMans(), veut("eng"))?.number).toBe(3);
  });

  it("ouvre sur ce qui joue quand la langue demandée n'existe qu'en injouable", () => {
    /**
     * Deux règles, et elles ne se contredisent pas : on **ouvre** sur une piste qui joue, pour
     * que le film démarre, et c'est l'écran qui décide ensuite de céder la place au lecteur
     * serveur — parce que le spectateur qui demande la VO doit obtenir la VO. Sans cela, on
     * paierait une tentative de plus pour arriver au même endroit.
     */
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_TRUEHD", "eng", 8)]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(1);
  });

  it("entre deux pistes jouables de la même langue, prend la plus riche", () => {
    const f = fichier([piste(1, "A_AC3", "fra", 6, true), piste(2, "A_AC3", "eng", 2), piste(3, "A_EAC3", "eng", 6)]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(3);
  });

  it("l'écran et l'ouverture répondent la même chose", () => {
    // Le contrat de tout le dispositif : si les deux divergent, on ouvre sur l'une et on bascule
    // aussitôt vers l'autre — c'est le geste qu'on cherche à supprimer.
    const pistes = leMans().tracks;
    const prefs = veut("eng");
    const jouable = (t: (typeof pistes)[number]) => !/TRUEHD|MLP/.test(t.codecId);
    expect(preferredAudio(fichier(pistes), prefs)?.number).toBe(chooseAudioTrack(pistes, prefs, jouable)?.number);
  });
});

/**
 * « La meilleure lisible » veut dire la plus riche — et le drapeau du fichier ne doit pas s'y
 * substituer.
 *
 * Le cas de « 2001 : L'Odyssée de l'espace », relevé dans le journal : quatre pistes E-AC3, dont
 * une française stéréo marquée par défaut et une française 5.1 qui ne l'est pas. Le drapeau
 * valait cinq points dans le score, donc il passait devant le nombre de canaux — on ouvrait sur
 * la stéréo. Le drapeau départage maintenant *après* la richesse.
 */
describe("la plus riche passe avant le drapeau « par défaut »", () => {
  it("prend la 5.1 même quand la stéréo est la piste par défaut du fichier", () => {
    const f = fichier([piste(1, "A_EAC3", "fra", 2, true), piste(2, "A_EAC3", "fra", 6)]);
    expect(preferredAudio(f, veut("fra"))?.number).toBe(2);
  });

  it("préfère l'E-AC3 5.1 à l'AAC stéréo de la même langue", () => {
    const f = fichier([piste(1, "A_AAC", "eng", 2, true), piste(2, "A_EAC3", "eng", 6)]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(2);
  });

  it("mais le drapeau tranche toujours entre deux pistes également riches", () => {
    const f = fichier([piste(1, "A_EAC3", "eng", 6), piste(2, "A_EAC3", "eng", 6, true)]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(2);
  });

  it("et ce qui joue ici passe toujours avant la richesse", () => {
    // Une TrueHD 7.1 reste refusée devant une AC-3 5.1 : 20 points dans le score battent un
    // départage, quel que soit le nombre de canaux.
    const f = fichier([piste(1, "A_TRUEHD", "eng", 8), piste(2, "A_AC3", "eng", 6)]);
    expect(preferredAudio(f, veut("eng"))?.number).toBe(2);
  });
});

/**
 * Une piste forcée, reconnue même quand le drapeau manque.
 *
 * Relevé sur cette bibliothèque le 20/09/2026 : **51 pistes sur 392** portent « forcé » dans leur
 * titre sans que `FlagForced` soit posé — « Français forcés », « forced », « VFF Forced »,
 * « VFQ : Forced ». Une sur huit était invisible au choix automatique, donc les modes « forcés
 * seulement » et « intelligent » n'affichaient rien sur ces films-là.
 */
describe("isForcedTrack", () => {
  const st = (name: string | null, isForced = false) =>
    ({ language: "fra", name, isDefault: false, isForced }) as never;

  it("croit le drapeau quand il est posé", () => {
    expect(isForcedTrack(st(null, true))).toBe(true);
    expect(isForcedTrack(st("Complet", true))).toBe(true);
  });

  it("lit le titre quand le drapeau manque — les quatre formes relevées", () => {
    for (const titre of ["Français forcés", "forced", "VFF Forced", "VFQ : Forced", "Forcé", "French (France) Forced"]) {
      expect(isForcedTrack(st(titre)), titre).toBe(true);
    }
  });

  it("exige un mot entier, pour qu'un titre qui parle d'autre chose ne s'y glisse pas", () => {
    // « Forces » et « force » sont des mots français ordinaires : les reconnaître ferait passer
    // « Forces spéciales » pour un sous-titre forcé. Seules les formes sans ambiguïté comptent.
    for (const titre of ["Renforcement", "Forces spéciales : commentaire", "La force tranquille", "SDH", "Complet", null]) {
      expect(isForcedTrack(st(titre)), String(titre)).toBe(false);
    }
  });
});
