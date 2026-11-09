import { describe, it, expect } from "vitest";
import { AnswerGate, METALESS_LIMIT, type GateResult } from "@/lib/ask/core";

// La réponse mot par mot (10.28.0, consigne du propriétaire) : chaque mot part dès qu'il est complet et sûr ;
// la seule retenue est sur un nom pas encore vérifié (un mot en cours d'écriture n'est jamais montré), et un
// nom inconnu retire toute la réponse avant d'être montré — la même sûreté que le filet phrase par phrase.
// Le filet des mots de coulisse continue de marcher sur le texte qui coule : jamais une phrase interdite à
// moitié à l'écran.

const SOURCES = "Inception\nLeonardo DiCaprio — Cobb\nElliot Page — Ariadne\nAriadne construit le labyrinthe.\nFlo 'Sassy' Collins";

/** Ce que l'écran montre après chaque morceau : les mots ajoutés, un `reset` remet tout. */
function screenOf(gate: AnswerGate, chunks: string[]) {
  let text = "";
  const frames: string[] = [];
  let outcome: Pick<GateResult, "rejected" | "retry"> = {};
  const apply = (out: GateResult) => {
    if (out.reset !== undefined) text = out.reset;
    for (const w of out.release) text = text ? `${text} ${w}` : w;
    if (out.rejected) {
      text = "";
      outcome = { rejected: out.rejected };
    }
    if (out.retry) outcome = { retry: true };
    frames.push(text);
  };
  for (const c of chunks) {
    const out = gate.push(c);
    apply(out);
    if (out.rejected || out.retry) return { text, frames, ...outcome };
  }
  apply(gate.end());
  return { text, frames, ...outcome };
}
const chars = (s: string) => [...s];
/** Un découpage pseudo-aléatoire, reproductible. */
function randomChunks(s: string, seed: number): string[] {
  const out: string[] = [];
  let i = 0;
  let x = seed;
  while (i < s.length) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const n = 1 + (x % 9);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

describe("mot par mot", () => {
  it("des noms connus coulent tout de suite : chaque mot complet part au morceau qui le termine", () => {
    const gate = new AnswerGate(SOURCES);
    expect(gate.push("NOMS: Ariadne, Cobb\n\nAriadne ").release).toEqual(["Ariadne"]);
    expect(gate.push("rejoint ").release).toEqual(["rejoint"]);
    // Un mot en cours d'écriture attend son blanc.
    expect(gate.push("Co").release).toEqual([]);
    expect(gate.push("bb dans").release).toEqual(["Cobb"]);
    expect(gate.end().release).toEqual(["dans"]);
    expect(gate.text).toBe("Ariadne rejoint Cobb dans");
  });

  it("les noms des personnages de TMDB, guillemets compris, sont connus", () => {
    const r = screenOf(new AnswerGate(SOURCES), chars("NOMS: Flo 'Sassy' Collins\n\nFlo 'Sassy' Collins regarde Ariadne."));
    expect(r.rejected).toBeUndefined();
    expect(r.text).toBe("Flo 'Sassy' Collins regarde Ariadne.");
  });

  it("un nom inconnu : retenu tant qu'il s'écrit, jamais montré, et toute la réponse est retirée", () => {
    const gate = new AnswerGate(SOURCES);
    expect(gate.push("NOMS: —\n\nLe rêve s'effondre. Puis il rejoint Mom").release).toEqual(["Le", "rêve", "s'effondre.", "Puis", "il", "rejoint"]);
    const out = gate.push("basa avec Eames. ");
    expect(out.release).toEqual([]);
    expect(out.rejected).toEqual(["Mombasa"]);
    // Rien ne sort plus.
    expect(gate.push("Encore une phrase. ").release).toEqual([]);
    expect(gate.end().release).toEqual([]);
  });

  it("un nom inconnu déclaré dans la ligne des noms : rejeté avant le premier mot", () => {
    const r = screenOf(new AnswerGate(SOURCES), chars("NOMS: Saito\n\nSaito arrive au Japon."));
    expect(r.rejected).toEqual(["Saito"]);
    expect(r.frames.every((f) => f === "")).toBe(true);
  });

  it("le texte final est le même quel que soit le découpage du flux — et celui d'avant, phrase par phrase", () => {
    const answer = "NOMS: Ariadne, Cobb\n\nAriadne construit le labyrinthe pour Cobb.  Elle doute\nencore ! Puis elle dessine… Fin";
    const whole = screenOf(new AnswerGate(SOURCES), [answer]).text;
    expect(whole).toBe("Ariadne construit le labyrinthe pour Cobb. Elle doute encore ! Puis elle dessine… Fin");
    expect(screenOf(new AnswerGate(SOURCES), chars(answer)).text).toBe(whole);
    for (const seed of [1, 7, 42, 99]) expect(screenOf(new AnswerGate(SOURCES), randomChunks(answer, seed)).text).toBe(whole);
    // Et chaque étape de l'écran est un début du texte final : rien d'affiché n'est retiré quand tout va bien.
    for (const f of screenOf(new AnswerGate(SOURCES), chars(answer)).frames) expect(whole.startsWith(f)).toBe(true);
  });
});

describe("les mots de coulisse dans le texte qui coule", () => {
  const meta = (retry: boolean, onMeta: "replace" | "drop") => ({ locale: "fr" as const, sources: SOURCES, retry, onMeta });

  it("une phrase commencée puis prise : retirée de l'écran à l'instant, jamais montrée à moitié avec son mot", () => {
    const gate = new AnswerGate(SOURCES, undefined, meta(false, "drop"));
    const r = screenOf(gate, chars("NOMS: Ariadne\n\nAriadne construit le labyrinthe. Les sources ne disent rien de plus. Ariadne dessine."));
    expect(r.frames.some((f) => /sources/.test(f))).toBe(false);
    // « Les » a été montré, puis retiré dès « sources ».
    expect(r.frames).toContain("Ariadne construit le labyrinthe. Les");
    expect(r.text).toBe("Ariadne construit le labyrinthe. Ariadne dessine.");
    expect(gate.rewritten).toBe(true);
  });

  it("une question : la phrase remplacée par la limite dite naturellement — au même texte final qu'en un bloc", () => {
    const answer = "NOMS: Ariadne\n\nAriadne construit le labyrinthe. Les sources ne disent pas son âge. ";
    const streamed = screenOf(new AnswerGate(SOURCES, undefined, meta(false, "replace")), chars(answer));
    const whole = screenOf(new AnswerGate(SOURCES, undefined, meta(false, "replace")), [answer]);
    expect(streamed.text).toBe(`Ariadne construit le labyrinthe. ${METALESS_LIMIT.fr}`);
    expect(whole.text).toBe(streamed.text);
    expect(streamed.frames.some((f) => /sources/.test(f))).toBe(false);
  });

  it("« D'après les sources, … » : la tête est retenue quelques mots, puis reformulée — jamais montrée telle quelle", () => {
    const r = screenOf(new AnswerGate(SOURCES, undefined, meta(true, "replace")), chars("NOMS: Ariadne\n\nD'après les sources, Ariadne dessine le labyrinthe."));
    expect(r.frames.some((f) => /D'après les/.test(f))).toBe(false);
    expect(r.text).toBe("D'après ce que vous avez vu, Ariadne dessine le labyrinthe.");
  });

  it("avant toute phrase finie : redemander une fois — et l'écran est remis à vide s'il montrait déjà des mots", () => {
    const gate = new AnswerGate(SOURCES, undefined, meta(true, "replace"));
    expect(gate.push("NOMS: —\n\nLes ").release).toEqual(["Les"]);
    const out = gate.push("sources ne donnent pas son âge. ");
    expect(out.reset).toBe("");
    expect(out.retry).toBe(true);
    expect(out.release).toEqual([]);
  });

  it("« Jusqu'ici » : RIEN seul n'est jamais montré, même mot par mot", () => {
    const gate = new AnswerGate(SOURCES, { sentences: 2, words: 60 }, meta(false, "drop"), "RIEN");
    const r = screenOf(gate, chars("NOMS: —\n\nRIEN"));
    expect(r.frames.every((f) => f === "")).toBe(true);
    expect(gate.nothing).toBe(true);
    // « RIEN » suivi d'autre chose n'est pas « rien à dire ».
    const other = new AnswerGate(SOURCES, { sentences: 2, words: 60 }, meta(false, "drop"), "RIEN");
    expect(screenOf(other, chars("NOMS: —\n\nRIEN de neuf pour Ariadne.")).text).toBe("RIEN de neuf pour Ariadne.");
    expect(other.nothing).toBe(false);
  });
});
