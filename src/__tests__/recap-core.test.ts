import { describe, it, expect } from "vitest";
import { judgeRecap, parseSrt, pickSubtitleStream, recapKey, recapSources, recapSystem, unknownNames, type SubtitleStream } from "@/lib/recap/core";

// « Précédemment » (DECISIONS.md §137) : chaque règle ici vient d'un défaut vu au banc du 08/11/2026.

describe("ce qui part au modèle", () => {
  const done = [
    { code: "S06E03", title: "A", overview: "Daenerys affronte son futur." },
    { code: "S06E04", title: "B", overview: "Petyr convainc Jon Snow de marcher sur Bolton." },
  ];
  const cues = [
    { startS: 100, text: "Tout au début." },
    { startS: 1000, text: "- Le roi est mort. - Vive la reine." },
    { startS: 1490, text: "Juste avant l'arrêt." },
    { startS: 1600, text: "Après l'arrêt : jamais envoyé." },
  ];
  const input = { series: "Game of Thrones", current: { code: "S06E05", title: "La porte" }, positionS: 1500, done, cues };

  it("au milieu d'un épisode : le dernier épisode fini et les dix minutes avant l'arrêt, rien après", () => {
    const { message, usedDialogue } = recapSources(input);
    expect(usedDialogue).toBe(true);
    expect(message).toContain("Petyr convainc");
    expect(message).not.toContain("Daenerys"); // un épisode trop loin, au banc
    expect(message).toContain("- Le roi est mort. - Vive la reine.");
    expect(message).not.toContain("Tout au début.");
    expect(message).not.toContain("jamais envoyé");
  });

  it("coupé au début de la tranche, pas à l'arrêt : le texte est partagé par tous les comptes de la tranche (11/11/2026)", () => {
    // Arrêté à 25:00, tranche 20-30 min : un autre compte arrêté à 20:10 lira le même texte — rien après 20:00.
    const { message } = recapSources(input);
    expect(message).not.toContain("Juste avant l'arrêt.");
    expect(message).toContain("à 20 min");
    expect(recapSources({ ...input, positionS: 1210 }).message).toBe(message);
  });

  it("au début d'un épisode : les deux derniers résumés, aucun dialogue", () => {
    const { message, usedDialogue } = recapSources({ ...input, positionS: 60 });
    expect(usedDialogue).toBe(false);
    expect(message).toContain("Daenerys");
    expect(message).toContain("Petyr");
    expect(message).toContain("depuis le début");
  });

  it("le résumé de l'épisode en cours n'existe pas dans l'entrée : il raconterait la suite", () => {
    expect(Object.keys(input.current)).toEqual(["code", "title"]);
  });

  it("écrit dans la langue du compte", () => {
    expect(recapSystem("de")).toContain("en allemand");
    expect(recapSystem("fr")).toContain("en français");
  });
});

describe("la clé", () => {
  it("une tranche par dix minutes, et rien avant deux minutes : l'épisode n'est pas commencé", () => {
    expect(recapKey("ep", 1530, "fr")).toBe("ep:3:fr:v2");
    expect(recapKey("ep", 1250, "fr")).toBe(recapKey("ep", 1790, "fr"));
    expect(recapKey("ep", 1790, "fr")).not.toBe(recapKey("ep", 1810, "fr"));
    expect(recapKey("ep", 0, "fr")).toBe(recapKey("ep", 90, "fr"));
    expect(recapKey("ep", 1530, "en")).not.toBe(recapKey("ep", 1530, "fr"));
  });
});

describe("les sous-titres", () => {
  it("lit un SRT, balises ôtées, lignes d'une réplique jointes", () => {
    const cues = parseSrt("1\r\n00:01:02,500 --> 00:01:04,000\r\n<i>- Bonjour.</i>\r\n- {\\an8}Salut.\r\n\r\n2\r\n01:00:00,000 --> 01:00:01,000\r\nFin.\r\n");
    expect(cues).toEqual([
      // La fin (10.30) et deux voix dans la même réplique (un tiret en tête d'une ligne après la première).
      { startS: 62, atS: 62.5, endS: 64, twoSpeakers: true, text: "- Bonjour. - Salut." },
      { startS: 3600, atS: 3600, endS: 3601, text: "Fin." },
    ]);
  });

  const s = (Index: number, f: Partial<SubtitleStream>): SubtitleStream => ({ Index, Type: "Subtitle", IsTextSubtitleStream: true, ...f });
  it("la piste ordinaire de la langue du compte, jamais la forcée, puis malentendants, puis l'anglais", () => {
    const streams = [s(1, { Language: "fre", IsForced: true }), s(2, { Language: "fre", Title: "SDH" }), s(3, { Language: "fre" }), s(4, { Language: "eng" })];
    expect(pickSubtitleStream(streams, "fr")?.Index).toBe(3);
    expect(pickSubtitleStream(streams.slice(0, 2), "fr")?.Index).toBe(2);
    expect(pickSubtitleStream([streams[0], streams[3]], "fr")?.Index).toBe(4);
    expect(pickSubtitleStream([s(5, { Language: "fre", IsTextSubtitleStream: false })], "fr")).toBeNull();
  });
});

describe("le jugement de la réponse", () => {
  const sources = "Game of Thrones\nLord Petyr convainc Jon Snow. Yara Greyjoy revendique le trône.";

  it("rejette un nom que les sources ne contiennent pas — « Baelish » venait de la mémoire du modèle", () => {
    expect(unknownNames("Sansa refuse l'aide de Petyr Baelish.", sources)).toEqual(["Baelish"]);
    // En tête de phrase, seul le nom déclaré par le modèle le trahit.
    expect(unknownNames("Sansa refuse l'aide de Petyr.", sources, ["Sansa Stark", "Petyr"])).toEqual(["Sansa", "Stark"]);
    expect(judgeRecap({ noms: ["Brienne"], phrases: [{ texte: "Brienne retrouve Jon Snow.", episodes: [] }] }, sources)).toEqual({ status: "rejeté", names: ["Brienne"] });
    expect(judgeRecap({ phrases: [{ texte: "Lord Petyr retrouve Baelish.", episodes: [] }] }, sources)).toEqual({ status: "rejeté", names: ["Baelish"] });
  });

  it("garde une réponse dont chaque nom est dans les sources, sans « Dans S06E04 » ni code en fin", () => {
    const v = judgeRecap({ phrases: [{ texte: "Dans S06E04, lord Petyr convainc Jon Snow.", episodes: ["S06E04"] }, { texte: "Yara Greyjoy revendique le trône [S06E05]", episodes: [] }] }, sources);
    expect(v).toEqual({ status: "ok", text: "Lord Petyr convainc Jon Snow. Yara Greyjoy revendique le trône" });
  });

  it("« inchangé » rend le texte précédent tel quel ; sans texte précédent, c'est une réponse vide", () => {
    expect(judgeRecap({ inchange: true, noms: [], phrases: [] }, sources, "Jon Snow marche.")).toEqual({ status: "ok", text: "Jon Snow marche.", kept: true });
    expect(judgeRecap({ inchange: true, noms: [], phrases: [] }, sources, null)).toEqual({ status: "vide" });
  });

  it("un nom se cherche en mot entier, pas dans un mot courant ; le pluriel des sources vaut le nom (11/11/2026)", () => {
    const src = "Une année plus tard, il se tient l'épaule. The Starks turned back. D'Arya, rien.";
    expect(unknownNames("Elle parle à Anne et à Paul.", src)).toEqual(["Anne", "Paul"]);
    expect(unknownNames("Il aide Ned.", src)).toEqual(["Ned"]);
    expect(unknownNames("Il rejoint les Stark, puis Arya.", src)).toEqual([]);
  });

  it("une abréviation de titre n'est pas une fin de phrase : le nom qui la suit est vérifié (11/11/2026)", () => {
    const src = "Willard remonte le fleuve. Le docteur Wilson soigne Rosa.";
    // « M. Kurtz », « Dr. Wilson » : le nom suit un point, mais pas une phrase finie.
    expect(unknownNames("Willard cherche M. Kurtz.", src)).toEqual(["Kurtz"]);
    expect(unknownNames("Willard cherche Mr. Kurtz et Mme Rosa.", src)).toEqual(["Kurtz"]);
    expect(unknownNames("Rosa voit Dr. Wilson, puis Sra. García et Hr. Becker.", src)).toEqual(["García", "Becker"]);
    expect(unknownNames("M. Kurtz attend.", src)).toEqual(["Kurtz"]);
    // Une vraie fin de phrase garde sa règle : le premier mot de la suivante n'est pas vérifié par les majuscules.
    expect(unknownNames("Willard remonte le fleuve. Pendant ce temps, Rosa attend.", src)).toEqual([]);
    expect(unknownNames("Il le suit. Me voilà.", src)).toEqual([]);
    expect(unknownNames("Follow me. Kurtz waits.", src)).toEqual([]);
  });

  it("en allemand, la règle des majuscules n'est pas tendue — seuls les noms déclarés le sont (11/11/2026)", () => {
    const src = "Jon Snow marschiert gegen Ramsay Bolton.";
    const text = "Jon Snow verlässt die Burg und führt seine Armee in die Schlacht.";
    // Chaque nom commun allemand (« Burg », « Armee », « Schlacht ») passait pour un nom propre inconnu.
    expect(unknownNames(text, src)).toEqual(["Burg", "Armee", "Schlacht"]);
    expect(unknownNames(text, src, [], "de")).toEqual([]);
    expect(unknownNames(text, src, ["Jon Snow", "Sansa"], "de")).toEqual(["Sansa"]);
    expect(judgeRecap({ noms: ["Jon Snow"], phrases: [{ texte: text, episodes: [] }] }, src, null, "de")).toEqual({ status: "ok", text });
    expect(judgeRecap({ noms: ["Jon Snow", "Brienne"], phrases: [{ texte: text, episodes: [] }] }, src, null, "de")).toEqual({ status: "rejeté", names: ["Brienne"] });
    // Sans liste déclarée, rien ne serait vérifié : rejeté.
    expect(judgeRecap({ phrases: [{ texte: text, episodes: [] }] }, src, null, "de")).toEqual({ status: "rejeté", names: ["noms"] });
    // Les autres langues gardent les deux filets.
    expect(judgeRecap({ noms: [], phrases: [{ texte: "Jon Snow rejoint Brienne.", episodes: [] }] }, src, null, "fr")).toEqual({ status: "rejeté", names: ["Brienne"] });
  });

  it("le texte précédent est donné au modèle et compte parmi les sources", () => {
    const { message, sources: src } = recapSources({ series: "S", current: { code: "S01E02", title: "x" }, positionS: 60, done: [{ code: "S01E01", title: "y", overview: "Un début." }], cues: [], previous: "Arya part pour Braavos." });
    expect(message).toContain("Arya part pour Braavos.");
    expect(unknownNames("Elle rejoint Arya à Braavos.", src)).toEqual([]);
  });

  it("coupe à trois phrases et à la longueur, et une réponse vide n'affiche rien", () => {
    const long = Array.from({ length: 5 }, () => ({ texte: "Jon Snow " + "marche ".repeat(30), episodes: [] }));
    const v = judgeRecap({ phrases: long }, sources);
    expect(v.status).toBe("ok");
    expect(v.status === "ok" && v.text.split(/\s+/).length).toBeLessThanOrEqual(80);
    expect(judgeRecap({ phrases: [] }, sources)).toEqual({ status: "vide" });
    expect(judgeRecap(null, sources)).toEqual({ status: "vide" });
  });
});
