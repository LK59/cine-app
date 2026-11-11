import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Sa propre base : ce fichier écrit des scores.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-quiz-"));
});

import { openAnswers, signValue, type SignedResult } from "../../salons/src/seal";
import { openQuizImage } from "@/lib/quiz/imageToken";

const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const KEY = "k".repeat(40);
vi.mock("@/lib/config", () => ({ config: { salons: { key: "k".repeat(40), audience: "tous", url: "http://x" }, app: { sessionSecret: "secret-de-test-0123456789" } } }));
const titlesFor = vi.fn();
vi.mock("@/lib/quiz/candidates", () => ({ quizTitlesFor: (...a: unknown[]) => titlesFor(...a) }));

const film = (n: number) => ({ title: `Film ${n}`, year: 2000, genres: ["Drame"], poster: `https://image.tmdb.org/t/p/w500/${n}.jpg`, backdrop: null, tagline: null, cast: [] });
const post = async (path: "partie" | "resultat", body: unknown) => {
  const mod = path === "partie" ? await import("@/app/api/quiz/partie/route") : await import("@/app/api/quiz/resultat/route");
  const req = { cookies: { get: () => ({ value: "t" }) }, headers: new Headers(), json: async () => body } as unknown as NextRequest;
  const res = await mod.POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const stats = async () => {
  const { GET } = await import("@/app/api/quiz/stats/route");
  return (await (await GET({ cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest)).json()) as { mine: { variant: string; best: number; games: number }[]; board: { name: string; best: number; you: boolean }[] };
};

beforeEach(() => {
  mockVerifySessionFull.mockResolvedValue({ u: "marie", jfUser: "Marie", jfId: "jf-marie", role: "user" });
  titlesFor.mockResolvedValue(Array.from({ length: 20 }, (_, i) => film(i)));
});

/**
 * Les routes de « Devine le film » (DECISIONS.md §146) : une partie seule (réponses rendues, bilan recompté par
 * l'application), une partie à plusieurs (liste des présents signée par le service, réponses scellées pour lui),
 * l'enregistrement des records (une fois par partie et par compte) et les images par jeton.
 */
describe("Devine le film, côté application", () => {
  it("seul : une partie, puis un bilan recompté par l'application ; rendu une seule fois", async () => {
    const { body } = await post("partie", { variant: "affiches" });
    expect(body.available).toBe(true);
    const game = body.game as { id: string; rounds: { image: string }[] };
    const answers = body.answers as number[];
    expect(game.rounds[0].image).toMatch(/^\/api\/quiz\/image\?t=/);
    expect(openQuizImage(new URLSearchParams(game.rounds[0].image.split("?")[1]).get("t"))).toMatch(/^https:\/\/image\.tmdb\.org\//);
    // Le client annonce n'importe quoi : seules ses réponses comptent.
    const picks = answers.map((a, i) => ({ choice: i < 3 ? a : (a + 1) % 4, at: 0 }));
    const first = await post("resultat", { gameId: game.id, picks, score: 999_999 });
    expect(first.body).toMatchObject({ recorded: 1, score: 1000 + 1100 + 1200 });
    expect((await post("resultat", { gameId: game.id, picks })).body.recorded).toBe(0);
    const s = await stats();
    expect(s.mine).toEqual([expect.objectContaining({ variant: "affiches", best: 3300, games: 1 })]);
    expect(s.board[0]).toMatchObject({ name: "Marie", best: 3300, you: true });
  });

  it("seul, la partie d'un autre compte : rien n'est enregistré", async () => {
    const { body } = await post("partie", {});
    mockVerifySessionFull.mockResolvedValue({ u: "paul", jfUser: "Paul", jfId: "jf-paul", role: "user" });
    expect((await post("resultat", { gameId: (body.game as { id: string }).id, picks: [] })).body.recorded).toBe(0);
  });

  it("à plusieurs : les titres de tous les présents, les réponses scellées pour le service — et lui seul les ouvre", async () => {
    const roster = signValue({ room: "ABCDEF", subs: ["jf-marie", "jf-paul"], exp: Date.now() + 60_000 }, KEY, "roster");
    const { body } = await post("partie", { variant: "mixte", roster });
    expect(titlesFor).toHaveBeenLastCalledWith(["jf-marie", "jf-paul"], expect.anything());
    expect(body.answers).toBeUndefined();
    const opened = openAnswers(body.sealed, KEY)!;
    expect(opened.gameId).toBe((body.game as { id: string }).id);
    expect(opened.answers).toHaveLength((body.game as { rounds: unknown[] }).rounds.length);
  });

  it("une liste des présents fausse, d'un autre usage, ou sans l'appelant : pas de partie à plusieurs", async () => {
    for (const roster of [
      "v1.faux.faux",
      signValue({ room: "R", subs: ["jf-marie"], exp: Date.now() + 60_000 }, KEY, "result"),
      signValue({ room: "R", subs: ["jf-paul"], exp: Date.now() + 60_000 }, KEY, "roster"),
      signValue({ room: "R", subs: ["jf-marie"], exp: Date.now() - 1 }, KEY, "roster"),
    ]) {
      expect((await post("partie", { roster })).body).toEqual({ available: false, reason: "roster" });
    }
  });

  it("le bilan signé par le service : chaque compte une fois, quel que soit le joueur qui le rend ; une signature fausse ne compte pas", async () => {
    const result: SignedResult = {
      gameId: "q-salon-1",
      variant: "rapide",
      room: "ABCDEF",
      at: Date.now(),
      players: [
        { sub: "jf-marie", name: "Marie", score: 5200, correct: 6, total: 10, bestStreak: 4 },
        { sub: "jf-paul", name: "Paul", score: 4100, correct: 5, total: 10, bestStreak: 2 },
      ],
    };
    const signed = signValue(result, KEY, "result");
    expect((await post("resultat", { result: signValue(result, KEY, "roster") })).body.recorded).toBe(0);
    expect((await post("resultat", { result: signed })).body.recorded).toBe(2);
    mockVerifySessionFull.mockResolvedValue({ u: "paul", jfUser: "Paul", jfId: "jf-paul", role: "user" });
    expect((await post("resultat", { result: signed })).body.recorded).toBe(0);
    const s = await stats();
    expect(s.mine.find((m) => m.variant === "rapide")).toMatchObject({ best: 4100, games: 1 });
  });

  it("un lien de partage : ni partie ni score", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "lien", role: "share", sh: "x" });
    expect((await post("partie", {})).body).toEqual({ available: false, reason: "share" });
    expect((await post("resultat", { gameId: "x", picks: [] })).body.recorded).toBe(0);
  });

  it("une bibliothèque commune trop petite : 200 et la raison", async () => {
    titlesFor.mockResolvedValue([film(1), film(2)]);
    expect((await post("partie", {})).body).toEqual({ available: false, reason: "library" });
  });
});

describe("les images de la partie", () => {
  it("un jeton illisible ou trafiqué : 204, jamais un 404", async () => {
    const { GET } = await import("@/app/api/quiz/image/route");
    for (const t of ["", "abc", "AAAAAAAAAAAAAAAA.BBBB"]) {
      const res = await GET({ nextUrl: new URL(`http://x/api/quiz/image?t=${t}`) } as unknown as NextRequest);
      expect(res.status).toBe(204);
    }
  });
});
