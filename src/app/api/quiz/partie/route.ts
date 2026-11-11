import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { localeOf } from "@/lib/i18n";
import { logError } from "@/lib/logger";
import { buildQuiz } from "@/lib/quiz/build";
import { quizTitlesFor } from "@/lib/quiz/candidates";
import { quizImageUrl } from "@/lib/quiz/imageToken";
import { rememberSoloGame } from "@/lib/quiz/soloGames";
import { QUIZ_VARIANTS, type QuizVariant } from "../../../../../salons/src/quiz";
import { sealAnswers, verifyValue, type Roster } from "../../../../../salons/src/seal";

export const dynamic = "force-dynamic";

/** Le compte d'une session tel que le service des salons le connaît (le `sub` du laissez-passer). */
const subOf = (session: { jfId?: string; u: string }) => session.jfId ?? `local:${session.u}`;

/**
 * Prépare une partie de « Devine le film » (DECISIONS.md §146).
 *
 * - **Seul** (sans `roster`) : les films que ce compte peut voir ; les réponses partent avec la partie (le chalet fait
 *   tourner le moteur), et l'application les garde pour recompter le bilan (`soloGames.ts`).
 * - **À plusieurs** (`roster`, la liste des présents signée par le service) : les films que **tous** peuvent voir ; les
 *   réponses sont scellées pour le service (`sealAnswers`), que le joueur qui lance transporte sans les lire.
 *
 * Toujours 200 pour une session : `{ available: false, reason }` quand une partie n'est pas possible (bibliothèque
 * commune trop petite, liste des présents refusée, lien de partage) — jamais un 4xx que le pare-feu compterait.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const headers = { "Cache-Control": "private, no-store" };
  if (session.role === "share") return NextResponse.json({ available: false, reason: "share" }, { headers });
  const body = (await req.json().catch(() => null)) as { variant?: unknown; roster?: unknown } | null;
  const variant: QuizVariant = QUIZ_VARIANTS.includes(body?.variant as QuizVariant) ? (body!.variant as QuizVariant) : "mixte";
  const me = subOf(session);

  let subs = [me];
  let sealedFor: string | null = null;
  if (body?.roster !== undefined) {
    const key = config.salons.key;
    const roster = key.length >= 32 ? verifyValue<Roster>(body.roster, key, "roster") : null;
    // Une liste signée, encore valable, où l'appelant figure : sinon pas de partie à plusieurs.
    if (!roster || roster.exp <= Date.now() || !Array.isArray(roster.subs) || !roster.subs.includes(me) || roster.subs.length > 16) {
      return NextResponse.json({ available: false, reason: "roster" }, { headers });
    }
    subs = roster.subs.filter((s): s is string => typeof s === "string").slice(0, 16);
    sealedFor = key;
  }

  try {
    const titles = await quizTitlesFor(subs, localeOf(req));
    const quiz = buildQuiz(titles, variant, (src) => quizImageUrl(src));
    if (!quiz) return NextResponse.json({ available: false, reason: "library" }, { headers });
    const game = { id: quiz.id, variant: quiz.variant, rounds: quiz.rounds };
    if (sealedFor) {
      return NextResponse.json({ available: true, game, sealed: sealAnswers({ gameId: quiz.id, answers: quiz.answers, exp: Date.now() + 60 * 60_000 }, sealedFor) }, { headers });
    }
    rememberSoloGame(quiz.id, me, quiz.variant, quiz.answers);
    return NextResponse.json({ available: true, game, answers: quiz.answers }, { headers });
  } catch (error) {
    logError("quiz/partie", error, { subs: subs.length });
    return NextResponse.json({ available: false, reason: "error" }, { headers });
  }
}
