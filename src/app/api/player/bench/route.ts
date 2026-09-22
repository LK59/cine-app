import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { LOG_DIR, appendJsonLine, logGenerations } from "@/lib/logFile";
import { readLogLines } from "@/lib/playerBench/plan";

/**
 * Ce que le banc d'essai a trouvé, écrit à côté du journal du lecteur (`data/logs/bench.log`).
 *
 * Un film par ligne, envoyé dès qu'il est fini — un banc interrompu garde ce qu'il avait déjà
 * mesuré —, puis une ligne `run` qui clôt la série. Réservé à l'administrateur, lecture comprise :
 * les lignes nomment des films regardés.
 */

const BENCH_LOG = () => path.join(LOG_DIR, "bench.log");

/** Écrite et relue ici seulement : les deux côtés doivent parler du même nombre d'archives. */
const BENCH_LOG_KEEP = 2;

/** Un film et sa trace tiennent en quelques dizaines de kilo-octets ; au-delà, ce n'est pas le banc. */
const MAX_BODY = 400_000;

async function admin(req: NextRequest) {
  if (!config.player.enabled) return null;
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  return session?.role === "admin" ? session : null;
}

export async function POST(req: NextRequest) {
  const session = await admin(req);
  if (!session) return new NextResponse(null, { status: 403 });
  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: "Rapport trop long" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Rapport illisible" }, { status: 400 });
  }
  if ((body.kind !== "item" && body.kind !== "run") || typeof body.runId !== "string") {
    return NextResponse.json({ error: "Rapport illisible" }, { status: 400 });
  }
  appendJsonLine(
    BENCH_LOG(),
    {
      timestamp: new Date().toISOString(),
      user: session.u,
      agent: req.headers.get("user-agent") ?? "?",
      ...body,
    },
    { keep: BENCH_LOG_KEEP }
  );
  return NextResponse.json({ ok: true });
}

export interface BenchRunSummary {
  runId: string;
  startedAt: string;
  agent: string;
  depth: string;
  finished: boolean;
  elapsedMs: number;
  items: { title: string; verdict: string; fails: number; warns: number }[];
}

/** Les dix dernières séries, les plus récentes d'abord. */
export async function GET(req: NextRequest) {
  if (!(await admin(req))) return new NextResponse(null, { status: 403 });
  const runs = new Map<string, BenchRunSummary>();
  for (const line of readLogLines(logGenerations(BENCH_LOG(), BENCH_LOG_KEEP)) as Record<string, unknown>[]) {
    const runId = String(line.runId ?? "");
    if (!runId) continue;
    let run = runs.get(runId);
    if (!run) {
      run = { runId, startedAt: String(line.timestamp ?? ""), agent: String(line.agent ?? "?"), depth: "?", finished: false, elapsedMs: 0, items: [] };
      runs.set(runId, run);
    }
    if (line.kind === "item") {
      const checks = Array.isArray(line.checks) ? (line.checks as { verdict?: string }[]) : [];
      run.items.push({
        title: String(line.title ?? "?"),
        verdict: String(line.verdict ?? "?"),
        fails: checks.filter((c) => c.verdict === "fail").length,
        warns: checks.filter((c) => c.verdict === "warn").length,
      });
    } else if (line.kind === "run") {
      run.finished = true;
      run.depth = String(line.depth ?? "?");
      run.elapsedMs = Number(line.elapsedMs ?? 0);
    }
  }
  return NextResponse.json({ runs: [...runs.values()].reverse().slice(0, 10) });
}
