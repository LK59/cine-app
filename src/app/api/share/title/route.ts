import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { localeOf } from "@/lib/i18n";
import { upstreamFailure } from "@/lib/upstreamResponse";
import { playingSessionsOf } from "@/lib/activity/presence";
import { shareIsActive, sharesDb, type ShareKind } from "@/lib/share/store";
import { shareTitleEntry } from "@/lib/share/title";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

export const dynamic = "force-dynamic";

export type ShareTitlePayload = {
  /** La fin du lien, en millisecondes — « Disponible jusqu'au … ». */
  expiresAt: number;
  maxStreams: number;
  /**
   * Les autres appareils du lien qui jouent en ce moment — celui qui demande ne se compte pas, comme
   * dans `shareStreamRefusal`, qui refusera la lecture au-delà de `maxStreams`. La fiche le dit avant
   * l'appui plutôt que de laisser le lecteur échouer.
   */
  playingElsewhere: number;
} & ({ kind: "movie"; item: CinemaMovie } | { kind: "series"; item: CinemaSeries });

/**
 * Le titre d'un lien de partage, pour sa page (DECISIONS.md §112) : la carte que le catalogue sert pour
 * lui, et rien d'autre — l'invité n'a pas accès au catalogue (`share/gate.ts`), et cette route est sa
 * seule façon de connaître ce qu'il peut regarder.
 *
 * Réservée aux sessions de partage : un compte du foyer a le catalogue, il n'a rien à faire ici, et
 * une réponse qui dépend d'un lien ne doit pas exister pour qui n'en a pas.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "share") {
    return NextResponse.json({ error: "Réservé à un lien de partage", code: "share-scope" }, { status: 403 });
  }
  const share = sharesDb.get(session.sh ?? "");
  if (!shareIsActive(share)) {
    return NextResponse.json({ error: "Lien de partage inconnu", code: "share-scope" }, { status: 403 });
  }
  try {
    const item = await shareTitleEntry(share, localeOf(req));
    if (!item) return NextResponse.json({ error: "Titre introuvable", code: "title_not_found" }, { status: 404 });
    // La même clé que la garde des lectures (`shareStreamRefusal`) : le compte Jellyfin du lien.
    const playingElsewhere = playingSessionsOf(session.jfUser ?? session.u).filter((jti) => jti !== session.jti).length;
    const payload = {
      kind: share.kind as ShareKind,
      item,
      expiresAt: share.expiresAt,
      maxStreams: share.maxStreams,
      playingElsewhere,
    } as ShareTitlePayload;
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return upstreamFailure(err, "share-title");
  }
}
