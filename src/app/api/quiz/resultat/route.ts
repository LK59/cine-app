import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { quizDb } from "@/lib/db";
import { settleSoloGame } from "@/lib/quiz/soloGames";
import { verifyValue, type SignedResult } from "../../../../../salons/src/seal";

export const dynamic = "force-dynamic";

const subOf = (session: { jfId?: string; u: string }) => session.jfId ?? `local:${session.u}`;

/**
 * Le bilan d'une partie de « Devine le film », pour les records (DECISIONS.md §146).
 *
 * - **À plusieurs** (`{ result }`) : le bilan signé par le service. N'importe quel joueur peut le rendre ; chaque
 *   compte n'est enregistré qu'une fois par partie.
 * - **Seul** (`{ gameId, picks }`) : les réponses données ; l'application recompte les points (`soloGames.ts`).
 *
 * Toujours 200 : `{ recorded }` dit combien de scores sont neufs.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (session.role === "share") return NextResponse.json({ recorded: 0 });
  const body = (await req.json().catch(() => null)) as { result?: unknown; gameId?: unknown; picks?: unknown } | null;
  const me = subOf(session);
  const name = (session.jfUser ?? session.u).slice(0, 64);

  if (body?.result !== undefined) {
    const key = config.salons.key;
    const result = key.length >= 32 ? verifyValue<SignedResult>(body.result, key, "result") : null;
    if (!result || !Array.isArray(result.players) || !result.players.some((p) => p.sub === me)) return NextResponse.json({ recorded: 0 });
    const players = result.players.length;
    const recorded = quizDb.record(
      result.players.map((p) => ({
        gameId: result.gameId,
        account: p.sub,
        name: String(p.name).slice(0, 64),
        mode: "salon" as const,
        variant: String(result.variant).slice(0, 16),
        score: Math.max(0, Math.round(p.score)),
        correct: Math.max(0, Math.round(p.correct)),
        total: Math.max(0, Math.round(p.total)),
        bestStreak: Math.max(0, Math.round(p.bestStreak)),
        players,
        at: result.at,
      }))
    );
    return NextResponse.json({ recorded });
  }

  if (typeof body?.gameId === "string") {
    const settled = settleSoloGame(body.gameId, me, body.picks);
    if (!settled) return NextResponse.json({ recorded: 0 });
    const recorded = quizDb.record([{ gameId: body.gameId, account: me, name, mode: "solo", ...settled, players: 1, at: Date.now() }]);
    return NextResponse.json({ recorded, score: settled.score });
  }
  return NextResponse.json({ recorded: 0 });
}
