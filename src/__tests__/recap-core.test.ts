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
    expect(message).toContain("Juste avant l'arrêt.");
    expect(message).not.toContain("Tout au début.");
    expect(message).not.toContain("jamais envoyé");
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
    expect(recapKey("ep", 1530, "fr")).toBe("ep:3:fr");
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
      { startS: 62, atS: 62.5, text: "- Bonjour. - Salut." },
      { startS: 3600, atS: 3600, text: "Fin." },
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
