import { NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { playingSessionsOf } from "@/lib/activity/presence";
import { shareIsActive, sharesDb } from "@/lib/share/store";
import { itemInShare } from "@/lib/share/scope";

/**
 * Les vérifications qu'une route fait elle-même pour une session de partage (DECISIONS.md §112) —
 * celles que le proxy ne peut pas faire : l'élément est dans le corps, ou il faut compter les
 * lectures. Pour toute autre session, elles ne font rien et ne demandent rien : les comptes du
 * foyer ne passent par aucun chemin nouveau.
 */

/** `null` : la requête reste dans le titre du lien (ou ce n'est pas une session de partage). */
export async function shareRefusal(session: Pick<SessionPayload, "role" | "sh"> | null | undefined, itemId: unknown): Promise<NextResponse | null> {
  if (session?.role !== "share") return null;
  const share = sharesDb.get(session.sh ?? "");
  if (!shareIsActive(share) || typeof itemId !== "string" || !(await itemInShare(share, itemId.toLowerCase()))) {
    return NextResponse.json({ error: "Ce lien ne donne accès qu'au titre partagé", code: "share-scope" }, { status: 403 });
  }
  return null;
}

/**
 * Trois lectures en même temps par lien : à l'ouverture (fiche du lecteur natif, négociation du
 * lecteur serveur), les autres appareils du lien qui jouent — leur battement de lecture, celui que
 * la présence garde, a moins de deux minutes et demie. Celui qui demande ne se compte pas : une
 * reprise ou un épisode suivant sur le même appareil passe toujours.
 */
export function shareStreamRefusal(session: Pick<SessionPayload, "role" | "sh" | "jti" | "jfUser" | "u"> | null | undefined, now = Date.now()): NextResponse | null {
  if (session?.role !== "share") return null;
  const share = sharesDb.get(session.sh ?? "");
  if (!share) return NextResponse.json({ error: "Lien de partage inconnu" }, { status: 403 });
  const others = playingSessionsOf(session.jfUser ?? session.u, now).filter((jti) => jti !== session.jti);
  if (others.length >= share.maxStreams) {
    return NextResponse.json(
      { error: `Ce lien est déjà lu sur ${others.length} appareils en même temps`, code: "share-streams", max: share.maxStreams },
      { status: 429 }
    );
  }
  return null;
}
